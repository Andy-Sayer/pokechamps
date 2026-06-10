# Next-month roadmap — June 2026

**Written 2026-06-08.** A focused, time-boxed execution plan for the next ~4
weeks. Complements the strategic [`roadmap.md`](roadmap.md) (pillars, north-star)
and the two living gap docs — [`mechanics-coverage.md`](mechanics-coverage.md)
(the per-mechanic matrix) and [`sim-divergences.md`](sim-divergences.md) (the
empirical engine diff). This doc is the *what to actually build this month*,
pulled from those plus the open items in recent sessions.

## Where we are (snapshot)

**994 tests green across 4 workspaces.** The three layers are in very good shape:

- **Damage layer** (`@smogon/calc` via `damage.ts`) — mature/complete; custom
  Champions megas + abilities (Mega Sol, Dragonize, Spicy Spray, Piercing Drill)
  emulated. Recent fixes: Dragonize, Mega-Sol-overrides-weather, Black Sludge EOT.
- **Live engine** (`engine.ts` + domain modules) — broad coverage: hazards
  set/clear, field moves, EOT residuals, status/sleep counters, berries, item
  permanence/consumption, Defiant/Competitive live reaction, status-on-hit +
  chance-drop logging, mid-multi-hit item triggers, `o1 item`/`o1 ability` inline
  reveals, cross-mon item-clause exclusion.
- **Lookahead search** (`endgameSearch.ts`) — alpha-beta + transposition table +
  adaptive deepening + Step B/C/D switch enumeration + coarse opp profiles +
  "1D-chess" greedy-opp surfacing. The long-tail closeout (2026-06-05) modelled
  Counter / forced-switch items / rooms / Wish / Future Sight / Substitute /
  Magic Bounce / Disguise / freeze / self-destruct / Weakness Policy /
  Taunt+Encore. `unmodeled.ts` self-flags the residual blind spots live.

So the month is **not** about filling a long list of missing mechanics — most of
those are done. It's about **three structural levers** that each unlock several
parked items, **one feature the user explicitly asked for**, and **finishing the
ops/validation loop** that's been scaffolded but never run end-to-end.

## The month's themes

| # | Theme | Why now | Size |
|---|---|---|---|
| 1 | **Per-move damage cells** (search keystone) | Unblocks true Choice-lock, the recoil/KO-boundary residual (the one real sim divergence), and per-move priority reasoning. Root cause of several parked items. | L |
| 2 | **Hail-Mary outs analysis** | User explicitly asked for it; the framework (forced-win / winChance regimes) already exists — this is its mirror. Highest visibility-per-effort. | M |
| 3 | **Inference "backward half"** | The forward/live half is mature; the backward solver still mostly takes Pikalytics priors for ability + averages multi-hit. | M |
| 4 | **`@pkmn/sim` opt-in exact oracle + replay ingest (J.0–J.2)** | The self-flag detector is done; next is letting the user get the ground-truth turn when we flag "approximating", and the replay corpus is the long-run regression net. | L (stage it) |
| 5 | **Ops: deploy validation + medium security** | The bundle/compose/Caddy stack is built but never run on a real VM. One untested piece. | S–M |
| – | **TUI polish** (ongoing filler) | Small commits, high frequency-of-use. Slot between the big items. | S each |

---

## Prioritized backlog

### Theme 1 — Per-move damage cells *(the keystone refactor)*

Today the search collapses each (actor × foe) matchup to a single
best-damage cell. That single simplification is the root of multiple gaps:

- **Choice lock** is nearly a no-op (re-tiered P3 in coverage) — a real Choice
  mon stuck in one move that a switch-in walls is invisible because the cell
  always shows its best move.
- **The recoil/KO-boundary `fainted` residual** (the only genuine
  sim-divergence, ~10/277) is a point-estimate-vs-exact-roll artifact at KO
  thresholds — a per-move (and per-roll-regime) cell prices it precisely.
- **Priority reasoning** (`PRIO_BASE`) and coverage already bolt extra cells on
  the side; per-move cells subsume those cleanly.

**Plan:** extend `Tables` so each actor×foe carries a small set of move cells
(the mon's ≤4 damaging moves, not just the max), keyed by move. Keep the
max-damage cell as the default selection so existing behaviour is unchanged when
no constraint applies; let Choice-lock / wall-switch / KO-boundary logic select a
specific move's cell. Gate breadth so the tree doesn't explode (cells are
pre-built once per position, as now). **Verify** with the sim diff-harness (the
KO-boundary residual should shrink) and `search-mechanics.test.ts`.

*Effort:* large — stage it (a) build per-move cell tables behind the existing
default selection, no behaviour change; (b) Choice-lock selection; (c)
KO-boundary regime precision. Each stage independently testable.

**Stage (a) ✅ shipped 2026-06-09.** `Tables.offMoves[mi][oj]` / `thrMoves[oj][mi]`
carry a `Cell` per damaging move; the legacy `off`/`thr` cells are **derived from
them** via new single-pass `predictOffenseCells`/`predictThreatCells`
(`predictions.ts`) that reproduce the selectors bit-identically (offense =
candidate vote, threat = worst-case-for-me) and emit `percentRolls` per move.
The per-move tables therefore sit on the hot path — every search exercises the
derivation, and `per-move-cells.test.ts` holds LIVING equivalence tests against
the still-exported `predictOffense`/`predictThreat`. No behaviour change
(1013 green, search-suite runtime flat). Bolt-on cells (prio/Fake Out/pivot)
deliberately untouched — they carry semantic quirks (pivot skips blade-forme,
prio overrides priority); consolidation is a later cleanup.

**Stage (b) ✅ shipped 2026-06-09 — true Choice lock.** `State.my/oppChoiceMove`
(set when a holder attacks, cleared on switch-in, in the TT key); locked actors'
attacks substitute the locked move's per-move cell and their options narrow to
that move's viable targets + switching (`restrict.choiceLock`); live root locks
derive read-only from the match log (`lockedMoveSinceEntry` in itemSignals —
NO engine/BattleScreen mirror changes needed); opp locks require a KNOWN Choice
item (soft repeat suspicions stay display-only). Advisory layers
(risks/Hail-Mary/forced-demotion/obvious-play/oppLine labels) all honor the
lock. The last meta-priorities gap is closed. 1025 green; search runtime flat.
Next: stage (c) KO-boundary regimes.

### Theme 2 — Hail-Mary outs analysis *(non-forced + forced-demotion ✅ shipped 2026-06-09)*

Turned out a basic version already existed (only "my KO needs top roll" + a vague
"opp rolls low 0.5"). Rebuilt it around candidate **lines** and shipped the
unified **"opp fails the kill it's relying on"** out —
`P(fail) = (1−acc) + acc·P(roll doesn't KO)` — surfaced as
`"opp's Stone Edge misses or rolls low on Baxcalibur (~30%)"`, plus the my-roll
line and a generic last-resort. See [`accuracy-roadmap.md`](accuracy-roadmap.md)
§"Hail Mary" for the shipped detail + tests.

**Forced-loss demotion (the accuracy half) ✅ shipped 2026-06-09.** When the only
loss path is the opp landing a roll-guaranteed sub-100% kill, the position now
demotes from `forced` (per-out verdict-flip re-check via the new `Pass.forceSurvMy`
"this mon lives through the turn" flag) and surfaces the `"opp's Stone Edge misses"`
out. Conservative (single-killer gate + survive-proxy ≤ a real miss → no false
demotion). See [`accuracy-roadmap.md`](accuracy-roadmap.md) §"Hail Mary".

**Remaining — the crit out.** The optimistic regime also ignores crits, so a
position escapable only via a crit is still mislabelled `forced`. Folding in the
**crit** out (`critProbFor`: Gen-9 crit stages + Scope Lens / Super Luck / Battle
Armor) needs faithful same-turn, turn-order-aware crit-KO modelling — its own
change, deferred. **Sequencing note:** a crit is a per-MOVE event (1/24 base vs
1/8 high-crit moves; ×1.5, ignores the defender's positive Def boosts + screens),
which today's single best-damage cell can't represent — per-move cells (Theme 1)
give it a natural home as one more roll regime on the cell. Slot the crit out
AFTER Theme 1 stages (a)–(b), not before.

### Theme 3 — Inference backward half

The forward/live inference is mature (joint axis, offensive-EV, recoil/drain
HP-stat read, positional boosts, item-clause exclusion). What's still thin:

- **Ability inference from observations.** Today we mostly take the Pikalytics
  top ability. Narrow it: a fast turn-1 rules out Truant; observed neutral
  damage from a Ground move rules out Levitate; paralysis landing on contact
  rules out Limber; Hydration clearing status in rain; no Sand chip taken ⇒
  Magic Guard / Sand-immune / (already: not-Safety-Goggles via sand chip).
  Mirror the `abilitiesRuledOutByHit` hook that already exists in `inference.ts`.
- **Multi-hit variable-range KO distribution.** `@smogon/calc` averages at 3
  hits (5 with Skill Link). A per-hit-count distribution tightens KO odds for
  Bullet Seed / Rock Blast / Triple Axel / Icicle Spear / Population Bomb.
- **Thread item-clause into the inference *axis*** (parked in
  `project_item_clause_exclusion`). Today it's a post-hoc filter on candidate
  output — correct for the displayed result, but the coarse grid still *generates*
  claimed-item spreads. Passing an `excludeItems` set into `scoreSpread`'s item
  axis is tidier and slightly higher quality.

*Effort:* medium, splits into 3 independent commits. Ability inference is the
highest-value of the three.

### Theme 4 — `@pkmn/sim` exact oracle + replay ingest (J.0–J.2)

Two halves of the same `replay.ts` investment (see
[`project_sim_engine_strategy`] + roadmap §J):

- **Opt-in exact oracle for the shown line.** `unmodeled.ts` already tells the
  user *when* the verdict has blind spots. Step 2 is letting them act on it:
  resolve the recommended line through real `@pkmn/sim` on demand and show the
  ground-truth turn outcome. Client-side only (per
  `project_client_side_compute`). Spike already proved mid-battle load +
  ~700–3k turns/sec.
- **Replay ingest + legality (J.0–J.2).** Parse a Showdown replay
  (`|`-protocol) into a `BattleTranscript`, walk it through the *production*
  `match/engine.ts`, and assert move-possibility (learnset / target / gimmick /
  turn-order brackets). Independently useful (paste-a-replay → saved match) and
  low-risk — it flags, doesn't hard-fail. J.3+ (damage consistency, inference
  round-trip) layer on later.

*Effort:* large — do the oracle first (smaller, directly user-facing), then J.0–J.2
ingest. Stage; don't try to finish all of J this month.

### Theme 5 — Ops: deploy validation + medium security

- **Operational validation of the deploy** (the one piece untested locally).
  Provision the Oracle Always-Free VM, run the real
  `docker compose -f docker-compose.prod.yml up --build` (first true test of the
  multi-stage image + alpine `tar` bundle step), point DNS, confirm Caddy issues
  a cert, have a friend `node tui/tui.mjs` against it end-to-end. Likely
  shakeout: arm64 `better-sqlite3` build on the A1 shape, `.env`/CORS origin,
  firewall. (Needs a manual `! gcloud`/`ssh`-style step from the user — flag it.)
- **Medium security items** (branch `security/hardening` exists): per-route body
  limits, per-account login throttle, WS payload caps, generic error responses.

*Effort:* small–medium; mostly the user's hands-on VM step + a tidy PR.

### Theme 6 — TUI polish *(filler between big items)*

From roadmap pillar D, what's still open after the recent draft-edit / Tab-cycle
/ `/summary` / resize-aware / quick-replay work:

- **Match-end summary completeness** — wins/losses vs each opp, MVPs, damage
  taken per mon (extend `/summary`).
- **Color-blind mode** — matchup glyphs convey info by symbol + position, not
  just red/green/yellow.
- **Sticky preferences** — per-user toggles for `/crit`, `/allmoves`, etc.
- **Sprites in the matchup grid** — the sixel pipeline exists (spinner / `/pika`);
  surface mon sprites in the grid + info panels.

### Theme 7 — Remaining search long-tail *(low priority, batch as filler)*

All rare in Reg M-A; each a small, self-contained, no-regression diff (the
established pattern). Pick up only if a theme above stalls:

- Black Sludge in search (currently PARTIAL — poison-heal/else-hurt EOT).
- Grassy-terrain heal residual in search.
- Booster Energy proc-on-switch (Protosynthesis/Quark Drive without weather).
- Disable / Torment / Imprison root-carry from the live match.
- Ability redirection (Storm Drain / Lightning Rod) + Ally Switch.
- Spread debuffs (Growl / Leer) + accuracy/evasion drops.
- Yawn (delayed sleep).

**Deliberately excluded (policy, not gaps):** confusion, 25% full-para,
probabilistic secondaries — surfaced as risks / Hail-Mary inputs, never baked
into maximin. The rooms' pure-damage effects (Wonder/Magic Room Def/SpD swap,
Magic Room item suppression) stay root-baked until the GPU/recompute phase.

---

## Suggested 4-week sequencing

Ordered for the user's reality (plays live, finds bugs by doing so) — ship
visible wins early, do the keystone refactor mid-month, validate at the end.

- **Week 1 — Hail-Mary outs (Theme 2)** + a batch of cheap search long-tail
  (Black Sludge search, Grassy heal residual, Booster Energy proc — Theme 7).
  Visible win the user asked for, plus low-risk filler that drains the long-tail.
- **Week 2 — Per-move damage cells (Theme 1)**, stages (a)+(b): build the cell
  tables behind the existing default, then Choice-lock selection. Keep the suite
  green at each stage.
- **Week 3 — Inference backward half (Theme 3)** + per-move cell stage (c) (the
  KO-boundary regime precision, now that cells exist). Re-run the sim diff-harness
  to confirm the `fainted` residual shrank.
- **Week 4 — `@pkmn/sim` opt-in exact oracle (Theme 4, first half)** +
  **deploy validation (Theme 5)** as a parallel ops track. J.0–J.2 replay ingest
  if time remains.
- **Throughout — TUI polish (Theme 6)** slotted between the big items.

## Explicitly *not* this month

- **GPU parallel search** (mechanics-coverage P4) — gated on a perf-tidy of the
  search core; the tree, not the kernel, is the bottleneck (measured). Revisit
  after per-move cells land and CPU perf is re-measured.
- **Tera / Z-Move / Dynamax gimmicks** — Reg M-A is Mega-only; wait for
  Champions to rotate the gimmick (`format.champions.json`).
- **Web client expansion / mobile** — TUI is primary; defer until usage grows.
- **AI feature expansion** — opt-in only, conservative; the user distrusts LLM
  VGC judgement ([`feedback_pokemon_strategy`] / [`feedback_ai_direction`]).
- **Full J.3–J.6 replay validation** — layer on after J.0–J.2 + the oracle prove
  out; not a single-month sprint.

## Working method (unchanged)

- Never reimplement the calc. Verify *rules* against Bulbapedia/Serebii, *numbers*
  against `@smogon/calc` + the in-app smoketest.
- Each gap = one focused, independently-tested diff with a no-regression property.
- **Dual-mirror invariant:** every battle-mechanic change lands in BOTH
  `match/engine.ts` and the TUI's `BattleScreen.tsx` finalize/apply paths.
- Keep the suite green at every commit; batch verification at the end of a chunk,
  not after every edit.
