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

**Shipped 2026-06-20 (hardware landed):**
- Capture: `scripts/serve.ts` (HDMI device owner + browser tap, Guermok dongle 1080p)
  + `scripts/record.ts` (frame archiver). `scripts/youtube.ts` adds a **dongle-free**
  frame source from any match VOD.
- Banner read: `scripts/read-battle.ts` (white-gate OCR) → `bannerParse.ts` (full event
  grammar) → a coherent timeline, validated on a real VOD.
- HP-number read: `scripts/read-hp.ts` + `hpRead.ts` — opp % and my `cur/max`, validated
  vs ground truth (the o2 low-value misread chased + fixed).
- `regions.ts` `CHAMPIONS_DOUBLES_PLACEHOLDER` calibrated; `stateMachine.ts` live loop
  scaffolded; TUI `VisionProposalPanel` (`/vision`) ratifies a proposed turn.

**Remaining:** consolidate the proven OCR into `ocr.ts` `TesseractOcrReader`; point
`visionSource.readFrame` at the HP *number* (not the bar); settle-gating + a self-damage
reconciler; grow `data/sprite-refs.json` toward 208; `UvcFrameGrabber` for live grab
(capture works via `serve.ts` today).

## Plan

Full roadmap + file-level grounding: [`docs/notes/vision-plan.md`](../../docs/notes/vision-plan.md).
