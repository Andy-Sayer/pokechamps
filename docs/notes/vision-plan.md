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
   **The frame layout is auto-detected** — your own screen vs a friend's GameShare —
   so neither needs a mode (`/watch full` / `/watch share` force one if ever needed).
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
- **P4 Self-damage reconciler** ✅ DONE (2026-07-24). Two halves. `hpLoss` was repurposed:
  after the holder's own offensive move it's the **Life Orb tell** → an in-timeline
  `o2 item Life Orb` reveal (which also fires the item-clause ripple), gated so Substitute
  / Belly Drum / Steel Beam can't false-positive. `confusionHit` ("It hurt itself in its
  confusion!") is **sideless**, so it's attributed via the confusion line that precedes it,
  and the exclusion is two-layered: **window-scoped** (the open action's window is marked,
  so a real hit on that mon in another window still counts) plus **turn-scoped** (a
  self-damaged mon is dropped from the turn-wide "biggest HP drop" / "plate appeared"
  target signals, which its own self-hit would otherwise win outright). The lost HP isn't
  dropped — it's billed to nobody and re-synced with an `hp <ref>=<val>` state line, so the
  engine tracks the screen without any move being credited for it.
  **The subtlety that only real footage exposed:** the game prints *both* "X became
  confused!" (the infliction, printed once by the move that just landed) and "X is
  confused!" (a nag before every turn X tries to act). They parsed identically, so
  suppressing the self-damage pushed the confusing move's target onto the wrong mon —
  caught on the archived trace where BOTH sides had a Pelipper and the opposing one's
  Hurricane confused mine. `parseBanner` now flags the reminder form, and the infliction
  form pins the target like any other follow-up. Replaying both live traces changes exactly
  one line: `o1 > Hurricane > m2 > 33%` (Hurricane billed for the self-hit) becomes
  `o1 > Hurricane > m2` + `hp m2=33%`.
- **P5 Region robustness across sources** ✅ CLOSED — **scoped down, then solved**
  (2026-07-24). The per-source override registry this item asked for is **not being
  built**: the user's decision is that the app needs to work for exactly two sources —
  their own screen and a friend's GameShare — and VOD tracing is done. Overrides for
  overlay/facecam VODs would be configuration for a problem that no longer occurs.
  What the two supported sources DID need was removing the manual flag. The layout is
  now detected from the picture per frame (`voteScreenLayout` + `LayoutDetector`), so a
  share that starts or stops mid-session is picked up on its own. Measuring the border
  by luma threshold does **not** work — dark game content reads as border, and real
  direct captures measured 0.44–0.48 "shrink" — so it's a hypothesis test at the known
  5/6 geometry instead: outer band near-black AND a brightness step inward. Real
  fixtures: GameShare outer-band luma 18–19, direct 71–236. Dark frames (fades) **abstain**
  rather than voting, and a flip needs 4 consecutive agreeing votes.
  **This was a live bug, not just a tidy-up:** Ctrl+W hard-coded `full: true`, so watching
  a friend's GameShare put every region on the wrong pixels — silent empty turns with no
  on-screen hint why — unless you knew to type `/watch` instead.
- **P6 Remaining banner grammar** ✅ mostly, and now **self-harvesting**. Crit, status,
  weather start/end, miss, drowsy (Yawn's only target signal), immunity, residual,
  end-of-game all landed. Wide Guard / Quick Guard and post-game lines are the known holes,
  and the game's exact wording for them is unknown — guessing a regex is worse than the gap,
  because it silently never fires and looks handled. So `read-live` now appends every
  unparsed real-looking banner to `fixtures/unknown-banners.log` (deduped, capped, text
  only, **always on — not gated on `--debug`**, since a hole you only capture while
  debugging is a hole you never fix). Next time a Wide Guard happens in a real match, the
  wording is on disk and the grammar is a one-liner.
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
2. ~~**Status-infliction target pins**~~ ✅ DONE (2026-07-26). "X was burned!" /
   "X is paralyzed!" now pin the move that caused them — often the ONLY target evidence a
   status move leaves, since Will-O-Wisp and Thunder Wave print no effectiveness line, so
   those moves used to emit `> self` and teach the engine nothing about the aim. Guarded
   against self-infliction, which is what makes it safe: **Rest** sleeps its own user, and
   a **contact attacker** picking up burn/par/psn is an ability punish (Flame Body /
   Static / Effect Spore) rather than a foe's target — pinning either would be exactly the
   kind of lie the miss/Protect guards exist to prevent. Replaying the 2026-07-23 live
   trace produces byte-identical output.
3. **Sprite coverage** — 90 species covered. Missing meta: **Annihilape, Corviknight,
   Glimmora, Tsareena**. Regionals are 3/17 (`Raichu-Alola` matters — Mega Raichu X/Y is
   the M-B headline). The app-owned harvest routine grows this automatically from every
   opponent you key manually; the VOD grind covers the rest
   ([`harvested-vods.md`](harvested-vods.md), [`sprite-refs-plan.md`](sprite-refs-plan.md)).
4. ~~**Perish clock**~~ ✅ DONE (2026-07-28). "X's perish count fell to N!" had no
   grammar, so a live perish TRAP passed unnoticed — the lines were read and dropped into
   the unknown-banner log. They now emit the engine's `<ref> perish N` state verb. Better
   than the existing cast-based auto-tracking, because the game reprints the count every
   turn for every affected mon: it stays exact even when the cast was never read or the
   singer has since switched out.
5. **Wide Guard / Quick Guard banner lines** — blocked on ground truth, and now waiting
   passively: the capture in P6 records the wording the first time one is used in a real
   match. Check `fixtures/unknown-banners.log` after a session that saw one.
   *(Per-source region overrides are NOT on this list — see the P5 closeout: the supported
   sources are your own screen and a GameShare, both auto-detected.)*

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
