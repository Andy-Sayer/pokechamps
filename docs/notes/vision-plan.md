# Vision adapter — live turn-read plan

**Goal:** read the Switch 2 game screen — live HDMI capture **or** a YouTube VOD —
and emit the canonical turn-log lines the engine already consumes, automatically.
Vision **proposes**, you **ratify**. Pure input adapter: parser / inference / search
unchanged. (Package overview: [`packages/vision/README.md`](../../packages/vision/README.md).)

**Status 2026-07-24: the read pipeline is BUILT and validated end-to-end on a real
ranked match.** The original P1–P8 build-out is done or superseded; what remains is
**live shakeout + coverage grind**, not construction. 162 vision tests green.

```
Switch 2 / VOD ──▶ frames ──▶ readFrame(RegionMap)         ← banner OCR + HP-number OCR
   ──▶ FrameRead ──▶ BattleStateMachine.feed ──▶ TurnProposal
   ──▶ [ratify/edit in TUI] ──▶ existing parser / engine / inference
```

## The live loop as it actually runs

1. `scripts/serve.ts` owns the dongle and writes a ~4fps `fixtures/live/latest.png` tap
   (self-healing: respawn + stall watchdog). Everything downstream only *reads* the tap.
2. The TUI's shared watcher singleton (`tui/src/ui/watcher.ts`) spawns
   `scripts/read-live.ts`, which drives `runVision` → `TurnProposal` JSON on stdout.
   **Ctrl+W** toggles it globally (works from the menu onward, so the watcher spans
   team-select → battle); it auto-respawns on an unexpected child exit.
   **Default is the GameShare inset** — pass `--full` for a direct 1080p feed.
3. `OpponentInput` auto-reads the team-preview screen while the watcher is on (polling
   until the panel appears), prefilling all six slots with per-slot confidence.
   **Ctrl+R** is the one-off snapshot read.
4. `VisionProposalPanel` shows the turn building live (yellow "⏳ reading") and
   finalizes to cyan; accepting a finalized turn **auto-finalizes** the engine turn —
   no manual `/next`.

**Keys:** Ctrl+W = global watcher toggle · Ctrl+R = one-off opponent snapshot read ·
`/watch` / `/watch full` = explicit inset vs full-frame · Ctrl+D = confirm the six.

## What exists today (grounding)

| Piece | File | State |
|---|---|---|
| HDMI capture (device owner + browser tap) | `scripts/serve.ts` | ✅ live (Guermok dongle, 1080p), self-healing |
| Frame-sequence archiver | `scripts/record.ts` | ✅ |
| **YouTube VOD → frames** (dongle-free source) | `scripts/youtube.ts` | ✅ the regression corpus |
| Banner OCR pass (white-gate binarize + dedup) | `scripts/read-battle.ts` | ✅ |
| Banner → event grammar | `src/bannerParse.ts` | ✅ move/mega/faint/switch/status/protect/ability/residual/weather/effectiveness/confusion-hit/hp-loss/crit/miss/drowsy/end |
| HP-number OCR (opp %, mine cur/max) | `src/hpRead.ts`, `scripts/read-hp.ts` | ✅ validated vs ground truth |
| Battle `RegionMap` + GameShare inset | `src/regions.ts` | ✅ `CHAMPIONS_DOUBLES_PLACEHOLDER`, `insetRegionMap` |
| Roster + turn segmentation | `src/track.ts`, `src/assemble.ts` | ✅ + live-trace regression suite |
| Live loop (frames → TurnProposals) | `src/stateMachine.ts`, `src/visionSource.ts` | ✅ HP from the **number**, plate-gated |
| Production OCR reader | `src/ocr.ts` `TesseractOcrReader` | ✅ per-region `text`/`digits` configs, `reset()` recovery |
| Occupancy reconciler | `src/assemble.ts` + `tui/ui/occupancyReconcile.ts` | ✅ nameplate truth on every proposal |
| Opponent preview sprite match | `src/colorHist.ts`, `src/oppTeamRead.ts` | ✅ layout-auto-detecting; 90 species covered |
| Team-summary importer (my six) | `src/teamSummary.ts`, `scripts/read-team.ts` | ✅ both pages → verified `PokemonSet[]` |
| Sheet-harvest routine | `scripts/harvest-all-sheets.ts` | ✅ app-owned, runs at TUI startup |
| TUI ratify surface | `tui` `VisionProposalPanel` | ✅ live partials, queued finals, auto-finalize |
| Live HDMI grabber | `src/frameGrabber.ts` `UvcFrameGrabber` | ⛔ still stubbed — `LatestTapGrabber` over `serve.ts` is the shipped path |

## Original plan — closeout

- **P1 Consolidate OCR into `TesseractOcrReader`** ✅ DONE. Two proven configs behind one
  reader: `mode:'text'` (saturation-aware white-isolate, 3× scale) and `mode:'digits'`
  (white-isolate + 8px quiet-zone border + `0123456789/%` whitelist, PSM 8 for the opp
  percent / 7 for my `cur/max`). Plus `reset()` — a hung tesseract `recognize` blocks the
  serialize queue forever, so recovery means dropping the worker AND the queue.
- **P2 Read the HP *number*, not the bar** ✅ DONE. `visionSource.readFrame` reads the opp
  percent and my absolute `cur/max` (`readAbsHpRobust`, multi-scale — the GameShare inset
  shrinks text so the best upscale varies per mon), falling back to the bar fraction only
  when digits don't resolve. Both are **plate-gated**: no nameplate (≥3 letters) → null HP,
  because Champions' in-battle view is cinematic during move *execution* and the plates
  only persist during move *select*. Ungated reads poisoned damage + target inference.
- **P3 Settle-gating + multi-frame consensus** ✅ DONE as the **per-action HP timeline**.
  Every frame's HP read is recorded against how many actions the turn has seen
  (`BattleAssembler.recordHp`); a value is SETTLED once it repeats `settleFrames` (default
  2) consecutive frames, filtering mid-drain animation and lone blips. At `endTurn` each
  move takes the last settled read of its target from ITS OWN window (banner→next-banner,
  cut at the next action hitting that slot), so **two hits into one target each carry their
  own damage**. The same windows drive target inference and **spread detection** (a dex
  `allAdjacentFoes`/`allAdjacent` move whose window shows both foes drop emits
  `> spread > o1:x, o2:y`). No samples → falls back to the turn-final read, exact for
  once-hit targets. **Units mirror the screen**: mine-side emits RAW on-screen HP
  (`m1 > … > 117` from the "117/175" plate), opp-side the bare percent; an explicit `60%`
  only when my digits never resolved. Tune `gapFrames` / `clearFrames` / `settleFrames`
  on a live stream.
- **P4 Self-damage reconciler** ⚠️ **SUPERSEDED IN PART — one real gap left.** The
  per-action windows of P3 removed most of the need (self-inflicted loss lands in its own
  window, not the attacker's), and `hpLoss` was repurposed: after the holder's own
  offensive move it's the **Life Orb tell** → an in-timeline `o2 item Life Orb` reveal
  (which also fires the item-clause ripple), gated so Substitute / Belly Drum / Steel Beam
  can't false-positive. **`confusionHit` is parsed but never consumed by the assembler** —
  a confusion self-hit's HP drop can still be attributed to an opponent's move window.
  That's the remaining P4 work.
- **P5 Region robustness across sources** ⚠️ PARTIAL. `find-banner.ts` is the one-frame
  sanity check and the GameShare inset is auto-detected, but there's still no per-source
  region override for facecam / overlay VODs.
- **P6 Remaining banner grammar** ✅ mostly. Crit, status, weather start/end, miss, drowsy
  (Yawn's only target signal), immunity, residual, end-of-game all landed. Keep harvesting
  UNK lines with `DEBUG_UNK=1` — Wide Guard / Quick Guard and post-game lines are the
  known holes.
- **P7 Opponent team-preview read** ✅ built, ⏳ coverage grinding. See below.
- **P8 Grabbers** ✅ for practical purposes: `FileFrameGrabber` (offline VOD dirs),
  `StaticFrameGrabber`, `LatestTapGrabber` (live, over the `serve.ts` tap).
  `UvcFrameGrabber` stays stubbed — capture through `serve.ts` made it unnecessary.
- **P9 GameShare as a frame source** ✅ DONE. The shared screen is an exact 5/6 (0.8333)
  **centred inset** — 1600×900 with symmetric 160px L/R + 90px T/B borders on a 1920×1080
  capture (measured via `scripts/share-border.ts`). So it's a pure scale+offset, not a
  re-calibration: `insetRegionMap(map, GAMESHARE_INSET)` remaps any full-frame `RegionMap`
  (`gameshare-inset.test.ts`), `read-live.ts` defaults to it (`--full` opts out), and
  `readOppTeamFromFrame` auto-detects the layout per frame. CAVEAT: the preview-read half
  was verified on a *synthetic* inset; the battle layout is still **doubles**-calibrated,
  so a singles game needs its own `RegionMap` regardless.

## What's actually left

1. **Live shakeout.** The occupancy reconciler, the accept→auto-finalize path, and the
   nine review-pass fixes have not yet faced a live ranked match — every prior live test
   found defects that offline replay didn't. This is the top item and it needs a play
   session, not a commit.
2. **`confusionHit` reconciliation** (the P4 remnant above).
3. **Sprite coverage** — 90 species covered. Missing meta: **Annihilape, Corviknight,
   Glimmora, Tsareena**. Regionals are 3/17 (`Raichu-Alola` matters — Mega Raichu X/Y is
   the M-B headline). The app-owned harvest routine grows this automatically from every
   opponent you key manually; the VOD grind covers the rest
   ([`harvested-vods.md`](harvested-vods.md), [`sprite-refs-plan.md`](sprite-refs-plan.md)).
4. **Per-source region overrides** (P5 remnant) — only bites on overlay-heavy VODs.
5. **Banner UNK harvest** (P6 remnant) — Wide/Quick Guard, post-game lines.

## Validation loop

Three harnesses, in increasing fidelity:

- `youtube.ts` — pull any Champions VOD → frames → `read-battle` (events) + `read-hp` (HP).
- **Live-trace replay** — `read-live --debug` writes `fixtures/live-debug/` (`frames.jsonl`
  = every frame's OCR + per-slot reads, `proposals.jsonl` = every emitted turn incl. empty,
  `frames/*.png` on each new real banner). `scripts/_livetrace-replay.ts` re-runs a trace
  through the current pipeline and diffs against ground truth — note the `_`-prefixed
  scripts are **untracked local scratch tools**, so recreate it if it's missing. The
  2026-07-23 ranked match (1857 frames / 16 proposals) is the reference corpus, and its
  defects are pinned permanently in `tests/liveRegressions.test.ts`.
- `npm test -w @pokechamps/vision` — 162 tests.

`fixtures/` is gitignored and large — regenerate frames from the VOD URL on each machine.

## Known gaps / notes

- HP unit convention: opp is a PERCENT, mine an ABSOLUTE `cur/max` — see `regions.ts`. The
  turn-log damage slot is **remaining HP by contract**, not damage dealt
  ([`battle-syntax.md`](battle-syntax.md)) — live values that look wrong usually aren't.
- **Never poll a live reader's files.** The original "stall" was file contention with the
  debug trace's synchronous `appendFileSync` wedging read-live's event loop permanently.
  Debug writes are non-blocking streams now and `--debug` is off by default in the TUI.
- Don't pipe the reader's stderr without draining it — tesseract's per-frame diagnostics
  fill the 64KB pipe buffer in ~1 min and the child blocks mid-write (`stdio: 'ignore'`).
- `eng.traineddata` is gitignored; `read-battle` auto-downloads it on a fresh clone.
- Champions display settings matter: **Battle Names OFF** (kills nicknames at source),
  **Battle Info OFF** (the calibration baseline). Check these first if reads degrade.
