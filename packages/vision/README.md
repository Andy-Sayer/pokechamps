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
- `hpBar.ts` — `readHpFraction`: HP bar crop → fill fraction (the only unknown is
  *where* the bar is, not how to read it).
- `fuzzyMatch.ts` — `matchSpecies` / `matchMove`: noisy OCR → legal species/move
  (the tiny candidate set is the accuracy win).
- `turnLog.ts` — `emitTurnLog`: TurnObservation → canonical lines. **This is the
  contract boundary**; it encodes the grammar exactly.
- `types.ts`, `regions.ts` (`toPixels`), `visionSource.ts` (`cropRegion`, `readFrame`).

**Stubbed — needs a capture dongle + real screenshots to finish:**
- `frameGrabber.ts` `UvcFrameGrabber` — real HDMI capture. **Pre-flight: confirm
  Switch 2 gameplay isn't HDCP-protected** (almost certainly fine).
- `ocr.ts` `TesseractOcrReader` — `tesseract.js` wiring + per-region tuning.
- `regions.ts` `CHAMPIONS_DOUBLES_PLACEHOLDER` — coordinates are GUESSES;
  **calibrate from a real 1080p screenshot** (the switch-day work).
- `stateMachine.ts` — turn-assembly transitions need live frame timing to tune.

## Next (when hardware lands)
1. Drop a 1080p Champions doubles screenshot in `fixtures/`, calibrate `regions.ts`.
2. Wire `tesseract.js` in `ocr.ts`; tune page-seg + whitelists on real frames.
3. Implement `UvcFrameGrabber` against the dongle; verify ~2-5 fps RGBA frames.
4. Flesh out `BattleStateMachine.feed` (text→actions, HP-diff→damage, debounce).
5. Add the TUI confirm/edit surface that consumes `TurnProposal`.
