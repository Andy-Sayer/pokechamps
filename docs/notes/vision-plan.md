# Vision adapter — live turn-read plan

**Goal:** read the Switch 2 game screen — live HDMI capture **or** a YouTube VOD —
and emit the canonical turn-log lines the engine already consumes, automatically.
Vision **proposes**, you **ratify**. Pure input adapter: parser / inference / search
unchanged. (Package overview: [`packages/vision/README.md`](../../packages/vision/README.md).)

**Scaffolded earlier; capture + full banner grammar + HP-number OCR landed
2026-06-20.** Work on `main`.

## TL;DR

Every stage now exists as a piece and the **read half is validated end-to-end on a
real VOD** (JJOR64 ranked match): `youtube.ts` → frames → banner OCR → `parseBanner`
(full grammar) → tracker/state-machine → `TurnProposal`, plus HP-number OCR read
against ground truth. What's left is **integration, not research**: consolidate the
two proven OCR pipelines into the production `OcrReader`, point `readFrame` at the
number-based HP read with settle-gating, then add the self-damage reconciler. The
dongle is no longer on the critical path — a YouTube VOD is a full dongle-free corpus.

## What exists today (grounding)

| Piece | File | State |
|---|---|---|
| HDMI capture (device owner + browser tap) | `scripts/serve.ts` | ✅ live (Guermok dongle, 1080p) |
| Frame-sequence archiver | `scripts/record.ts` | ✅ |
| **YouTube VOD → frames** (dongle-free source) | `scripts/youtube.ts` | ✅ validated on a real match |
| Banner OCR pass (white-gate binarize + dedup) | `scripts/read-battle.ts` | ✅ reads a coherent timeline |
| Banner → event grammar | `src/bannerParse.ts` | ✅ move/mega/faint/switch (incl. recall)/status/protect/ability/residual/weather/effectiveness/confusion-hit/hp-loss |
| HP-number OCR (opp %, mine cur/max) | `scripts/read-hp.ts`, `src/hpRead.ts` | ✅ validated vs ground truth (o2 low-value fixed) |
| Battle `RegionMap` (banner, plates, HP boxes) | `src/regions.ts` `CHAMPIONS_DOUBLES_PLACEHOLDER` | ✅ calibrated on a 1080p match |
| Roster + turn segmentation tracker | `src/track.ts`, `src/assemble.ts` | ✅ unit-tested |
| Live loop (frames → TurnProposals) | `src/stateMachine.ts`, `src/visionSource.ts` `runVision` | ⚠️ scaffolded; HP from the **bar**, not the number |
| Production OCR reader | `src/ocr.ts` `TesseractOcrReader` | ⛔ stubbed |
| Live HDMI grabber | `src/frameGrabber.ts` `UvcFrameGrabber` | ⛔ stubbed (capture works via `serve.ts` today) |
| TUI ratify surface | `tui` `VisionProposalPanel` (`/vision`) | ✅ wired into BattleScreen |
| Opponent team-preview sprite match | `src/colorHist.ts`, `data/sprite-refs.json` | ✅ method proven; 6-species seed (grow to 208) |

```
Switch 2 / VOD ──▶ frames ──▶ readFrame(RegionMap)         ← banner OCR + HP-number OCR
   ──▶ FrameRead ──▶ BattleStateMachine.feed ──▶ TurnProposal
   ──▶ [ratify/edit in TUI] ──▶ existing parser / engine / inference
```

## Plan (prioritized)

**P1 — Consolidate the proven OCR into `ocr.ts` `TesseractOcrReader`.** Two configs,
both already proven in the scripts: (a) **banner band** — white-gate binarize
(bright + low-saturation), 3× scale (`read-battle.ts`); (b) **HP digits** — white-
isolate, **8px quiet-zone border**, PSM 8 for the opp percent, PSM 7 for my `cur/max`,
`%` kept in the whitelist (`read-hp.ts`). Per-region config so one reader serves both.

**P2 — Point `readFrame` at the HP *number*, not the bar.** `visionSource.readFrame`
still calls `readHpFraction` (bar pixels, which carry an overlaid number); switch opp
to `readOpponentHpPercents` and read `myHpText` cur/max → fraction via the known max.
The code note already flags this ("wire that in here once `deps.ocr` can OCR a
preprocessed pixel buffer") — P1 unblocks it.

**P3 — Settle-gating + multi-frame consensus.** The HUD animates; HP reads jitter on
unsettled frames (`177↔117`, blanks). Gate HP reads on a stable frame and take the
consensus value across the banner's persistence window. Tune `stateMachine` `gapFrames`
/ `clearFrames` on a live stream.

**P4 — Self-damage reconciler.** `hpLoss` and `confusionHit` are self-inflicted HP
loss; subtract them from a slot's turn delta so opponent-dealt damage isn't overstated
(the inference signal). Attribute the sideless `confusionHit` to the active confused
slot. (The events are already parsed for exactly this.)

**P5 — Region robustness across VOD sources.** Calibration transfers to clean 1080p
gameplay, but facecams / stream overlays shift boxes. Add a one-frame sanity check
(`find-banner.ts`) + a per-source region override; nudge the `oppHpText[1]` (o2) box
for low-value robustness.

**P6 — Remaining banner grammar.** Harvest more UNK lines (`DEBUG_UNK=1`): Wide
Guard / Quick Guard, the status-infliction variants not yet seen, post-game lines.

**P7 — Opponent team-preview read.** Grow `data/sprite-refs.json` toward 208 via
`bootstrap-refs.ts` (colour-hist; the in-battle text reveal names preview slots).

**P8 — Grabbers.** `FileFrameGrabber` over an extracted frame dir drives `runVision`
offline against a VOD — the dongle-free **integration** test for P1–P4. `UvcFrameGrabber`
for live (capture already works through `serve.ts`).

**P9 (later, user request) — Switch 2 GameShare as a frame source.** Make the read
pipeline work when someone **GameShares** their Switch 2 game to the user — i.e. the
user is watching a *shared/streamed* view, not capturing their own HDMI. Treat it as
another swappable frame source alongside the dongle + `youtube.ts`: grab the shared
view and feed the same `readFrame` → state-machine path (the parser/engine never
change). The crux is **robustness**, not new architecture: a GameShare stream is
compressed/downscaled and likely carries extra chrome — a GameShare banner, per-player
labels, a guest cursor — and possibly a different resolution / letterbox. So it needs
(a) a per-source `RegionMap` override + the `find-banner.ts` one-frame sanity check
(shared with P5), and (b) OCR + colour-hist tolerance to compression artifacts.
**MEASURED 2026-06-28 (delivery path confirmed):** the user joins via GameShare and
captures the composite on their own Switch HDMI through the dongle (`serve.ts`). The
shared screen is an **exact 5/6 (0.8333) CENTRED inset** of the 1920×1080 capture —
a **1600×900** region with symmetric **160px L/R + 90px T/B** borders (found via
`scripts/share-border.ts` luma profile on a live frame). So the fix is a pure
scale+offset, NOT a re-calibration: **`insetRegionMap(map, GAMESHARE_INSET)`** in
`regions.ts` remaps any full-frame `RegionMap` into the inset (tested,
`gameshare-inset.test.ts`). **Remaining:** (a) wire a `gameshare` flag into
`runVision`/`visionSource` that wraps the active map via `insetRegionMap` when the
share is on; (b) the inset shrinks 1080p→900p so OCR runs on smaller text — verify
HP/banner OCR still reads at inset scale (may need a larger upscale factor); (c) note
the battle layout itself is still **doubles**-calibrated — a 1v1/singles game needs
its own `RegionMap` regardless of GameShare.

## Validation loop

`youtube.ts` is the regression harness: pull any Champions VOD → frames →
`read-battle` (events) + `read-hp` (HP). Run it after each of P1–P4. `fixtures/` is
gitignored and large — regenerate frames from the URL on each machine
([[project_portable_vision_workflow]] mirrors this).

## Known gaps / notes

- **HP OCR config is the o2 fix** (quiet-zone border + per-type PSM + `%` whitelist) —
  reuse verbatim in P1; it lives in `read-hp.ts` today because `readOpponentHpPercents`
  takes an *injected* OCR fn and there's no live consumer yet.
- HP unit convention: opp is a PERCENT, mine an ABSOLUTE `cur/max` — see `regions.ts`.
- `eng.traineddata` is gitignored; `read-battle` auto-downloads it on a fresh clone.
