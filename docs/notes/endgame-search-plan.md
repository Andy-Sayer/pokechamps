# Background lookahead search — plan

**Vision (user, 2026-05-26):** the assistant should *constantly* compute the
best play in the background — even at full 4v4 — iteratively deepening (1 turn,
then 2, then 3…) and **updating the on-screen recommendation as deeper results
arrive**, rather than the user invoking `/endgame` on demand. The existing
1-ply `solveEndgame` becomes the depth-1 special case of this engine.

## Shape

Three layers, built in order:

1. **Pure search core** (`packages/core/src/domain/endgameSearch.ts`) — a
   deterministic, bounded, depth-limited maximin search returning the best
   move-pair + principal line + score for a position. Iterative-deepening
   wrapper `searchIterative(pos, maxDepth, { onDepth })`. No I/O, no threads —
   fully unit-testable. **(this turn)**
2. **Background scheduler** (TUI) — drives the search a slice at a time so the
   Ink UI stays responsive, publishing the improving best line after each
   completed depth. **(next)**
3. **UI surface** — a always-visible "best play (depth N…)" line in
   `BattleScreen`, refreshing as depth increases; replaces needing `/endgame`.
   **(next)**

## Turn model (per ply)

Reuses the existing per-turn predictors so we don't reinvent damage:

- A **joint action** for a side = a chosen (move, target) for each live active.
- **Candidate pruning** is mandatory or the tree explodes (see below): for each
  active, consider only its top-K moves by 1-ply `predictOffense` (K≈2–3) × its
  legal targets. So ≤~6 joint actions/side instead of up to 64.
- **Turn order** is speed-aware and taken **worst-case for me** (maximin):
  outside Trick Room the opponent's speed is their range **ceiling** (floor
  under TR), not the midpoint. A mon KO'd before it acts doesn't act —
  modelling order is the whole point (KO-first avoids retaliation), which the
  1-ply solver can't see.
- **Mega Evolution is a root decision per side.** I MAXIMISE over {no mega,
  mega my stone-holder}; the opponent MINIMISES over {no mega, mega each
  mega-capable active} (worst-case for me — we assume they hold the stone since
  the item is unknown). Each (myMega, oppMega) combo rebuilds the damage
  matrices + speeds with the relevant formes (`gimmickActive` on predict;
  `megaifyOppEntry` forces the opp's stone; `megaMaxSpeed` for the mega speed),
  built once per combo and reused across depths. So mega Aerodactyl's +Atk
  damage AND mega Delphox surviving it are both seen, and the recommendation
  says "mega <mon>" (`megaMon`) when that's the best line. Spread-move damage
  still uses the base attacker forme (minor; noted).
- **Damage is collapsed to a single representative value** (likely-mid % from
  `predictOffense`/`predictThreat`) so the tree stays finite. Ranges are NOT
  branched on (that's exponential); the honest min/max envelope stays a
  display-time concept, not a search-time one. (Possible later: min/max
  bracketing of the *root* move only.)
- **Spread moves (both sides) — handled.** Each active (mine AND the opponent's)
  gets a "spread" option (the SPREAD sentinel) when its move pool has an
  `allAdjacentFoes` / `allAdjacent` move; it applies that move's (already
  0.75-reduced) damage to *every* live foe in one action. The opponent's pool is
  drawn from the same `knownMoves`-else-Pikalytics source `predictThreat` uses;
  a forced-move range is obtained by synthesising a one-move entry. Without this
  the maximin under-counted incoming damage (e.g. Rock Slide / Blizzard hitting
  only one of my two actives) and over-stated "likely win".
- **Incoming contingent KO + flinch risks.** When the roll-dependence pass flips
  the verdict, the bottleneck scan now also considers a contingent KO on one of
  *my* actives (survives the median roll, dies to the top / mega roll) and names
  it — "Aerodactyl-Mega can KO Delphox" — instead of the old catch-all "damage
  rolls". Separately, an outspeeding opp move with a flinch secondary surfaces a
  per-acting-mon flinch risk priced like a survival item. Flinch is **not** in
  the maximin (matches the roadmap: secondaries feed the outs/risk analysis, not
  auto-applied state).
- **KO + replacement:** when an active faints and the side has live bench, bring
  in a replacement heuristically (best 1-ply matchup vs the current foes). We do
  **not** enumerate voluntary switches as actions in v1 — that's the main
  branching blow-up at 4v4 and is deferred. (Limitation: the search reasons
  about attacking lines, not switch-based stalling.)
- **Terminal:** a side with zero live mons loses. Leaf eval (at depth cap) =
  the 1-ply heuristic score (material + HP + threat), so the cap degrades
  gracefully to today's behaviour.

## Search algorithm

Maximin (consistent with the 1-ply solver's "opponent plays worst-case for
me"), not full simultaneous-move equilibrium — transparent and good enough:

```
value(pos, depth):
  if terminal(pos) or depth == 0: return leafScore(pos)
  best = -inf
  for myAction in prunedJointActions(mine):
    # opponent replies with the worst-for-me joint action
    worst = +inf
    for oppAction in prunedJointActions(theirs):
      child = resolveTurn(pos, myAction, oppAction)
      worst = min(worst, value(child, depth-1))
    best = max(best, worst)
  return best
```

Track the principal variation (best line) alongside the value. Alpha-beta
prunes the inner min/outer max once the core is correct.

### Branching budget

With K=3 moves/active and ≤2 targets, ≤6 joint actions/side → ≤36
turn-resolutions/node → ~36^d. Depth 3 ≈ 47k nodes (fine, time-sliced);
depth 4+ needs alpha-beta + tighter K. The scheduler caps depth by a time
budget, not a fixed number, so it deepens only as far as it can afford.

## Background scheduling (layer 2 — design, not built yet)

**Decision: cooperative time-slicing on the main thread**, not a worker thread.
Rationale: the TUI ships as a single esbuild bundle (`tui.mjs`) — worker_threads
need a separately-resolvable worker entry, which complicates the bundle. A
cooperative scheduler (`setImmediate`/`setTimeout(0)` between search slices,
each slice ~10–15ms) keeps Ink responsive and is bundle-trivial. If profiling
later shows jank, revisit worker_threads (the pure core moves into a worker
unchanged).

Loop: on each position change (turn finalized / override / HP edit), cancel the
in-flight search and restart iterative deepening from depth 1; publish
`{ depth, bestLine, score }` after each depth completes; idle once the depth
cap or time budget is hit. Debounce restarts so rapid edits don't thrash.

## UI surface (layer 3 — design)

A compact always-on line in `BattleScreen` (not a panel you open):
```
⌁ best play (depth 3, thinking…):  Sneasler→Close Combat→Incin · Rilla→Fake Out→Amoon   ✓ likely win
```
Shows the current-best joint move, the depth reached, and a thinking/▣ done
indicator. `/endgame` stays as the on-demand detailed view.

## Phasing

- **A — ✅ SHIPPED:** pure core + iterative deepening + tests
  (`endgameSearch.ts`). `createSearch(input)` builds the damage matrices once
  and answers any-depth queries cheaply.
- **B — ✅ SHIPPED:** cooperative background scheduler in `BattleScreen` — a
  `useEffect` keyed on a position signature runs one depth per macrotask
  (`setTimeout(0)`), publishing the improving result, capped at depth 4 / 1.5s
  and stopping early on a proven win/loss. `searchInputFromMatch(match, active)`
  maps live board → SearchInput.
- **C — ✅ SHIPPED:** always-on `⌁ best play (depth N): …` line under the
  battle header, colour-coded by verdict. `/endgame` stays as the on-demand
  detailed view.
- **Later:** alpha-beta depth gains; root-move min/max bracketing; mixed-strategy
  refinement if maximin proves too pessimistic. The "make the bar maximally
  helpful" work (explainability, break-points, voluntary switches, field actions)
  is now its own phased roadmap below.

## Non-goals (v1 — the shipped A/B/C core)

Exact equilibrium play; branching on damage rolls; mega for future switch-ins
(only currently-active mons are mega candidates); folding flinch/secondaries into
the maximin state (they surface as priced risks instead); modelling every
secondary effect (status/weather chip carry through via the field state we
already track, but we don't search status-fishing lines). Both-side spread moves
and named incoming KO/flinch risks ARE handled — see turn model.

Voluntary switches and order-affecting field moves (Tailwind / Trick Room) were
v1 non-goals but are now **shipped** (root-ply; see the roadmap below). Pivot
moves and damage-altering status (setup/screens/burn) remain deferred.

---

## Roadmap — making the best-play bar maximally helpful (2026-05-31)

The A/B/C core answers *what to play*. This roadmap makes the bar *trustworthy
and more capable*: explain the opponent's winning line, surface the pivotal
break-points, model switches + field moves, and report breadth honestly. Stays
deterministic (no LLM — `feedback_ai_direction`); recommendations stay honest
envelopes (`feedback_minimum_stat_points`, `project_endgame_honest_verdicts`).

### ✅ Status (2026-05-31): Phases 1–3 SHIPPED

All in `endgameSearch.ts` + `BattleScreen.tsx`, with focused tests in
`endgame-search.test.ts` (48 search tests, full suite green). Decisions made
during implementation (defaults chosen autonomously):

- **Phase 1 (explainability):** `SearchResult` gains `oppLine` ("they win via:",
  rendered when losing), `assumptions` (contingent-speed notes, no fabricated
  probability), `explored` (scope-derived breadth: lines/ply, candidate spreads,
  mega combos, and `actionClasses` listing the action kinds actually in the
  tree), and `adapted` ("spread refined from observed damage" when inference has
  speed bounds / candidate likelihoods).
- **Phase 2 (break-points):** `SearchResult.breakpoints` — per pivotal exchange,
  the HP cutpoint that flips the verdict, both *survive* ("if their hit stays
  under our HP we live & KO back") and *ko* ("OHKOs unless it invested bulk")
  directions, from pooled `percentRolls`/`candidatesConsidered`. Rendered as a
  `watch:` line.
- **Phase 3a (switches):** root-ply voluntary switches for BOTH sides via a
  `SWITCH` sentinel range (`jointActions` gains `switchTargets`, root-only;
  deeper plies stay switch-free). `resolveTurn` swaps slots before attacks and
  **redirects a hit aimed at a switched-out mon onto its replacement** (no free
  dodge in doubles). Doubles legality: no two actives into the same bench mon.
  - **Unrevealed-roster (`oppBench`) switch-ins** are folded into the opp list as
    **phantoms**, capped so total opp bodies never exceed the 4 VGC brings and
    gated on `!allOppRevealed`. Phantoms carry damage cells but **do NOT count as
    material until switched in** (`State.oppSeen`), so they never inflate the opp
    force; `refill` only auto-brings already-revealed mons (a phantom enters only
    via a deliberate switch). This is the user's "any of their known 6 until we
    whittle to 4". `benchRisk` still names the scariest incoming threat.
- **Phase 3b (Tailwind / Trick Room):** order flags (`trickRoom`, `myTailwind`,
  `theirTailwind`) moved from the fixed `Tables.field` into mutable `State`;
  `SET_TAILWIND`/`SET_TRICKROOM` actions (**this-turn-only**) flip them for the
  NEXT ply. Opp field moves offered only from REVEALED moves (opp-conservatism).
  - **Durations (shipped):** `FieldState` already tracks `trickRoomTurns` /
    `*TailwindTurns`; these are threaded into `State`, tick down each ply, and
    clear the flag at 0 — so the search can **stall an effect out** (Protect /
    switch until the opponent's Tailwind / Trick Room expires).
- **Leech Seed (shipped):** a `LEECH` sentinel range (foe-targeted, this-turn-
  only cast) + the end-of-turn **drain (1/8) / heal residual** applied every ply
  to active seeded mons (`State.mySeeded`/`oppSeeded`, healed via `Tables.*MaxHp`
  ratio). Grass types are immune. Existing seeds are threaded from the live match
  (`match.myLeechSeeded` / `OpponentEntry.leechSeeded`). So the search now both
  *evaluates* positions with an active seed and can *recommend* seeding.

**Terminology:** a *ply* = one searched turn; **"this-turn-only" / root-ply**
actions (switches, field moves, Leech Seed casts) are offered for the CURRENT
decision but not in the deeper hypothetical turns (which assume both sides
attack), to keep the always-on budget bounded.

**Targeting invariant (bug fixed):** single-target moves may only hit a foe in an
ACTIVE slot. Benched / unrevealed mons carry damage cells for switch-in modelling
but are NEVER attack targets (`jointActions` derives targets from `foeActive`, not
all live foes). Regression test: "never recommends attacking a benched opponent".

**Known limitations / deferred (chosen to keep verdicts correct):** switches and
field/seed casts are this-turn-only; **pivot moves** (Volt Switch / U-turn) are
deferred; phantom mega-evolution isn't modelled.

### Remaining roadmap (reordered per user, 2026-05-31)

- **Phase 4 — damage-altering field effects with DURATION + stall-out.**
  - **✅ Screens (Reflect / Light Screen / Aurora Veil) — SHIPPED (2026-06-01).**
    Same at-use-scaling trick as boosts: cells bake the current screen (via
    `@smogon/calc` `isReflect`/`isLightScreen`), and damage is scaled by
    `screenMult(live)/screenMult(baked)` on the DEFENDER's side (Reflect→physical,
    Light Screen→special; doubles modifier `2732/4096 ≈ 0.667`) — exactly 1.0 when
    unchanged, no regression. Screen state + durations live in `State`, tick down
    each ply (so an opponent's screen can be **outlasted**), and a `SET_SCREEN`
    action (this-turn-only, best of Aurora Veil > Reflect > Light Screen) puts one
    up for 5 turns. Action class `screen`.
  - **✅ Weather (Sun/Rain/Sand/Snow) — SHIPPED (2026-06-01).** Same at-use
    scaling: cells bake the current weather; `weatherDamageFactor` scales each hit
    by live-vs-baked (Fire/Water ×1.5/×0.5 in sun/rain; Gen-9 defensive Sand→Rock
    SpD, Snow→Ice Def ×2/3 to the matching category). **Speed**: a weather-speed
    ability (Chlorophyll/Swift Swim/Sand Rush/Slush Rush) gives a dynamic ×2 in the
    matching weather — known for mine, *plausible-from-pool* for the opp (the
    Prankster trick), so an unconfirmed Chlorophyll mon is still treated as a sun
    outspeed. `weather`+`weatherTurns` in `State` tick down → the sun can be
    **stalled out** (the user's example). `SET_WEATHER` action (Sunny Day/Rain
    Dance/Sandstorm/Snowscape) + switch-in weather abilities (Drought/Drizzle/Sand
    Stream/Snow Warning). Action class `weather`.
  - **✅ Terrain (Electric/Grassy/Misty/Psychic) — SHIPPED (2026-06-01).** At-use
    scaling: ×1.3 for the matching TYPE from a GROUNDED attacker (Electric/Grassy/
    Psychic); Grassy halves Earthquake/Bulldoze/Magnitude and Misty halves Dragon
    vs a GROUNDED defender. `isGrounded` = not Flying & not Levitate (Air Balloon/
    Iron Ball ignored). `terrain`+`terrainTurns` in `State` (added `terrainTurns`
    to `FieldState`) tick down → stall-out; `SET_TERRAIN` action + surge abilities
    on switch-in. Action class `terrain`. NOT modelled: Psychic Terrain blocking
    priority (an order effect), Grassy heal residual (below).
  - **✅ End-of-turn residuals — SHIPPED (2026-06-01).** On active mons each ply:
    burn 1/16, poison 1/8, toxic n/16 escalating (counter in `State`), Sandstorm
    chip 1/16 (non-Rock/Ground/Steel & no Sand-* ability), Grassy heal 1/16
    (grounded), Leftovers heal 1/16. Magic Guard blocks the DAMAGE (not heals).
    Like Leech Seed, only ACTIVE mons tick. `Tables.my/oppResidual` precomputes
    status/immunity/heal eligibility.
  - **✅ Inflicted status + Psychic-Terrain priority block — SHIPPED (2026-06-01).**
    `SET_STATUS` foe-targeted action (Will-O-Wisp→brn, Thunder Wave/Glare→par,
    Toxic→tox, Poison Powder→psn). Status is now DYNAMIC in `State` (`my/oppStatus`)
    so a move can inflict it mid-search; burn then halves the victim's physical
    output (scale), paralysis halves its Speed (dynamic), and it drives the EOT
    residual. `statusLands` honors type + ability immunities and Misty Terrain.
    Psychic Terrain makes priority moves FAIL vs a grounded target. Action class
    `status`. (Sleep still deferred — it's a can't-act mechanic, not a scale.)
  - **🎉 Phase 4 COMPLETE.** Only **Phase 5 (GPU)** remains.
  - **✅ Dynamic stat boosts (setup) + Speed Boost + Baton Pass — SHIPPED
    (2026-05-31).** `State.myBoost`/`oppBoost` track live TOTAL stages (seeded
    from input = the level baked into the cells). Solved the matrix-rebuild problem
    WITHOUT rebuilding: damage is scaled at use time by `boostDamageScale` =
    `statStageMult(total)/statStageMult(baked)` (offense) × inverse (defense) —
    **exactly 1.0 when nothing changed**, so positions without setup are
    numerically identical to before (no regression). Actions: `SET_BOOST` (setup
    moves — `SETUP_MOVES` table: Calm Mind / Swords Dance / Dragon Dance / Quiver
    Dance / Shell Smash …), `BATON_BASE` sentinel (Baton Pass = a switch that
    copies the outgoing mon's stages to the incoming mon), and EOT **Speed Boost**
    (+1 Spe/turn for the ability holder; order-only via dynamic Spe in the speed
    sort). This is the user's Espathra line: Protect → Speed Boost → Calm Mind →
    Baton Pass is now representable and judged by the win/loss lookahead, not a
    "damage = good" heuristic. Action classes: `setup` / `speedboost` / `batonpass`.
    **Still ignored:** screens/weather/terrain (below) and per-turn status
    residuals (burn/poison chip).
- **Phase 5 (LAST) — GPU parallel mode.** Park until Phase 4 ships and CPU perf is
  measured (per user: GPU comes *after* the damage-altering-status work). Batch the
  per-spread forward-damage grid as a kernel; the maximin tree stays on CPU.

The original phase descriptions below are kept as the early design record (their
Phase 4/5 numbering predates this reorder).

**Honest-breadth rule:** the breadth/assumption report is *scope-derived* — it
never claims it "considered a switch / status move" until those actions are real
nodes in the tree. We acknowledge the *possibility* of an opp switch as a risk
caveat (today's `benchRisk` already does) before switches are searched; we only
claim to have *evaluated* them once they exist.

### Feasibility facts (verified during planning)

- `predictOffense`/`predictThreat` already pool rolls across all candidate
  spreads (`percentRolls`) and report `candidatesConsidered` — so "OHKO in X% of
  plausible spreads", a "bulkiest surviving spread" scan, and **damage-threshold
  break-point** location are all available with no new calc work.
- `buildTables` builds `off`/`thr` cells over the **full** `input.mine`/`input.opp`
  arrays — every mon, not just the two actives. So **revealed-but-benched** opp
  mons (in `opponentBrought` → in `input.opp`) already have cells: switching *to*
  them is matrix-free.
- `searchInputFromMatch` already computes `input.oppBench` — the known-but-not-yet-
  seen roster mons (`opponentTeam` entries not in `opponentBrought`, non-fainted).
  `opponentTeam` holds the full 6 we entered at the bring stage, so `oppBench` is
  the rest of the opponent's known 6. **But these are NOT in `input.opp`, so they
  have no damage cells** — searching switches to them adds matrix cost (Phase 3a).
  Today `oppBench` is only used to *name* the scariest switch-in (`benchRisk`).

### The two opponent-switch classes

Drives legality, cost, and the "whittle to 4" gate — treat separately:

- **Revealed-but-benched** — was on the field, retreated. In `input.opp` → cells
  exist → **always legal, matrix-free**.
- **Unrevealed roster** (`oppBench`) — one of the known 6 not yet seen on the
  field. **No cells** (needs new matrix rows/cols from the inferred/default
  spread). Legal **only while `opponentBrought.length < 4`**: once 4 distinct mons
  have appeared, the other 2 were never brought and can never enter. That gate is
  "any of the 6 until we whittle down to the brought 4." Today's `oppBench` (a)
  holds only this unrevealed set and (b) is not gated on the 4-count — both need
  handling.

**Branch-count expectation:** up to ~2 actives × {attack-each-target, spread,
protect, switch-to-each-legal-bench, set-field} per side → **hundreds to low
thousands of joints per ply** before depth. Expected and acceptable on the target
hardware; motivates the GPU note (Phase 4), doesn't block the CPU build.

### Phase 1 — Explainability (no tree changes; highest ROI)

In `endgameSearch.ts` (`createSearch().toDepth`) + render in `BattleScreen.tsx`
(~lines 2295–2343).

- **1a. Opponent forcing line.** Thread the opp's *minimizing* joint out of the
  min nodes (cheapest: after maximin picks my joint, replay it against the opp's
  argmin reply and format). New `SearchResult.oppLine?: SearchPlay[]` (mirror of
  `playsFromJoint` via the `thr`/`oppSpread` tables). Render on `verdict==='losing'`
  as a dim `they win via: …` line; reuse in the hail-mary block.
- **1b. Speed assumptions.** For each opp attacker the verdict assumes
  outspeeds (or that we assume we outspeed), compare `effectiveSpeedRange(entry)`
  (`speed.ts`) vs my `actualSpeed`; emit "Assumes Aerodactyl invested Speed to
  outspeed Delphox" / "We outspeed Garchomp unless it ran +Speed". Extend the
  existing `scariestIncoming` scan — no second traversal.
- **1c. Honest breadth report.** New `SearchResult.explored: { joints, spreads,
  megaBranches, regimes, depth, actionClasses: string[] }`. `actionClasses` lists
  what's actually in the tree; render wording is generated from it (no "switches"
  before Phase 3). Dim conf-chip suffix, e.g. `(3 turns ahead · 4 spreads · 600
  joints · mega ×2)`.
- **1d. Surface adaptation.** `posSig` already re-runs on inference narrowing; add
  a one-shot dim `spread refined from observed damage` when the opp entry has
  `candidates`. Display-only.

### Phase 2 — Break-point / threshold analysis (headline ask)

> *"establish what break points in the stat spread should look like per possible
> move — e.g. if o1 hits us with Rock Slide and it does <100 damage we should be
> able to faint it next turn."*

For each pivotal exchange, find the **damage threshold that flips the verdict**,
plus the spread investment behind it, stated as an observation the user can check
against the real roll.

- **2a.** New `SearchResult.breakpoints: SearchBreakpoint[]` —
  `{ subject, move, direction: 'survive' | 'ko', thresholdHp, thenVerdict,
  spreadNote, prob }`. *Survival* direction (the Rock Slide example): cutpoint
  below which my mon lives → look one ply ahead to confirm I KO. *KO* direction
  (the Garchomp bulk case): scan `entry.candidates` for the bulkiest surviving
  spread. Locate the flip with pooled `percentRolls` (%) + `candidatesConsidered`
  (breadth). **Do not collapse to a static "unless invested" string** — the
  concrete HP number is the value. Extend the existing roll-bottleneck scan; don't
  add a traversal.
- **2b. Render.** Dim block of the top 1–2 verdict-flipping break-points, e.g.
  `watch: Rock Slide <100 → we live & KO back; ≥100 → we're down a mon`.

### Phase 3 — Action-space expansion (root-ply)

- **3a. Voluntary switches (both classes).** Promote `oppBench` into the
  searchable opp set so cells exist: extend `buildTables` to build rows/cols for
  the gated bench mons (only when `opponentBrought.length < 4`), from their
  inferred/default spread; revealed-benched already have cells. Add a
  `SWITCH(targetIdx)` sentinel to `jointActions` **at the root ply only** (pass
  `root: boolean`); deeper plies unchanged. `resolveTurn`: switcher deals no
  damage, swaps the active index, resets that slot's boosts, resolves before
  attacks. **Doubles legality:** no duplicate target across slots, no target equal
  to the other active slot's occupant; **pivot moves (Volt Switch / U-turn) that
  force a mid-turn switch are deferred.** `playsFromJoint` formats `Delphox→switch
  →Sableye`. Add `'switch'` to `actionClasses` once landed.
- **3b. Tailwind / Trick Room.** Move the mutable order flags (`trickRoom`,
  `myTailwind`, `theirTailwind`) from fixed `Tables.field` into `State`; the
  `effSpeed`/`oppOutspeeds` helpers (currently keyed off `t.field.*`) repoint at
  state. Add `SET_TAILWIND` / `SET_TR` actions, offered only when the mon's known
  moveset / Pikalytics pool contains it (same conservatism as `oppProtectMove`).

### Phase 4 — GPU parallel mode (MEASURED 2026-06-06 → NOT the bottleneck; shelve)

User floated GPU-parallel break-point/branch math with the caveat *"we need to
tidy everything up first."* The "tidy + measure first" gate was the right call.

**Measurement (full 4v4, 2 active + 2 bench/side, opps with 3 candidate spreads):**

| stage | time |
|---|---|
| `createSearch` (builds the whole damage grid — the GPU's target) | **~290ms** |
| `toDepth(1)` (root maximin) | ~100ms |
| `toDepth(2)` | **~2.3s** (no switch-at-depth) / **~6.1s** (Step B switches at the frontier) |
| `toDepth(3)` | **~72s** |

**Conclusion: the GPU is the wrong lever.** The damage-grid build (its only target)
is ~290ms — a rounding error next to a search TREE that costs seconds at depth 2 and
over a minute at depth 3. Step A (coarse K=3 spread profile) already removed the
per-spread explosion the GPU was meant to attack. And a GPU kernel would require
**reimplementing the damage formula in WGSL**, which violates the project's
"never reimplement the calc" rule. Net: high cost, near-zero payoff. **Shelved.**

**The real lever is the tree** (super-exponential branching on full 4v4s). Worth
doing instead, in rough value order: tighter alpha-beta move ordering; pruning
redundant root-only options at depth (Protect/setup duplicates); a transposition
table; and confidence/size-adaptive depth + `SWITCH_PLY_LIMIT` (Step C) — disable
switch-at-depth when the bench is large (barely reached anyway) and widen it in
small endgames where it's cheap and decisive. Step B's switches roughly tripled the
depth-2 cost on a full 4v4, so that gating is the highest-value quick win.

**Done (2026-06-06) — real alpha-beta windowing + move ordering.** `value()` had
only ever pruned against its node-local `best`; the `alpha` parameter was never
read and there was no `beta`, so cutoffs never crossed a ply. Threading a proper
fail-soft window — child gets `(floor = max(alpha, best), min(beta, worst))`, with a
`best >= beta` fail-high cut — plus best-first move ordering (a cheap `dmgMid`
heuristic per joint) collapses the deep tree. Exact: same maximin `score`/`verdict`/
`plays`, fewer nodes (all 930 tests unchanged). Root keeps my-joints *unordered* so
the reported best play is tie-stable; `oppBestReply` keeps a full `(-∞,+∞)` window
for the exact "how they beat us" argmin. Measured on the same full 4v4 (with Step B
switches at the frontier):

| stage | before | after |
|---|---|---|
| `toDepth(2)` | ~6.0s | **~2.4s** (2.5×) |
| `toDepth(3)` | ~628s | **~80s** (7.9×) |

No options dropped — the speedup is pure pruning. Depth 3 is still ~80s on a fresh
full 4v4, so the next levers (transposition table, root-only-dup pruning, Step C
adaptive `SWITCH_PLY_LIMIT`) remain worthwhile for live depth-3+.

**Profiled the per-edge cost (2026-06-07, depth-3 under `tsx`):** `resolveTurn`
32% · `value` 17% · **GC just 1.8%** · and ~38% is `tsx`/esbuild tooling
(`TextDecoder` + `__name`) that the production bundle doesn't pay. Takeaways: (a)
allocation is NOT the bottleneck — make/unmake/pooling was dropped from the plan;
(b) the real cost is `resolveTurn` *compute* × **1.49M edges** (≈26× branching/ply
after alpha-beta), so the lever is fewer/cheaper edges (TT, ordering) or a narrower
option set, not allocation; (c) the dev benchmarks over-report — re-baseline under
the bundle.

### Step C — adaptive depth + "work outwards" widening (shipped 2026-06-07)

Measured a **2v2 endgame**: depth-5 ~2s and the cost **plateaus** (~2.5s at depth
6-7) because short games terminate; and the verdict **flips with depth**
(winning→even→winning) settling at depth 5. So depth matters most exactly where
it's cheapest. Two parts shipped:

- **Adaptive deepening (driver).** The always-on background search now sizes its
  depth/budget to the position: ≤5 live mons → depth 10 / longer budget (reaches
  the depth-5 stabilization point endgames need); a wide board stays shallow with a
  growth-ratio guard so it never launches a 60s ply. Exact — only how deep/long we
  search changes.
- **Breadth knobs + widening schedule.** `createSearch(input, { spreadK,
  switchPlyLimit })` parameterizes the two breadth constants; `wideningSchedule()`
  returns the per-position passes. On a wide board: a fast **full** pass (the only
  one that may claim `forced`) then a **narrow+deep probe** (most-likely spread, no
  deep switches) for a tentative read several plies further out — surfaced in the
  TUI as a separate "⌁ deep probe" line, never as the headline. A restricted pass
  is stamped `breadth.full = false` and can **never** claim `forced` (it may have
  pruned my saving option or the opp's refuting spread). Endgames collapse to one
  deep full pass.

### Transposition table (shipped 2026-06-07)

Validated first by measuring the recurrence rate: **~47%** of internal `value()`
nodes repeat at depth-3 (4v4) and **~62%** at depth-5 (2v2) — exact-HP states
coincide far more than expected (deterministic `dmgMid`; protect/switch/status
lines converge). A per-`Tables` TT (`ttKey` serializes every value-affecting State
field + depth + maxDepth + the pass) probes on entry (EXACT returns; a LOWER bound
≥ β or UPPER bound ≤ α cuts) and stores the fail-soft bound on exit. Exact for the
maximin — all tests green.

| position | before | after |
|---|---|---|
| 4v4 `toDepth(3)` | 59s | **37s** (1.6×) |
| 2v2 `toDepth(5)` | 2.0s | **0.13s** (16×) |
| 2v2 `toDepth(6/7)` | ~2.5s | **~0.12s** (20×) |

The endgame win is the headline — deep, narrow trees are where transpositions
compound, so a 2v2 now solves to depth 7+ in ~0.1s and the adaptive driver reaches
its deep cap there essentially for free. Wide 4v4 is more modest (more distinct
states near the root). Note `maxDepth` is in the key (switch gating depends on
plyFromRoot), so the TT speeds each `toDepth(d)` *internally* rather than making
deepening incremental across `d`; cross-pass incrementality would need switch
gating by depth-remaining instead — a future option.

### Re-baseline under the production bundle (2026-06-07)

The dev benchmarks run under `tsx`, which the profile showed adds ~40% (sourcemap
`TextDecoder` + esbuild `__name`). An esbuild bundle run under plain `node` gives
the **real** numbers:

| position | tsx (dev) | bundle (real) |
|---|---|---|
| 4v4 `toDepth(2)` | 2.0s | **1.2s** |
| 4v4 `toDepth(3)` | 36.5s | **25s** |
| 2v2 `toDepth(5/7)` | ~0.12s | **~0.11s** |

So in production the **wide-board depth-2 read fits the 1.5s always-on budget**, and
endgames are ~0.1s to depth-7. Depth-3 on a fresh 4v4 (~25s) stays background-only —
the super-exponential wall is fundamental, not a tuning gap.

**Probe gate.** Because the wide-board narrow+deep probe costs seconds for a single
tentative ply past the headline, the driver now runs it **only when the full pass is
`even`** (genuinely contested) and gives it a 9s budget so it can clear depth-3.
Clear wins/losses skip the probe — deep-think only where it could change the call.

### Phase 5 — Damage-altering status (optional / later)

Setup (Swords Dance), screens, Will-O-Wisp / Thunder Wave. These invalidate the
precompute-once matrices. Build only if budget allows: per-boost-level matrices
(small fixed set) or accepted recompute on the rare branch. Defer; revisit after
measuring Phase 3 perf.

### Phasing discipline

Scope is large — keep each phase an **independently shippable, independently
tested diff**. Phase 1 = pure explainability, zero tree changes (safest). Phase 2
= break-points on the *existing* tree (no new actions). Phase 3a (switches) and 3b
(field) are separate diffs; 3a is gated behind the matrix-extension + legality
work and is the riskiest perf-wise — land and measure before 3b.

### Verification (roadmap work)

- `npm run typecheck`; `npm test` green.
- Focused endgame-search tests: (a) `oppLine` on a losing position; (b) a speed
  assumption on a contingent-speed KO; (c) a break-point with the correct HP
  cutpoint + flipped verdict, both directions; (d) a root switch to a
  revealed-benched mon chosen when it strictly beats attacking; (e) a switch to an
  unrevealed-roster mon offered while `<4 revealed` and **suppressed** once 4 are
  revealed; (f) doubles legality (no duplicate / other-slot target); (g) breadth
  `actionClasses` omits "switch" before Phase 3, includes it after.
- `npx tsx packages/core/src/scripts/smoketest.ts` — damage/inference unaffected.
- Manual (`npm start`, `npm run demo-team`): (i) losing to a faster mega → "they
  win via:"; (ii) borderline exchange → "watch: <move> <HP> → …"; (iii) a position
  where switching is correct → switch appears; (iv) an unrevealed-roster switch-in
  drops from reasoning once the 4th opp mon is seen.
- Keep `BattleScreen.tsx` read-only w.r.t. match state (search is a pure
  consumer); mirror nothing into the dual-finalize path (`project_dual_finalize_turn`).
