# PokeChamps roadmap

## Context

**Last updated 2026-05-23.** 376 tests across 4 workspaces, all green.
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

Pillar status after the above:

- **A — Battle model completeness** — mega done, charge done, pivots
  done, spread fixed, ability-priority for speed done. Still open:
  switch-in ability triggers (Intimidate / weather setters), item
  triggers beyond Sash/Balloon/WP (Choice locks, Life Orb, berries),
  EOT weather/status interactions, move side effects (Encore / Taunt
  / Disable / Magic Coat), field clearing (Defog / Court Change /
  Rapid Spin), Tera / Z / Dynamax gimmicks (Champions hasn't rotated
  to them yet).
- **B — Inference quality** — Bayesian weighting still untouched
  (#142). Item inference still binary (#7 in old order). Speed
  inference is now reasonable for Prankster-style mons.
- **C — Decision support** — multi-turn lookahead, endgame solver
  still untouched.
- **D — TUI polish** — /undo done; others (inline edit, Tab cycling,
  resize-aware wrap, match-end summary, replay) still open.
- **E — Performance** — quickOnly helps; coarse-grid cache + inference
  delta still open.
- **F — Data** — multi-spread Pikalytics still single-spread; direct
  fetch path planned but not wired.
- **G — Server / web** — still low priority.
- **H — AI** — /review (last turn), /explain (bring) opt-in. No
  expansion this round.
- **I — Testing + ops** — no CI workflow yet.

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
- **End-of-turn weather + status interactions.** Sand chip on non-
  Steel/Rock/Ground, Hail/Snow defensive boost, Toxic ramp, Leftovers
  on switch.
- **Move side effects.** Sky Drop locks both mons, Fake Out only turn 1,
  Encore, Taunt, Disable, Magic Coat, Snatch, Sucker Punch fail
  conditions.
- **Field clearing.** Defog removes screens + hazards, Court Change
  swaps them, Rapid Spin removes only own-side hazards + boosts speed.

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
- **Multi-turn lookahead.** "If I do X, opp likely does Y, then end-
  state Z." Lightweight search over reasonable opp move choices.
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

- **Multi-spread Pikalytics scrape.** Top-K spreads, not just top-1.
  Currently only the most-common spread is in the cache; the second-
  most-common is often very different and worth surfacing as an alt
  candidate.
- **On-the-fly Pikalytics fetch for off-meta opps.** Already in
  scoutExport flow but server-side only — the TUI's direct fetch path
  was planned but never wired (memory file mentions it).
- **Champions client integration.** If/when the Champions client
  exposes a battle log API, parse it directly instead of typing.
- **Showdown replay parser.** Paste a replay URL → load as a saved match.

### G. Server / web *(low priority — TUI is primary)*

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

- **GitHub Actions CI.** Run `npm test` on push. (We commit + verify
  manually right now.)
- **Coverage reporting.** No baseline metric yet.
- **Property-based tests** for inference invariants ("any spread that
  satisfies observation X survives the filter").
- **Smoke test for the TUI** — spawn the binary, send keystrokes,
  assert rendered output. Hard to do well but catches regressions
  that unit tests miss.

## Recommended priority order

Picking the highest user value per unit of effort, given the user
plays matches live + finds bugs by doing so:

**Now (next 1–3 sessions):**

1. **A.2 — Switch-in ability triggers.** Intimidate (-1 Atk on
   incoming opps), Drought/Drizzle/Sand Stream/Snow Warning, Surges,
   Download, Trace. None applied in the engine today. Visible in the
   matchup grid because damage calcs differ. Task #141.
2. **B.1 — Bayesian candidate weighting.** Replace binary in/out
   filtering with probability scores. Each candidate gets a likelihood
   given ALL observations; "most likely" picks the highest score;
   damage ranges weight by candidate probability. Task #142.
3. **A.3 — Item inference from move outcomes.** Garchomp survived a
   guaranteed KO with 1 HP → Sash. Sand-immune mon took Sand chip →
   no Safety Goggles. Move locked to one option for N turns → Choice
   item. Largest single inference-quality win after Bayesian.
4. **Audit completion (task #156).** Several gaps noted but not
   tackled: Knock Off item removal, Trick/Switcheroo item swap,
   Encore/Taunt/Disable surfacing, Fake Out turn-1 gating,
   Sucker Punch fail conditions, end-of-turn weather/status ticks.

**Soon (4–8 sessions):**

5. **F.1 — Multi-spread Pikalytics scrape.** Top-K spreads, not just
   top-1. Tighter first-turn predictions. Was planned + dropped
   earlier.
6. **C.1 — Endgame solver.** Down-to-2-vs-2 enumerable; surface the
   optimal line. Stakes are highest, computation is bounded.
7. **I.1 — GitHub Actions CI.** Run `npm test` on push. Cheap insurance
   against regressions.
8. **D — More TUI polish.** Inline edit of draft actions; Tab cycling
   through autocomplete; resize-aware layouts; match-end summary
   screen; quick-replay through saved snapshots.

**Later (no fixed timeline):**

9. **A.1 — Tera gimmick scaffold.** Mega's pattern is the template.
   Wait for Champions to actually rotate to Tera before spending the
   effort.
10. **A.4 — Dynamax + Z-Move gimmicks.** Champions hasn't enabled them.
11. **C.2 — Multi-turn lookahead.** Wants Bayesian inference done
    first.
12. **F.2 — Champions client API integration** if/when one exists.
13. **G.2 — Web expansion / mobile.** Only if usage grows.
14. **H — AI feature expansion.** Opt-in only, conservative scope.
    (User explicitly distrusts LLM judgement on VGC — see
    feedback_pokemon_strategy memory.)

## Critical files (where the work lands)

| Area | Files |
|---|---|
| Gimmicks (still to scaffold) | `packages/core/src/domain/gimmicks/{tera,zmove,dynamax}.ts` |
| Ability triggers (switch-in) | `packages/core/src/domain/{abilities.ts}` **new**, `packages/core/src/match/engine.ts` (insertion point near `inferOpponentSpeeds` call) |
| Bayesian inference | `packages/core/src/domain/inference.ts`, `predictions.ts` |
| Item inference | `packages/core/src/domain/inference.ts` |
| Multi-spread Pikalytics | `packages/core/src/scripts/refresh-pikalytics.ts`, `pikalytics.ts` |
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

## Verification mindset

Each item should ship with:
- Specific test coverage demonstrating the new behavior
- A way to manually smoke-test from the running TUI
- A short commit message naming what real-world scenario the change
  unblocks

Keep the suite green at every commit. Current baseline: **376 tests** (was 359 when this doc was first written).

## Out of scope (deliberately)

- Mobile apps. TUI is the primary surface.
- Multi-language UI.
- Tournament-running features (we assist players, not organisers).
- Round-tripping the scoutExport back into a Match (interesting but
  niche).
