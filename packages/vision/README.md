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
- `sprite.ts` — `dHash` / `SpriteHashMatcher`: perceptual-hash sprite matching for
  the OPPONENT's team (icons, no text → OCR can't help).
- `regions.ts` `CHAMPIONS_TEAM_PREVIEW` — the "Select 4" layout, **calibrated from
  real YouTube footage** (your six = name/item OCR on the left; opponent six =
  sprite match on the right edge x≈0.83–1.0; opponent name OCR).

**Validated on real footage:** screen-grab → decode → crop → tesseract OCR read
your team ("Staraptor" @1.00, "Grimmsnarl", "Sinistcha") + items; the opponent's
six were located + identified by sight (Azumarill/Staraptor/Arcanine/Florges/
Sylveon/Gholdengo), confirming the sprite-match requirement.

**Stubbed — needs the capture dongle + continuous footage to finish:**
- `frameGrabber.ts` `UvcFrameGrabber` — real HDMI capture. **Pre-flight: confirm
  Switch 2 gameplay isn't HDCP-protected** (almost certainly fine).
- `ocr.ts` `TesseractOcrReader` — consolidate the proven OCR (jimp crop+greyscale+
  upscale → tesseract); per-region whitelists.
- `sprite.ts` `loadSpriteRefs` — generate `data/sprite-hashes.json` (dHash each
  legal species' icon from `@pkmn/img` / the dex sprite sheet).
- `regions.ts` CHAMPIONS_TEAM_PREVIEW px + a battle-`RegionMap` (HP bars/names/log)
  — refine against dongle frames (game fills the frame; no browser chrome).
- `stateMachine.ts` — turn-assembly transitions need live (uncut) frame timing.

## Next (when hardware lands)
1. Generate `data/sprite-hashes.json` → wire `loadSpriteRefs`; opponent team reads.
2. Consolidate `TesseractOcrReader`; lock the team-preview px against a clean frame.
3. Implement `UvcFrameGrabber` (~2-5 fps RGBA); add a battle `RegionMap`.
4. Flesh out `BattleStateMachine.feed` (text→actions, HP-diff→damage, debounce).
5. TUI confirm/edit surface consuming `TurnProposal`.
