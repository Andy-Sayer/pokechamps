# PokeChamps roadmap

> **⏱ Near-term plan:** [`roadmap-2026-06.md`](roadmap-2026-06.md) is the current
> **month-scoped execution plan** (June 2026) — read that for *what to build next*.
> This doc remains the strategic/pillar reference + the J north-star. **Note:** the
> "Recently shipped" / test-count figures below are stale (last bulk-updated
> 2026-05-29 at ~492–594 tests; the suite is now **994 green** and most of the
> "Now/Soon" tiers, the entire search long-tail closeout, the inline reveal verbs,
> and cross-mon item-clause exclusion have since shipped — see git log + the month
> plan for the true state).

> **See also:** [`accuracy-roadmap.md`](accuracy-roadmap.md) — a focused, tiered punch-list of damage/state/inference/search fidelity gaps and the order to close them. Maintained alongside this strategic doc.

## Context

**Last updated 2026-05-29.** 594 tests across 4 workspaces, all green.
A root `vitest.config.ts`
(`test.projects`) now aggregates every workspace's own config, so both
`npm test` and a bare `npx vitest run` from the repo root pass —
including the web package's `environment: 'jsdom'`.
Backend split complete (Phase 1–5), TUI is the primary surface, web
client is read-only viewer, server backs optional remote mode. Recent
session work has been correctness + UX gaps the user hits while
actually playing matches.

The codebase is in a healthy state to take big swings. This roadmap
groups potential work into pillars + suggests a priority ordering so we
don't get lost in low-value polish.

## Recently shipped (since the roadmap was first written)

The original "Now" tier is mostly done. What's been merged on `main`:

- **Mega evolution gimmick** — full forme/ability/item swap, candidate
  remap, X/Y variant disambiguation, standalone `m1 mega` action with
  its own +5 priority bracket, dual-forme predictions for pre-mega
  mons in the matchup grid + speed display. (A.1 / variant)
- **Ability-priority bumps in speed inference** — Prankster, Gale
  Wings (full HP), Triage, Stall now correctly skip the bracket-
  equality check (no false speed signals). Same contract as Quick
  Claw. (slice of A.2)
- **Quick Claw modifier** — `+quick` on actor; effective priority
  bumped; no speed signal. (A-adjacent)
- **Two-turn charge moves** — Solar Beam / Electro Shot / Phantom
  Force / etc. auto-detected via dex `flags.charge`; charging state
  surfaced in matchup grid. (A-adjacent)
- **Pivot moves** — U-turn / Volt Switch / Flip Turn / Parting Shot /
  Teleport / Chilly Reception / Baton Pass / Shed Tail detected via
  `selfSwitch`; pivot-follow switches tagged + skipped in speed
  inference; draft list hint. (A-adjacent)
- **Spread move modifier** — `damage.ts` auto-sets `isSpread` for
  `allAdjacent` / `allAdjacentFoes` targets; ~33% overstated damage
  fixed for Heat Wave / Earthquake / Rock Slide / Astral Barrage /
  Make It Rain / Discharge / Blizzard / Surf. (slice of A audit)
- **/undo slash command** — replaces backspace-removes-last-action
  which collided with text editing. (D.1)
- **/ask hypothetical matchup** — `/ask m1+mega vs o3` or
  `/ask Delphox-Mega vs Sneasler`. Read-only, no state change.
- **Bulk HP-update line** — `hp m1=45 m2=80 o1=30%` end-of-turn
  recovery so the user can keep up with fast-paced games.
- **HP=0 KO fix** — absolute-HP setters now auto-faint + clear active
  slot (was only happening via the damage-delta path).
- **TUI polish** — finalize spinner (PikaSpinner during heavy
  inference), clear-screen on startup, custom-bring order preservation,
  OpponentLeadPicker back-nav (Esc/Left), Clone team action,
  TeamManagement submenu, ExportPanel borderless for clean copy,
  EVs exported as PoChamps SP (0-32).
- **Inference speed** — `quickOnly: true` on BattleScreen inference
  to skip the 360k-spread coarse fallback that was blocking UI.
- **End-of-turn weather + status** — `endOfTurn.ts` (wired at
  `engine.ts`) applies weather chip with type immunities, brn/psn/tox
  damage + tox-counter ramp, and Leftovers / Black Sludge healing on
  MINE side only (opp items too uncertain to surface). (slice of A)
- **Switch-in hazards** — `hazards.ts` applies Stealth Rock (×Rock
  effectiveness), Spikes layers, Toxic Spikes (poison absorb), and
  Sticky Web (-1 Spe) on switch-in / replacement, honouring Magic
  Guard / Heavy-Duty Boots / type immunities. Wired via
  `applyHazardOnSwitchInto`. (slice of A — application only; clearing
  still open)
- **On-the-fly Pikalytics fetch** — `pikalyticsFetch.ts` hits the
  `/ai/pokedex` markdown endpoint fire-and-forget, dedups concurrent +
  failed fetches, merges into the in-memory cache and on-disk
  `data/pikalytics.<format>.json`, and is wired into the TUI. (F.2)
- **Autocomplete / suggester** — `actionSuggest.ts` derives the
  suggestion pool from which `>`-separated slot you're typing: move
  names, switch targets (restricted to the brought 4), and state-verbs
  (`heal`/`sitrus`/`brn`/...). (slice of D)
- **Switch-in ability triggers** — `abilities.ts` applies Intimidate
  (-1 Atk to foes, with immunity / Guard Dog / Defiant / Competitive /
  Rattled reactions), weather setters (Drought/Drizzle/Sand Stream/Snow
  Warning + signature weathers), terrain setters (the four Surges +
  Hadron Engine), and self-boosts (Intrepid Sword / Dauntless Shield)
  on switch-in. Opp abilities trigger only when certain (observed, or
  single-ability species). Wired into both the shared engine and the
  TUI's parallel `finalizeTurn`. (A.2)
- **Hazard clearing** — `hazards.ts` `hazardClearEffect` /
  `applyHazardClear`: Rapid Spin / Mortal Spin (own-side, +Spe), Defog
  (both sides + screens), Court Change (swap all side conditions), Tidy
  Up (both sides). Auto-detected by move name in `finalizeTurn` (engine
  + TUI). Completes the hazard story alongside switch-in application.
- **Field-setting moves** — `fieldMoves.ts` `fieldMoveEffect` /
  `applyFieldMove`: weather (Sunny Day / Rain Dance / Sandstorm /
  Snowscape / Chilly Reception), terrain (the four Terrain moves),
  Trick Room (toggle), Tailwind + Reflect / Light Screen / Aurora Veil
  (acting side). Fills a real gap — the field had a display but nothing
  set weather/TR/tailwind/screens from moves.
- **A.3 (part 1) — item removal in the calc.** Item-removing moves
  (`isItemRemovingMove`: Knock Off / Thief / Covet / Corrosive Gas /
  berry-eaters) mark the target's item gone in `finalizeTurn`; the
  prediction calc now strips a consumed/knocked item (opp via
  `opp.itemConsumed` in `predictions.defenderCandidates`, mine via a
  `myCalcSet` in the matchup grid). Still open (A.3 part 2): inferring
  the item FROM outcomes (Sash survival, Choice-lock).
- **Multi-hit damage input** — `m1 > Beat Up > o1 > 99,98,97,96,90(crit)`:
  comma values = successive remaining HP per hit (side-aware), optional
  per-hit `(crit)`. Parser emits one action per hit; finalize derives
  each delta. Also wired the action `critical` flag into the inference
  observation (engine + TUI) — previously crits never reached the calc.
- **/override panel** — interactive manual state editor
  (`OverridePanel.tsx`): field (weather / terrain / Trick Room /
  Tailwind), per-active occupant / HP (raw mine, % opp) / status /
  stat boosts. Two-step target-first nav + type-to-set values (`brn`,
  `sun`, `+2`, species names). `applyOverride` extracted + unit-tested.
  (D polish + user request)
- **Parser: slot-vs-index refs unified** — state lines now accept
  unambiguous `my1..my6` / `op1..op6` team refs everywhere (not just
  switch targets), so a benched mon at team index 0/1 — unreachable by
  the slot-overloaded `o1`/`m1` — can be targeted (`op1 = 30%`,
  `my2 brn`, `op4 in o1`). `resolveRef` centralises it. Rosters label
  benched mons with their `myN`/`opN` ref. (parser correctness + UX)

- **Move-restricting volatiles + first-turn gating** — Encore / Taunt /
  Disable logged as state lines (either side), surfaced in both rosters,
  cleared on switch/`cure`; Encore/Disable feed the opp threat pool.
  Fake Out / First Impression / Mat Block auto-gated by first-turn-out
  (`itemSignals.firstTurnOut`). Mechanics verified vs Bulbapedia. (audit)
- **Turn counters for timed effects** — weather / Trick Room (5) and
  Taunt / Encore (3) / Disable (4) seed a default count (`durations.ts`),
  count down in the shared `endOfTurn` tick, auto-clear at 0. Overridable
  via a trailing number on the state line and via `/override` (weather /
  TR turn rows). Shown in rosters + a grid "Field —" line. **Tailwind
  (4t)** added the same way (subagent).
- **GitHub Actions CI** — `.github/workflows/test.yml`. (subagent)
- **Endgame solver** — `domain/endgame.ts` `solveEndgame` + `/endgame`
  (`/eg`) command in the TUI. (subagents)
- **Defog screen-scope fix** — opponent-side screens only (audit).

Pillar status after the above:

- **A — Battle model completeness** — mega done, charge done, pivots
  done, spread fixed, ability-priority for speed done, EOT
  weather/status done, switch-in hazard *application* done, switch-in
  **ability** triggers done (Intimidate / weather / terrain / self-
  boosts — `abilities.ts`). Still open: Download / Trace switch-in
  abilities (need foe-stat / ability-copy logic — deferred),
  item triggers beyond Sash/Balloon/WP (Choice locks, Life Orb,
  berries), move side effects (Encore / Taunt / Disable / Magic Coat),
  Tera / Z / Dynamax gimmicks (Champions hasn't rotated to them yet).
  Hazard **clearing** done; field-setting moves done; **A.3 part 1**
  (consumed/knocked items dropped from the calc) done.
- **B — Inference quality** — Bayesian weighting still untouched
  (#142). Item inference: calc now honours item removal (A.3 pt1), but
  inferring the item FROM outcomes (Sash survival, Choice-lock — A.3
  part 2) is still open. Speed inference reasonable for Prankster mons.
- **C — Decision support** — multi-turn lookahead, endgame solver
  still untouched.
- **D — TUI polish** — /undo + autocomplete suggester done; others
  (inline edit, Tab cycling, resize-aware wrap, match-end summary,
  replay) still open.
- **E — Performance** — quickOnly helps; coarse-grid cache + inference
  delta still open.
- **F — Data** — on-the-fly Pikalytics fetch shipped + wired.
  Multi-spread deliberately de-prioritised (top-1 stands unless a
  clear ~50/50 split appears).
- **G — Server / web** — still low priority.
- **H — AI** — /review (last turn), /explain (bring) opt-in. No
  expansion this round.
- **I — Testing + ops** — no CI workflow yet.

## North-star goal — end-to-end battle validation

**The long-term aim:** drive *complete* battles through the same
pipeline the TUI uses and assert two invariants at every step —
(1) **every action was possible** (legal move / switch / target /
gimmick), and (2) **every damage event is consistent** with what we
compute. This converts the damage formula and the inverse solver from
"self-consistent" into "validated against ground truth."

**Primary ground-truth source: real Pokémon Showdown replays**
(standard gen9 VGC). Chosen for external validity — the observed
numbers come from Showdown's own engine, not ours.

Two consequences shape the design:

- **Replays usually hide EV/IV spreads.** Only species / revealed
  items / abilities / moves and observed HP deltas are exposed. So
  most damage events can't use strict range containment. Instead they
  become a **consistency** check: the observed damage must be
  *reachable by some spread our engine considers* — equivalently,
  feeding the observation to `inference.ts` must not empty the
  candidate set. That makes the harness a real-world test of the
  **inverse solver**, not just the forward formula. **Open-team-sheet**
  replays, where spreads are known, get the strict `observed ∈
  [min,max]` check.
- **Champions fidelity gap.** Real replays are gen9 VGC, so Mega and
  the 0–32 SP EV scale aren't exercised. J.0–J.5 validate the shared
  core (damage / legality / inference). Champions-specific mechanics
  (Mega `resolveSpecies`, SP-scale boundaries) need the
  *authored-Champions-transcript* corpus — folded in as **J.6** once
  the gen9 harness is proven.

### Phases

- **J.0 — Replay ingest. ✅ shipped 2026-06-10.** `showdownReplay.ts`
  (named so because `replay.ts` was already the TUI quick-replay tally)
  parses the `|`-protocol into a `BattleTranscript`: typed events per
  turn, lead block, open-team-sheet sets from `|showteam|` (packed
  format), item/ability reveals folded into the teams. Fetch + fixture
  caching via `scripts/fetch-replay.ts` → `tests/replays/`.
- **J.1 — Transcript → engine driver. ✅ shipped 2026-06-10.**
  `replayDriver.ts` walks turns through the production
  `finalizeTurn`/`applyStateUpdate`; transcript HP/field is ground
  truth, reconciled per turn so drift never compounds. The default fast
  walk strips HP observations pre-engine (running inference per hit
  against placeholder 0-EV sets blew up geometrically) and annotates
  damage back onto the recorded actions; `inferSpreads: true` is the
  J.3/J.4 lever that feeds the real observations to the inverse solver.
- **J.2 — Move-possibility assertions. ✅ shipped 2026-06-10.**
  Flag-only: learnset membership (ban-free format; missing-forme
  learnsets skip), switch-while-fainted/active, ≤1 gimmick per side
  (tera counted + noted as unmodelled), priority-bracket order (base
  priority + Prankster/Gale Wings when the ability is revealed). A
  corpus smoke test in `npm test` runs every cached fixture — 2 real
  VGC games so far, zero false flags.
- **J.3 — Damage consistency. ✅ shipped 2026-06-10** (reachability
  half). Reality check on the original spec: VGC open team sheets hide
  EVs/nature/IVs too, so "known spread" containment is only reachable
  via authored transcripts (J.6). What shipped: `replayDamageCheck.ts`
  gives every observed hit an ENVELOPE verdict — damage is monotonic in
  attacker investment / defender bulk, so two calc calls (min-invest vs
  max-bulk, max-invest vs frail) bound everything a legal spread can do,
  with items/abilities from OTS/reveals and transcript-truth boosts /
  status / weather / screens / Helping Hand / crit / curHP-scaled BP /
  Glaive Rush ×2. `out` = the model is missing something; `skipped`
  names what we can't bound (Gyro Ball-class speed BP, Rage Fist-class
  history BP, Tera). First catches: the latent `curHpPercent`-as-raw
  bug in damage.ts (Eruption BP), and Glaive Rush vulnerability (now
  modelled). 4-fixture corpus: 0 false `out`s, asserted in CI.
- **J.4 — Inference round-trip property test. ✅ shipped 2026-06-10.**
  Ground truth comes from the sim itself: a battle with fully-known
  on-grid sets plays out in `@pkmn/sim`, its omniscient protocol log
  (`|split|` private lines = exact raw HP) feeds the replay parser +
  production engine walk with inference enabled, and the test asserts
  the TRUE spread survives every observation's filter while a frail
  decoy is narrowed away (`replay-roundtrip.test.ts`). Prerequisite fix
  shipped with it: `scoreOffensiveSpread` now dedupes its EV sweep —
  the sweep overwrites the swept stat, so chained observations
  multiplied duplicates geometrically (one real replay turn measured
  71s; the 15-turn inferSpreads ingest is now 182ms, candidates ≤5).
- **J.5 — Corpus + CI + triage.** Checked-in replay fixtures (cached
  JSON — tests run offline/deterministic, never hit the network in
  CI). Out-of-range damage events get categorised (crit / spread /
  item / ability / field / weather / our-bug) as regression fixtures.
  Run under `npm test`; gate in GitHub Actions (ties into I.1). Track a
  pass-rate metric.
- **J.6 — Authored Champions transcripts.** Once J.0–J.5 hold,
  hand/script-author full-fidelity Champions battles (known sets, Mega,
  SP scale) to cover the mechanics real gen9 replays can't reach.

**Sequencing.** J leans on **A.2** (ability triggers) and **A.3** (item
inference) to cut false out-of-range flags, and naturally forces
**I.1** (CI). Build J.0–J.2 first — ingest + legality is independently
useful and low-risk — then layer J.3+ as the damage/inference engine
matures. Treat J as the overarching arc the other pillars feed, not a
single sprint.

**Critical files:** `packages/core/src/domain/replay.ts` **new**,
`packages/core/src/scripts/fetch-replay.ts` **new**, reuse
`match/engine.ts` / `turnparser.ts` / `damage.ts` / `inference.ts`,
fixtures under `packages/core/tests/replays/` **new**,
`.github/workflows/test.yml` **new**.

## Pillars

### A. Battle model completeness  *(highest user-visible value)*

The user finds correctness gaps every session. The damage / inference
pipeline gets a lot right but several whole mechanics aren't modelled.

- **Tera / Z-Move / Dynamax gimmicks.** Scaffolds exist (~30 LOC each)
  but only `mega` is implemented (~160 LOC). Reg M-A only uses mega
  today but Champions rotates the gimmick per regulation set.
- **Ability effects in calc + display.** Intimidate (drop opp Atk on
  switch-in), Drought/Drizzle/Sand Stream/Snow Warning, Speed Boost,
  Protosynthesis/Quark Drive on switch-in, Unburden, Trace, etc.
  Currently the calc honors abilities that affect damage formulas but
  the engine doesn't apply switch-in side effects.
- **Item triggers beyond Sash/Balloon/WP.** Berry types (Chople, etc.),
  Choice locks (Scarf/Band/Specs), Life Orb chip, Black Sludge on
  Poison-types, Eject Pack, Booster Energy.
- **End-of-turn weather + status interactions.** ✅ Shipped
  (`endOfTurn.ts`): weather chip with type immunities, brn/psn/tox +
  tox-counter ramp, Leftovers / Black Sludge mine-side. Hail/Snow
  *defensive* boost (Ice +Def) not yet applied in calc.
- **Move side effects.** Sky Drop locks both mons, Fake Out only turn 1,
  Encore, Taunt, Disable, Magic Coat, Snatch, Sucker Punch fail
  conditions.
- **Field clearing.** Defog removes screens + hazards, Court Change
  swaps them, Rapid Spin removes only own-side hazards + boosts speed.
  *(Hazard application on switch-in is done — `hazards.ts`. This is the
  removal half, still open.)*

### B. Inference quality  *(high value, harder)*

Per-opp set narrowing is binary today (a spread either matches
observations or it doesn't). Real damage observations carry probability.

- **Bayesian candidate weighting.** Each spread gets a likelihood score
  based on how well it fits ALL observations, not just survives a hard
  in/out cut. "Most likely" then picks the highest-scoring spread,
  damage ranges become probability-weighted across remaining candidates.
- **Cross-turn observation accumulation.** A single damage observation
  early in the match should narrow more after corroborating
  observations in later turns. Currently each turn's inference starts
  from the last turn's surviving candidates — good — but contradictions
  (e.g. the same opp survives X but is OHKO'd by smaller Y later) need
  recovery instead of stuck-empty candidate sets.
- **Item inference from move outcomes.** Garchomp survived a guaranteed
  KO with 1 HP → Focus Sash held. Sand-immune mon took Sand chip → no
  Safety Goggles / non-Sand-immune ability. Move chose to fail under
  Misty Terrain → Status-relevant item.
- **Speed propagation through full match.** When a new switch-in joins
  later, prior speed observations on its teammates shouldn't constrain
  it. Make sure inferOpponentSpeeds re-applies only same-mon constraints.
- **"What would I still learn from observing X?"** Surface to the user
  which observations would tighten inference fastest. Decision support
  for what to log.

### C. Decision support  *(meta-feature; lots of room)*

The matchup grid shows offense / threat / speed for the active matchup.
Beyond that:

- **Switch-in advice when current matchup is bad.** Computed today
  (BringPicker matchup grid) but not surfaced mid-battle.
- ~~**Multi-turn lookahead.**~~ ✅ Shipped as an **always-on background
  search** (`endgameSearch.ts` + `BattleScreen` cooperative scheduler):
  iterative-deepening maximin over move-pairs with turn-order awareness,
  updating a "⌁ best play (depth N)" line live. Plan +
  scope/limits in `docs/notes/endgame-search-plan.md`.
- **Endgame solver.** Down to 2 mons each — enumerate possibilities and
  surface the best play. Bounded enough to compute live.
- **Counter teaming from match history.** "You're 0-3 vs this opp's
  Sneasler — bring Slowking next time."
- **Probabilistic KO summary.** Per-turn "you have a 47% chance to
  close out this turn" rollup of the active matchups.

### D. TUI polish  *(small commits, high frequency-of-use payoff)*

- **/undo for the in-progress turn** — remove a specific draft action,
  not just the last one. Pick by number.
- **Inline edit of draft actions** — currently must remove + re-type.
- **Better autocomplete navigation** — Tab cycles through highlights
  instead of always picking #1.
- **Resize-aware layouts** — long lines wrap mid-token. Set explicit
  column widths or truncate gracefully.
- **Match-end summary screen** — wins/losses against each opp, MVPs,
  damage taken per mon.
- **Quick replay** — already-saved matches step through turn-by-turn
  with predictions overlay so you can see what you should've done.
- **Color-blind mode** — info conveyed by symbol + position, not just
  colour. (We use red/green/yellow heavily in matchup glyphs.)
- **Profile / preferences** — sticky toggles for /crit, /allmoves, etc.
  per user.
- **Sixel sprite integration** — the Pikachu spinner works but only as
  a /pika preview + AI-thinking indicator. Could surface mon sprites
  in the matchup grid + info panels.

### E. Performance  *(only if it bites)*

- **Sub-second inference for off-meta opps.** The 360k-candidate coarse
  grid takes ~10s when Pikalytics priors don't narrow. Cache + reuse
  per-species, parallelise the damage calls.
- **Incremental inference.** Don't re-run from scratch every turn —
  delta on the last set.
- **Sixel encoding cache.** Frames are static after first render; cache
  the encoded string per (bitmap, scale).

### F. Data + integrations

- **Multi-spread Pikalytics scrape.** *(De-prioritised — user is not
  fussed about top-K spreads yet.)* Only revisit if a species shows a
  clear ~50/50 split between two materially different spreads, where
  the single top-1 cache entry is actively misleading first-turn
  predictions. Until then, top-1 stands.
- **On-the-fly Pikalytics fetch for off-meta opps.** ✅ Shipped —
  `pikalyticsFetch.ts` hits the `/ai/pokedex` markdown endpoint
  fire-and-forget, merges into the in-memory cache + on-disk
  `data/pikalytics.<format>.json`, and is wired into the TUI
  (`BattleScreen.tsx`). The earlier "planned but never wired" note is
  stale.
- **Champions client integration.** If/when the Champions client
  exposes a battle log API, parse it directly instead of typing.
- **Showdown replay parser.** Paste a replay URL → load as a saved
  match. Shares the `replay.ts` ingest built for the J north-star goal
  (end-to-end battle validation) — build once, use for both.

### G. Server / web *(low priority — TUI is primary)*

- ~~**Shareable deployment.**~~ ✅ Shipped — provider-agnostic VM deploy
  (Oracle Always Free recommended) via `docker-compose.prod.yml` (server
  + Caddy auto-HTTPS), SQLite persisted to a Docker volume on real disk.
  TUI bundled to a single `tui.mjs` + `data/` (`npm run bundle:tui`,
  `scripts/bundle-tui.mjs` → esbuild) and served unauthenticated from
  `GET /download/tui.tar.gz`; the friend runs `node tui/tui.mjs`. Data-dir
  resolution in `data.ts` now probes `POKECHAMPS_DATA_DIR` / source /
  bundle-adjacent / cwd so the bundle finds game data. Runbook: `DEPLOY.md`.
- **Medium security items.** Per-route body limits, per-account login
  throttle, WS payload caps, generic error responses. Audit list
  exists in old plan notes.
- **Match share links.** `/match/:id/public` read-only URL surfaces the
  scout export + summary for sharing with friends.
- **Per-opp tracking across matches.** "You've played this opp 4 times,
  ELO trend, common brings."
- **Web client expansion.** Mobile-friendly layout, replay slider,
  edit-from-web. Defer until user actually uses web.

### H. AI / Claude

Per the user's standing feedback memory: AI features are opt-in, never
auto-trigger. Keep that posture.

- **Pre-bring AI suggestion** with reasoning (we have /explain on
  BringPicker — could go further).
- **Per-turn move recommendation** opt-in via `/advise`.
- **Endgame analysis** at match end summarising what worked / didn't.
- **Team build assistant** — describe a strategy, get a draft team.

### I. Testing + ops

- ~~**Root vitest workspace config.**~~ ✅ Done — root
  `vitest.config.ts` with `test.projects` aggregates all four packages
  with their own env; `npx vitest` from root now passes.
- **GitHub Actions CI.** Run `npm test` (or `npx vitest run`) on push.
  We commit + verify manually right now.
- **Coverage reporting.** No baseline metric yet.
- **Property-based tests** for inference invariants ("any spread that
  satisfies observation X survives the filter").
- **Smoke test for the TUI** — spawn the binary, send keystrokes,
  assert rendered output. Hard to do well but catches regressions
  that unit tests miss.
- **End-to-end replay validation** — the J north-star goal (see its
  own section above). The biggest single regression-safety win: real
  battles drive the production pipeline and assert move-legality +
  damage consistency. CI (I.1) is a prerequisite for running the
  corpus on push.

## Recommended priority order

Picking the highest user value per unit of effort, given the user
plays matches live + finds bugs by doing so:

**Now (next 1–3 sessions):**

1. ~~**A.2 — Switch-in ability triggers.**~~ ✅ **Shipped** — Intimidate
   (+immunity / Defiant-style reactions), weather/terrain setters,
   self-boosts. `abilities.ts`. Download / Trace deferred.
2. ~~**A.3 part 1 — item removal in the calc.**~~ ✅ **Shipped** —
   Knock Off / consumed items dropped from damage predictions.
3. **A.3 part 2 — infer the item FROM outcomes.** *(mostly done.)*
   ✅ Choice-lock: `detectChoiceLock` flags a mon repeating one move ≥2
   turns while staying in; roster shows `🔒Choice?`/`🔒Choice Scarf?`.
   ✅ Focus Sash: explicit `… > o1 > N sash` annotation — proc (1-sliver)
   consumes the item + skips inference; survive-with-HP records a held
   Focus Sash + still infers off the full damage (`sashProcced` gates
   both). Still open: Sand-chip → no-Safety-Goggles; auto-detecting
   Sash without the explicit tag (deferred — misfire-prone).
4. ~~**B.1 — Bayesian candidate weighting.**~~ ✅ **Done.**
   `candidateLikelihood` + Hybrid never-empty solver (no more "0
   candidates" dead-ends; recovers from contradictions). `scoreSpread`
   persists `OpponentEntry.candidateLikelihoods`. Per the minimum-stat-
   points principle, `mostLikely` reports the **least-invested**
   consistent spread (likelihood only breaks investment ties). Matchup
   cells keep the **honest min/max envelope** AND add the most-likely
   spread's range + a **confidence** rating (`high`/`med`/`low` from
   envelope width; `low` when it's still a prior). Display shows
   `move X-Y% (ko) · likely L-H% (hi)`. *(Probability-weighted ranges
   deliberately NOT adopted — the honest envelope stays.)*
5. **Audit completion (task #156).** ✅ Encore/Taunt/Disable volatiles
   (state lines + threat-pool effect, verified vs Bulbapedia), ✅ Fake
   Out / First Impression / Mat Block first-turn-out gating. ✅ Defog
   screen-scope fix (opponent side only — audit finding). Remaining:
   Trick/Switcheroo item swap, Sucker Punch fail conditions, Sand-chip →
   no-Goggles. From the Haiku audit (all overridable today, low
   priority): extended-duration items (Damp Rock / Light Clay → 8t)
   not auto-applied (we default 5t); Tailwind has no 4-turn counter yet.
   *(Knock Off removal, EOT weather/status, hazard clearing done; Snow
   no-chip, spread 0.75, priority-abilities, Intimidate list all
   verified correct.)*

6. ~~**C.1 — Endgame solver.**~~ ✅ **Done** — `domain/endgame.ts`
   `solveEndgame` (1-ply best-move-pair, 16 tests) + `/endgame` (`/eg`)
   command surfacing per-mon best-play lines in the TUI.
7. ~~**I.1 — GitHub Actions CI.**~~ ✅ **Done** — `.github/workflows/
   test.yml` (typecheck + test on push/PR). Runs once a remote exists.
8. ~~**G.1 — Shareable deployment.**~~ ✅ **Done** — TUI esbuild bundle +
   `/download/tui.tar.gz`; Oracle VM + Caddy compose; SQLite on disk.
   See `DEPLOY.md` and [[project_tui_bundle_deploy]].

**Soon (next 1–4 sessions) — the freshly-opened front:**

9. **Operational validation of the deploy** *(verifies the one piece
   I couldn't test locally).* Provision the Oracle VM, run the real
   `docker compose -f docker-compose.prod.yml up --build` (first true
   test of the multi-stage image + alpine `tar` bundle step), point DNS,
   confirm Caddy issues a cert, have the friend `node tui/tui.mjs`
   against it end-to-end. Likely shakeout: arm64 native build of
   `better-sqlite3` on the A1 shape, `.env`/CORS origin, firewall rules.
   Push to a remote first so CI (I.1) starts running and the friend can
   `git clone`.
10. **D — TUI polish.** Inline edit of draft actions; Tab cycling
    through autocomplete; resize-aware layouts; match-end summary
    screen; quick-replay through saved snapshots.
11. **Audit + inference leftovers** *(small, well-scoped commits).*
    ✅ Extended-duration items (Damp/Heat/Smooth/Icy Rock → 8t weather,
    Light Clay → 8t screens); ✅ Download / Trace switch-in abilities;
    ✅ Sand-chip → no-Safety-Goggles inference signal. All mirrored into
    the TUI finalizeTurn. **Still open:** Trick/Switcheroo item swap and
    Sucker Punch fail conditions (both touch the dual-finalizeTurn path,
    deferred from the parallel-agent batch).

    *(F.1 multi-spread Pikalytics deliberately dropped from this tier —
    see pillar F. Only revisit on a clear ~50/50 two-spread split.)*

**Later (no fixed timeline):**

12. **J — End-to-end replay validation** (north-star, own section
    above). Now partly unblocked: CI exists, and once a remote is live
    (step 9) the corpus can run on push. Biggest single regression-
    safety win — real replays drive the production pipeline and assert
    move-legality + damage consistency.
13. **A.1 — Tera gimmick scaffold.** Mega's pattern is the template.
    Wait for Champions to actually rotate to Tera before spending the
    effort.
14. **A.4 — Dynamax + Z-Move gimmicks.** Champions hasn't enabled them.
15. ~~**C.2 — Multi-turn lookahead.**~~ ✅ Shipped — always-on background
    iterative-deepening search (see pillar C + `endgame-search-plan.md`).
16. **G — Match share links + per-opp tracking.** `/match/:id/public`
    read-only URL; cross-match opp history (ELO trend, common brings).
    Natural follow-ons now the server is deployable.
17. **F.2 — Champions client API integration** if/when one exists.
18. **G.2 — Web expansion / mobile.** Only if usage grows.
14. **H — AI feature expansion.** Opt-in only, conservative scope.
    (User explicitly distrusts LLM judgement on VGC — see
    feedback_pokemon_strategy memory.)

## Critical files (where the work lands)

| Area | Files |
|---|---|
| Gimmicks (still to scaffold) | `packages/core/src/domain/gimmicks/{tera,zmove,dynamax}.ts` |
| Ability triggers (switch-in) | `packages/core/src/domain/{abilities.ts}` **new**, `packages/core/src/match/engine.ts` (insertion point at the `applyHazardOnSwitchInto` calls, ~`:424` / `:696` — the existing switch-in seam) |
| Bayesian inference | `packages/core/src/domain/inference.ts`, `predictions.ts` |
| Item inference | `packages/core/src/domain/inference.ts` |
| Multi-spread Pikalytics *(de-prioritised)* | `packages/core/src/scripts/refresh-pikalytics.ts`, `pikalytics.ts` |
| Endgame solver | `packages/core/src/domain/{endgame.ts}` **new** |
| CI | `.github/workflows/test.yml` **new** |

**Already done (for reference when reading the codebase):**

| Area | Files |
|---|---|
| Mega gimmick | `packages/core/src/domain/gimmicks/mega.ts`, `domain/megaResolve.ts`, `damage.ts` |
| Speed brackets + ability priority | `packages/core/src/domain/speed.ts` (`effectivePriority`, `abilityBracketBump`) |
| Spread modifier | `packages/core/src/domain/damage.ts` (auto-set `isSpread`) |
| Pivot moves | `packages/core/src/domain/data.ts` (`isPivotMove`), `match/engine.ts` (pivot tag), `domain/speed.ts` (sentinel bracket) |
| Dual-forme predictions | `packages/tui/src/ui/BattleScreen.tsx` matchups builder + MatchupRow |
| /ask | `packages/tui/src/ui/BattleScreen.tsx` (`runAskCommand`, `resolveAskSide`), `slashCommands.ts` |
| /undo + slash dispatcher | `packages/tui/src/ui/slashCommands.ts`, `BattleScreen.tsx` |
| Bulk HP / HP=0 KO | `packages/core/src/domain/turnparser.ts`, `packages/tui/src/ui/BattleScreen.tsx` (`applyStateUpdate`) |
| End-of-turn weather + status | `packages/core/src/domain/endOfTurn.ts`, wired in `match/engine.ts` (~`:428`) |
| Switch-in hazard application | `packages/core/src/domain/hazards.ts` (`applyHazardsToSwitchIn`), `match/engine.ts` (`applyHazardOnSwitchInto`) |
| Switch-in ability triggers | `packages/core/src/domain/abilities.ts`, `match/engine.ts` (`applySwitchInAbility`), TUI `BattleScreen.tsx` (`applySwitchInAbilityInto`) |
| Hazard clearing | `packages/core/src/domain/hazards.ts` (`hazardClearEffect` / `applyHazardClear`), `match/engine.ts` + TUI `finalizeTurn` |
| Field-setting moves | `packages/core/src/domain/fieldMoves.ts` (`fieldMoveEffect` / `applyFieldMove`), `match/engine.ts` + TUI `finalizeTurn` |
| On-the-fly Pikalytics fetch | `packages/core/src/domain/pikalyticsFetch.ts`, consumed by `packages/tui/src/ui/BattleScreen.tsx` |
| Autocomplete suggester | `packages/core/src/domain/actionSuggest.ts` (`deriveSuggestionContext`) |

## Verification mindset

Each item should ship with:
- Specific test coverage demonstrating the new behavior
- A way to manually smoke-test from the running TUI
- A short commit message naming what real-world scenario the change
  unblocks

Keep the suite green at every commit. Current baseline: **492 tests** (was 359 when this doc was first written).

## Out of scope (deliberately)

- Mobile apps. TUI is the primary surface.
- Multi-language UI.
- Tournament-running features (we assist players, not organisers).
- Round-tripping the scoutExport back into a Match (interesting but
  niche).
