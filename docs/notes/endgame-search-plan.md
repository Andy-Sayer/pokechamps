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
- **Turn order** from `predictTurnOrder` (speed-aware). A mon that's KO'd before
  it acts doesn't act — this is the whole point of modelling order (KO-first
  avoids retaliation), and the 1-ply solver can't see it.
- **Damage is collapsed to a single representative value** (likely-mid % from
  `predictOffense`/`predictThreat`) so the tree stays finite. Ranges are NOT
  branched on (that's exponential); the honest min/max envelope stays a
  display-time concept, not a search-time one. (Possible later: min/max
  bracketing of the *root* move only.)
- **Spread moves (my side) — handled.** Each of my actives also gets a "spread"
  option (the SPREAD sentinel) when its set has an `allAdjacentFoes` /
  `allAdjacent` move; it applies that move's (already 0.75-reduced) damage to
  *every* live foe in one action, and the recommendation shows "→ all foes".
  Opponent spread moves are still modelled single-target (deferred — predictThreat
  doesn't take a forced move; opp modelling is already approximate).
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
- **Later:** alpha-beta depth gains; voluntary-switch actions; root-move min/max
  bracketing; mixed-strategy refinement if maximin proves too pessimistic.

## Non-goals (v1)

Exact equilibrium play; enumerating voluntary switches; branching on damage
rolls; opponent-side spread moves (my side IS handled — see turn model);
modelling every secondary effect (status/weather chip carry through via the
field state we already track, but we don't search status-fishing lines).
