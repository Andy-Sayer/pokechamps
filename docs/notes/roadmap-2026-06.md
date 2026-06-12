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

**Stages (c)+(d) ✅ shipped 2026-06-09 — THEME 1 COMPLETE.**
- **(c) `fainted` residual ELIMINATED (10 → 0; 43/277 → 38/277).** Diagnosis-first:
  a `--detail fainted` report mode dumped all 10 positions, overturning the
  "point-estimate at the KO boundary" theory — the real causes were three
  mechanic gaps, all fixed: **fainted-target retargeting** (~6.5/10; a
  single-target move whose target died retargets the remaining foe with the
  SAME move's per-move cell — the stage-(a) tables made the faithful fix
  possible), **Dragon Darts doubles split** (one dart each foe), and **Rage
  Fist hit scaling** (+1× per hit taken this turn). Remaining 38 divergences
  are exclusively policy-excluded probabilistic secondaries. See
  [`sim-divergences.md`](sim-divergences.md).
- **(d) crit out (defensive flavor).** Forced losses escapable only by
  crit-KOing the killer first now demote with `"crit: …"` as Hail-Mary Line B
  (critProbFor Gen-9 stages, lazy root-only crit cells, strict outspeed gate,
  terminal-aware `flipScore` counterfactual). Bonus: fixed the
  predictOffense/Threat quirk so the TUI `/crit` grid reports true crit ranges.
  Offensive crit flavor deferred (needs a crit-augmented pass). See
  [`accuracy-roadmap.md`](accuracy-roadmap.md) §"Hail Mary".

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

- **Ability inference from observations. ✅ shipped 2026-06-10.**
  `domain/abilityInference.ts` + `OpponentEntry.abilitiesRuledOut`: landed
  damaging hits persist the type-immunity rule-out (Ground hit ⇒ no Levitate —
  durable now, not per-observation), and explicitly-logged statuses (`45 brn`
  tags, `/ brn` self-clauses, `o1 par` state lines) rule out the status's
  immunity abilities (par ⇒ no Limber; + Leaf Guard when sun was up; berry-cured
  still counts — the landing happened). Conservatism: engine-ASSUMED statuses
  (auto-applied status moves, Spicy Spray) prove nothing; Mold Breaker-line
  attackers and ignore-ability moves suppress the proof; sand-chip rule-outs
  deferred (EOT chip is engine-assumed, not observed). Rule-outs feed
  `scoreSpread`'s ability axis + candidate filtering, and `certainAbility` now
  takes `ruledOut` — a 2-ability species collapses to CERTAIN (Garchomp minus
  Sand Veil ⇒ Rough Skin), unlocking switch-in effects / Magic Guard EOT /
  Magic Bounce checks via the threaded call sites. Bonus: an `o1 ability`
  reveal now prunes the candidate set (it previously only set the field).
  Dual-mirrored in engine.ts + BattleScreen.tsx; `ability-inference.test.ts` (16).
- **Multi-hit variable-range KO distribution. ✅ shipped 2026-06-10.**
  `damageRange` now expands [2,5]-hit moves to the true Gen-5+ hit-count
  weights (2/3 hits 35% each, 4/5 15% each) instead of the calc's flat 3-hit
  average: `rolls`/`percentRolls` carry the weighted union, so min/max span the
  honest 2×min..5×max envelope (a 2-hit low roll used to fall BELOW `min` and
  made inference reject truthful observations) and every consumer
  (candidateLikelihood, the search's koRolls pooling → rollKoProb) weights KO
  odds by hit-count probability automatically. Bonus fixes: the attacker's
  resolved ability/item now feed the calc's `Move` constructor — **Skill Link
  was previously ignored** (Cinccino/Cloyster computed 3 hits, now 5) — and
  Loaded Dice gets its 4-5 @ 50/50 distribution. Triple Axel/Triple Kick
  (escalating BP, fixed 3) and Population Bomb (fixed 10) keep the calc's
  fixed-count path. `multi-hit-distribution.test.ts` (5).
- **Thread item-clause into the inference *axis*. ✅ shipped 2026-06-10.**
  `scoreSpread({excludeItems})` filters both the coarse item axis (claimed
  spreads are never generated) and prior/starting candidates;
  `claimedItemIdsExcept(opponentTeam, idx)` (itemClause.ts) supplies the set at
  both finalizeTurn call sites (engine.ts + BattleScreen.tsx). The post-hoc
  `applyItemClauseExclusion` stays as the safety net for claims that appear
  without a fresh observation (e.g. an `o1 item` reveal mid-turn).

**Theme 3 complete (3/3 commits, 2026-06-10).**

### Theme 4 — `@pkmn/sim` exact oracle + replay ingest (J.0–J.2)

Two halves of the same `replay.ts` investment (see
[`project_sim_engine_strategy`] + roadmap §J):

- **Opt-in exact oracle for the shown line. ✅ shipped 2026-06-10.** `/exact`
  (alias `/sim`) maps the current ⌁ best play + predicted opp reply to Showdown
  choice strings (`simOracle.ts`), resolves the turn through real `@pkmn/sim`
  over 16 deterministic RNG seeds, and reports the ground-truth DISTRIBUTION:
  per-mon HP envelope/mean, faint rate, gained-status rates (a 30% Scald burn
  shows as `brn 31%`), field changes. The "⚠ approximating" line now points at
  it. Dependency boundary: `simBridge` lazy-loads the engine
  (`ensureSimLoaded()`), `@pkmn/sim` moved devDep → **optionalDependency**, and
  the TUI bundle marks it `external` — verified the bundle builds without the
  engine's source and boots without the package (degrades to "exact engine
  unavailable — npm i @pkmn/sim"). Choices are probe-validated first
  (`side.choose()`), so an unmappable/illegal line fails honestly instead of
  silently resolving a default. Board shapes: full 2v2, and true 1v1 endgames
  via a SINGLES-format fallback (the sim can't start doubles with a one-mon
  side); one-active-with-live-bench / 2v1 fail with a clear message — the
  known v1 limitation. Custom Champions megas don't exist in the sim → probe
  rejects them honestly. `sim-oracle.test.ts` (5).
- **Replay ingest + legality (J.0–J.2). ✅ shipped 2026-06-10.**
  - **J.0** `showdownReplay.ts`: `|`-protocol → `BattleTranscript` (typed
    events, lead block, per-turn groups; nickname→species pinned to first
    sight so mega re-switches don't fork team entries). Open team sheets
    (`|showteam|` packed format) resolve to display-name sets; item/ability
    reveals (`[from] item:`, `|-ability|`, `|-enditem|`) fold into the teams.
  - **J.1** `replayDriver.ts`: walks the transcript through the production
    `finalizeTurn`/`applyStateUpdate`. Transcript HP/field is GROUND TRUTH —
    reconciled after every turn so drift never compounds. The fast walk
    (default) strips per-action HP observations before the engine call and
    annotates damage back onto the recorded actions afterwards: feeding them
    through ran spread inference per hit, and consecutive opp hits chained
    `scoreOffensiveSpread`'s ×9 EV expansion into a geometric blow-up against
    the driver's 0-EV placeholder sets (measured 71s for ONE turn; now 27ms
    for a 15-turn game). `inferSpreads: true` re-enables real observations —
    that's J.3/J.4's lever, where the inverse solver itself is under test.
  - **J.2** flags (never hard-fail): learnset membership (format-ban-free;
    missing-forme learnsets skip rather than false-flag), switch-while-
    fainted/active, >1 gimmick per side (mega + tera both counted; tera also
    emits a "not modelled" note), and priority-bracket order (base priority +
    Prankster/Gale Wings when the ability is revealed).
  - `scripts/fetch-replay.ts` downloads + caches fixtures under
    `tests/replays/` and prints a parse/ingest summary; a corpus smoke test
    runs every cached fixture (4 real VGC games so far — all parse, drive,
    and produce ZERO false flags). `showdown-replay.test.ts` (16).
  - **J.3 (reachability half) ✅ shipped 2026-06-10.** Replays hide spreads
    even with OTS, so the per-hit check is an ENVELOPE: two calc calls bound
    what any legal spread can do (items/abilities known; transcript-truth
    boosts/status/weather/screens/HH/crit/curHP/Glaive-Rush ×2 threaded in by
    the driver), `out` = model gap, `skipped` honestly named (speed-BP,
    history-BP, Tera). First real catches: the latent damage.ts
    `curHpPercent`-treated-as-raw bug (Eruption/Water Spout BP was computed
    from ~30% HP at "56%") and Glaive Rush's ×2-taken vulnerability (now
    modelled in the checker). Corpus: 18+ hits across 4 games, 0 false outs —
    asserted in CI. Strict containment joins with J.6's authored Champions
    transcripts; J.4 (inference round-trip) is the next layer.
  - **J.5 ✅ shipped 2026-06-11.** Corpus grown to 16 real games (batch
    `--search` fetch), `replay-corpus-report.ts` pass-rate metric (199 hits,
    97% in, 0 crashes/flags). Triage fixed: multi-hit per-target aggregation,
    full TERA modelling in the checker (was 30% skipped), Protosynthesis/Quark
    Drive `boostedStat`, Focus Sash capping, `[spread]`-tag semantics, Ogerpon
    tera-forme double-count, Triage priority, hidden-ability order-flag
    suppression, transcript-truth field reassertion. One categorised KNOWN_OUT
    regression fixture (a verified ~4% discrepancy in a 5-modifier stack —
    documented in the corpus test, asserted to stay out).
  - **J.4 ✅ shipped 2026-06-10.** Sim-generated ground truth: a known-sets
    battle plays in `@pkmn/sim`, its omniscient log (|split| private lines =
    exact HP, now handled by the parser) runs through the production pipeline
    with `inferSpreads` + seeded [true, decoys] candidates
    (`mySetFor`/`oppCandidatesFor` ingest options), and the true spread must
    survive every filter while the frail decoy narrows away. The blocking
    growth bug is FIXED at the root: `scoreOffensiveSpread` dedupes its EV
    sweep (sweep overwrites the swept stat → chained observations were pure
    duplicate multiplication). The 15-turn fixture in inferSpreads mode:
    88s → 182ms, candidate sets ≤5. `replay-roundtrip.test.ts` (3).

### Theme 5 — Ops: deploy validation + medium security

- **Operational validation of the deploy** (the one piece untested locally).
  Provision the Oracle Always-Free VM, run the real
  `docker compose -f docker-compose.prod.yml up --build` (first true test of the
  multi-stage image + alpine `tar` bundle step), point DNS, confirm Caddy issues
  a cert, have a friend `node tui/tui.mjs` against it end-to-end. Likely
  shakeout: arm64 `better-sqlite3` build on the A1 shape, `.env`/CORS origin,
  firewall. (Needs a manual `! gcloud`/`ssh`-style step from the user — flag it.)
- **Medium security items ✅ shipped 2026-06-11** (the old `security/hardening`
  branch is gone — implemented fresh on main): 4KB body limit on the
  credential endpoints; per-ACCOUNT login throttle (`auth/loginThrottle.ts` —
  10 fails/15min locks the account for 15min, complements the per-IP bucket an
  attacker defeats by rotating IPs; in-memory by design for the single-VM
  deploy); WS frames capped at 256KB (`maxPayload`); generic 5xx error handler
  (real error logged, constant body returned — no path/SQL leakage; 4xx
  messages pass through).

- **Deploy validation ✅ shipped 2026-06-11 (local end-to-end).** The exact
  prod compose stack ran locally: multi-stage image build (first true test of
  the alpine tar bundle step), Caddy TLS (internal CA for `localhost`) →
  server, /health + migrations, register/login/me, team CRUD, TUI bundle
  download with checksum verification + extraction + boot. **And it caught
  the exact class of bug it existed to find**: a named `server_data` volume
  predating the image mounts root-owned (volumes only inherit image ownership
  at first creation) → `SQLITE_CANTOPEN` crash-loop. Fixed in Dockerfile.prod
  with a root entrypoint that chowns /data then drops to `node` via su-exec.
  See DEPLOY.md §"Validated locally". What's left is strictly VM-specific
  (arm64 better-sqlite3 on the A1 shape, real-DNS Let's Encrypt, firewall) —
  the first real `docker compose up` on the box, with DEPLOY.md in hand.

### Theme 6 — TUI polish *(3 of 4 shipped 2026-06-11)*

- ✅ **Match-end summary completeness** — per-mon damage dealt/taken (from the
  quick-replay tallies), direct-KO credits (last-hit attribution from logged
  actions; EOT/hazard deaths uncredited by design), ⭐MVP tag on my top dealer.
- ✅ **Color-blind mode** — audited: the surfaces already encode by symbol +
  position, with colour as redundant emphasis (speed verdicts ✓/✗/≈/⚡/?,
  active mons ★m1/★m2 markers, KO/PAR½/status as text, verdicts spelled out
  next to their colour). No colour-only signal found; nothing to change.
- ✅ **Sticky preferences** — `storage/prefs.ts` sidecar (`data/prefs.json`,
  gitignored, best-effort IO): `/crit`, `/allmoves`, `/pika` persist across
  sessions.
- ✅ **Sprites in the matchup grid + info panel** (shipped 2026-06-11, built
  WITH the preview-first method the standing feedback prescribes): `/sprites`
  (sticky, default OFF) renders sixel sprites of the active opponents above
  the grid and in the opponent info panel. Pipeline: Showdown gen5 PNGs →
  dependency-free decoder (png.ts) → nearest-neighbour 2:1 downsample →
  indexed strip with shared palette → SixelImage. Mega/forme filenames via
  the dex baseSpecies-forme split; disk + memory cache.
  `scripts/preview-sprites.ts` is the iteration tool (validated 4/4 live,
  incl. Charizard-Mega-Y) — tune scale/layout there, then judge in-app.

### Theme 7 — Remaining search long-tail ✅ *(complete 2026-06-11)*

- ✅ Black Sludge in search (residualInfo: +1/16 Poison-types, −1/8 others,
  Magic Guard blocks the hurt).
- ✅ Grassy-terrain heal residual (was already shipped — stale entry).
- ✅ Booster Energy (Protosynthesis/Quark Drive): damage via the calc's
  `boostedStat` auto-derived in damage.ts (flows to search cells, predictions,
  inference, TUI alike); Spe ×1.5 in the search speed tables when Spe is the
  holder's strictly-highest stat.
- ✅ Disable root-carry: `match.myDisabledMove` → SearchMyMon.disabledMove →
  stripped from the set once in buildTables (opp side already rode the entry
  into predictions' pool filter). Torment/Imprison/Spite stay flagged — no
  live tracking exists to carry.
- ✅ Ability redirection: a live, KNOWN Storm Drain/Lightning Rod holder
  absorbs single-target Water/Electric moves at apply() (the tree then avoids
  them on its own); the +1 SpA gain is left unmodelled. Ally Switch/Spotlight
  stay informational — a slot-less model can't represent position shuffles.
- ✅ Spread debuffs (Growl/Leer/Tail Whip/String Shot) hit both live foes via
  the SET_DEBUFF path. Accuracy/evasion droppers stay excluded by the same
  policy as probabilistic accuracy itself (maximin never prices hit chance) —
  reworded as an informational flag.
- ✅ Yawn: delayed sleep as State.myYawn/oppYawn (2 on cast → sleeps at the
  end of the NEXT turn unless switched/statused; in ttKey; cleared on
  switch-in).

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
