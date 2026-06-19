# @pokechamps/vision

Read the **Switch 2 game screen** (HDMI capture over USB-C) and emit **canonical
turn-log lines** for the existing PokeChamps engine — so battles get logged
automatically instead of by hand.

## The one idea

The vision layer is a pure **input adapter**. It produces the *exact* strings you
already type into BattleScreen (`m1 > Close Combat > o1 > 33`). Everything
downstream — parser, inference, search — is unchanged. Get the turn-log right and
the rest "just works".

```
Switch 2 ──HDMI──▶ USB-C UVC dongle ──▶ FrameGrabber ──▶ readFrame (RegionMap)
   ──▶ FrameRead ──▶ BattleStateMachine ──▶ TurnObservation ──▶ emitTurnLog
   ──▶ TurnProposal ──▶ [confirm/edit in TUI] ──▶ existing parser/engine
```

Vision **proposes**, you **ratify** — same self-verifying flow as typed input.
Deterministic CV (HP-bar pixels + region OCR); any LLM-vision stays an opt-in,
default-off fallback.

## Status (scaffold)

**Built + tested (hardware-independent):**
- `hpBar.ts` — `readHpFraction`: HP bar crop → fill fraction.
- `fuzzyMatch.ts` — `matchSpecies` / `matchMove`: noisy OCR → legal species/move.
- `turnLog.ts` — `emitTurnLog`: TurnObservation → canonical lines (**the contract
  boundary** — encodes the grammar exactly).
- `decode.ts` — `loadFrame` / `FileFrameGrabber`: decode PNG/JPG → RGBA Frame (jimp).
- `colorHist.ts` — `colorHistogram` / `HistogramMatcher` / `loadColorHistRefs`: the
  **validated** OPPONENT-team sprite matcher (icons, no text → OCR can't help). A
  background-masked colour histogram, scored 54/54 under ±8px jitter and 6/6
  cross-frame on real game art (see below). Seed table in `data/sprite-refs.json`.
- `sprite.ts` — `dHash` / `SpriteHashMatcher`: perceptual hash, kept for true
  near-duplicate checks only. **Measured not viable for species ID** — see colorHist.
- `regions.ts` `CHAMPIONS_TEAM_PREVIEW` — the "Select 4" layout. `oppTeam` is
  **verified** on a fullscreen 1080p frame (sprite grid x≈1593–1719, card spacing
  126px); `myTeam` name/item OCR boxes are fullscreen-estimated. `opponentSpriteBoxes()`
  + `CHAMPIONS_OPP_PANEL_BG` feed the matcher.

**Validated on real footage:** screen-grab → decode → crop → tesseract OCR read
your team ("Staraptor" @1.00, "Grimmsnarl", "Sinistcha") + items. The opponent's six
(Azumarill/Staraptor/Arcanine/Florges/Sylveon/Gholdengo) were located + matched: dHash
**failed** cross-art (public icons 18–44/64 apart) AND alignment-fragile on game art
(±6px → 22/64 bit flips); a colour histogram **succeeded** (54/54 jitter, 6/6 frame).

**Stubbed — needs the capture dongle + continuous footage to finish:**
- `frameGrabber.ts` `UvcFrameGrabber` — real HDMI capture. **Pre-flight: confirm
  Switch 2 gameplay isn't HDCP-protected** (almost certainly fine).
- `ocr.ts` `TesseractOcrReader` — consolidate the proven OCR (jimp crop+greyscale+
  upscale → tesseract); per-region whitelists.
- `data/sprite-refs.json` — colour-hist reference table, **seeded with 6** game-art
  species via `scripts/bootstrap-refs.ts <frame.png> <id1,…>`. Grow toward 208 by
  feeding more team-preview frames (preview slots get named by the in-battle text
  reveal). `sprite.ts` `loadSpriteRefs` (dHash) stays stubbed — superseded.
- `regions.ts` a battle-`RegionMap` (HP bars/names/log) — refine against dongle
  frames; `myTeam` OCR boxes need a final nudge on a clean frame.
- `stateMachine.ts` — turn-assembly transitions need live (uncut) frame timing.

## Next (when hardware lands)
1. Opponent team read — primary path: OCR the in-battle text log (proven to read
   cleanly) for the 2–4 mons revealed in-match. Full-6 preview: keep growing
   `data/sprite-refs.json` with `bootstrap-refs.ts` (colour-hist; the 6-species seed
   already matches 54/54 jitter, 6/6 cross-frame).
2. Consolidate `TesseractOcrReader`; lock the team-preview px against a clean frame.
3. Implement `UvcFrameGrabber` (~2-5 fps RGBA); add a battle `RegionMap`.
4. Flesh out `BattleStateMachine.feed` (text→actions, HP-diff→damage, debounce).
5. TUI confirm/edit surface consuming `TurnProposal`.
