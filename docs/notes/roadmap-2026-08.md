# PokeChamps roadmap — August 2026

> **Provenance.** Written 2026-08-01 from a three-way code audit (core engine ·
> TUI/vision/server/web · plan-docs vs implementations), verified against HEAD
> `794eb13`. Every item below was checked against the code that day — this doc
> supersedes the priority tiers of [`roadmap.md`](roadmap.md), which stays as
> the strategic/historical record. Baseline: **1471 tests / 127 files green**,
> Reg M-B, working tree clean.
>
> **Two standing exclusions:** the Switch-control output path
> (`packages/control`) is **permanently shelved** by user ruling (ToS/ban risk —
> the scaffold stays frozen, do not resume); and AI/LLM battle judgement remains
> opt-in-only per the standing AI-direction feedback.

## Audit headline

The code is ahead of the docs almost everywhere. `unmodeled.ts` — the
authoritative gap list — is down to **two deliberate policy rules**
(accuracy/evasion drops and confusion stay informational because maximin never
prices dice). The "open" lists in `mechanics-coverage.md`, `vision-plan.md`,
`ui-polish-plan.md`, `live-share-plan.md` and `endgame-search-plan.md` are all
stale in the code-is-further-along direction, with **one regression the docs
believe is shipped** (in-battle sprites, silently disabled). The last two weeks
of commits were entirely reactive to live ladder play (the perish-trap arc,
vision hardening); the training-data, creator-intel and team-composition plans
have been dormant.

What's genuinely open clusters into: one non-code top item (live shakeout), one
hard date (regulation rotation), a set of real engine approximations nobody
tracks, a built-but-unwired training pipeline, and cheap doc reconciliation.

---

## Tier 0 — top item + hard date

1. **Live ranked shakeout of the vision → engine pipeline** *(non-code, large)*.
   Named the top open item by both `roadmap.md` and `vision-plan.md`, and the
   pattern holds: every live session to date surfaced defects offline replay
   could not (latest fixes `d4a8e81`, `4807780`, `5750345`). Needs a real
   ranked session exercising the occupancy reconciler and the
   accept→auto-finalize path end-to-end. Claude's side: triage live, fix after.
2. **Regulation rotation — M-B ends Sept 2, 2026 (~4 weeks out)**. The runbook
   in `regulation-m-b.md` is proven and the tooling exists (`stage-roster`,
   `validate-format`, `refresh-data`, `refresh-pikalytics`, `tactics-catalog`);
   block the switch-day time. Known live risk to watch before then: the
   Pikalytics `/ai` export layout has already degraded once — no monitoring
   exists for a third change. *(small per step, scheduled)*

## Tier 1 — quick wins (small, unblocked, high leverage)

Everything here is glue or a rerun on top of already-shipped machinery.

3. **Wire `bringWinProb` into the BringPicker** as an opt-in advisory column —
   the whole training pipeline (playouts → `bring-value-model.json` → CLI
   consumers) is built and the product never shows it. *(small-medium)*
4. **Retrain the bring-value model against the real team** — it was trained
   2026-06-29 on `anti-meta-mb` playouts; the shipped team is
   `TalonFlameAndyBoy`. Regenerate `bring-guide` + prep sheets at the same
   time (both still name the old team). *(small)*
5. **Run the creator-intel pipeline once** — increments 1-2 are shipped but
   `data/threats/` and `data/captions/` are empty; a single run gives the
   gauntlet its `[creator]` source for free. *(small)*
6. **Backfill the 6 crop-less sprite refs** (`arcanine, azumarill, florges,
   gholdengo, meowscarada, zoroarkhisui`) — `readOppTeam` gates on
   `verified: true`, so they're dead refs today. *(small)*
7. **"Trapper left the field" alert** — the playbook's single biggest practical
   gain from the perish arc: when the trapper leaves, Shadow Tag lifts and you
   can switch NOW. Vision reads the perish clock already; the alert is missing.
   *(small)*
8. **`scoreBrings` weather-cell corrections** — known mis-picks vs Swampert
   (leaves Meowscarada home) and Ninetales (force-drops Garchomp); the Nash
   sheet path compensates but the heuristic itself is wrong. A targeted rule,
   per the playbook. *(small)*

## Tier 2 — regressions + untracked engine gaps

9. **Unbreak in-battle sprites** — `BattleScreen.tsx:801` hard-codes
   `showSprites = false` (sixel strips glitched on every keystroke while
   typing). All infra is intact; `/sprites` is a no-op. Fix is a
   render-throttle / memoised strip, then re-enable. `roadmap-2026-06.md`
   Theme 6 wrongly says this shipped. *(medium)*
10. **/exact oracle drops state** — `SimSlotState` is `{hpPct, status, boosts}`
    and `SimField` `{weather, terrain}` only (`simBridge.ts:72-97`). No
    hazards, screens, Tailwind, Trick Room, Substitute HP,
    Taunt/Encore/Disable, sleep/toxic counters, Leech Seed, perish counts,
    item-consumed state, or the Rage Fist `timesHit` counter. The fast search
    models all of these; the "ground truth" oracle silently resolves a partial
    board. Both audits flagged this independently; it was undocumented.
    *(medium-large — plumb the state through `simBridge` + injection)*
11. **/exact Rage Fist divergence** — the vendored `@pkmn/sim` persists the
    counter across switches; Champions M-B resets it (engine/calc/search all
    reset). Needs a local sim mod or a documented exclusion, plus a warning
    comment in `simOracle.ts` (the caveat lives only in
    `champions-custom-data.md:122`). *(medium)*
12. **/exact board shapes** — only full 2v2 and true 1v1 load; a "one active +
    live bench" 2v1 refuses (`simOracle.ts:118-128`). *(medium)*
13. **Small real search gaps** (each verified absent by grep, none flagged by
    `unmodeled.ts`): absorb-ability heal (Water/Volt Absorb, Sap Sipper — calc
    gives 0 damage, the 25% heal is missing); Storm Drain/Lightning Rod +1 SpA
    on absorb; residual passives Curse/Nightmare/Ingrain/Aqua Ring;
    boost-berries (Liechi/Petaya/Salac); Mental Herb; Zero-to-Hero;
    same-turn dynamic terrain for priority (switch-in sets Grassy, partner
    Grassy Glides — priority reads root state). *(small each)*
14. **Phantom mega-evolution in the search** — an unrevealed opponent switch-in
    that would mega is under-rated; `phantom` gating covers material only,
    never mega candidacy. *(small-medium)*
15. **Damage-layer approximations worth a decision** (fix or codify as policy):
    multi-hit rolls treated as perfectly correlated (`damage.ts:240`); Mega Sol
    sun-forcing strips the defender's real-weather boost in that one calc
    (`damage.ts:147`); pinch-berry ~5% threshold (`hpItemTriggers.ts:63`).
    *(small each)*

## Tier 3 — inference + search quality (medium efforts)

16. **Joint inference wiring** — `jointSolve` is shipped + tested but
    `refineCandidates` (`inference.ts:842`) is dead code; live mirrors use
    `reconcileCandidates`. Blocker: feedback isolation (re-seeding the
    sequential sweep destabilised the J.4 round-trip). Wire display-only
    first, J.4 as the regression gate. Standing ruling: stat-point ranges stay
    the live mechanism until this proves stable. *(medium)*
17. **Confidence-adaptive search breadth** — widening exists but is driven by
    board width only; "smaller as inference narrows" (`endgameSearch.ts:5229`)
    is unbuilt. *(small-medium)*
18. **Offensive crit pass** — the deferred half of crit-out: crit lets *my*
    needed KO land (crit-augmented optimistic pass), priority-aware crit
    ordering, speed-tie halving. *(medium)*
19. **Mega as a non-root decision** — mega commits at the search root; a future
    switch-in can't plan to mega (`endgameSearch.ts:5287`). *(medium)*
20. **Sim-diff harness: switches + status lines** — the harness drives
    best-damage attacks (+Protect) only; no switches (positions have no
    bench), no sleep/redirection/pivot/setup coverage. Needs a new position
    generator. *(medium-large)*
21. **Search levers named in the plan, still open**: root-move min/max damage
    bracketing (cells collapse to `dmgMid`); cross-pass TT incrementality
    (depth is baked into `ttKey`); root duplicate-option dedup. *(medium /
    medium / small)*
22. **Mixed-strategy refinement in the tree** — the plan's trigger ("if maximin
    proves too pessimistic") is arguably met: the playbook records Nash floors
    of 26% and 19% converting to ~even-or-better under best play. Nash exists
    only at the bring layer today. *(large — flag for an explicit go/no-go)*

## Tier 4 — vision (calibration + data grind)

23. **Meta sprite gaps ×4** — Annihilape, Corviknight, Glimmora, Tsareena
    (44/48 meta covered; all four have rejected or failed VODs — needs new
    sources, not code). **Regional formes 3/17**, most wanted **Raichu-Alola**
    (the M-B headline mega base). Unprocessed VOD queue sits at the bottom of
    `harvested-vods.md`. Shiny variants mismatch the histogram by construction
    — store `id + isShiny` refs. *(grind, ongoing)*
24. **Wire + calibrate `bringRead.ts`** — the player-bring reader is built and
    exported but uncalibrated and consumed by nothing; the "zero-typing bring"
    win is unrealised. *(medium)*
25. **Calibrate `statusIcon` + `moveMenu` regions** — zero-rects today
    (`regions.ts:197-218`); status only ever arrives via banner grammar.
    *(medium)*
26. **Fragility hardening (opportunistic)** — crop alignment ±6px sensitivity;
    my-side digit garbling at inset scale silently falls back to the bar read;
    partial proposals aren't ratifiable mid-turn. *(small each)*

## Tier 5 — TUI + server polish

27. **Replay predictions overlay** — `MatchHistory` replay is solid (scrub,
    autoplay, exact HP bars) but has no inference/matchup layer ("what the
    engine would have advised per turn"). *(medium)*
28. **Resize-awareness beyond BattleScreen/MatchHistory** — the other ~10
    screens ignore terminal size. *(small per screen)*
29. **Server: validate remote turns server-side** — PATCH `/matches/:id` is a
    full blob replace that trusts the client (`matches.ts:131`); route
    remote-mode turns through `/turns` re-validation. Echoed independently in
    `live-share-plan.md`. *(medium-large)*
30. **Small:** prefs breadth beyond BattleScreen (last team, watcher default);
    sleep-wake override affordance; Pikalytics cache TTL sweep; redacted
    spectator view (full-view today is deliberate); web `App.tsx` component
    split. *(small each)*

## Tier 6 — team + training arcs (large, strategic)

31. **The bulky-rain (Swampert) breaker hunt** — the one honestly-measured
    structural hole in `rain-mb-final` (a true 0/4; banked 2026-07-02): wants
    a breaker that isn't Ice-4×-frail and doesn't fold to Intimidate, or a
    second win condition that isn't Dragonite. Team-search compute + gauntlet
    validation. The Ninetales soft spot, by contrast, is **closed by decision**
    (piloting guidance; "the team is a tight optimum"). *(large)*
32. **Training-data arc, next real increments** (pipeline through the logistic
    bring-value model is DONE; Tier 1 items 3-4 are its cheap wins):
    `ObservedState`/`DecisionRecord` schema + `projectMatchState()` (zero hits
    repo-wide); match-snapshot + vision-sourced rows (exporter reads replay
    dirs only); Task B (learned move-ordering prior) and Task C (learned
    spread prior); corpus growth past 204 games; a written privacy/scope note
    for first-party `matches/` data. *(large; opt-in and side-by-side with the
    engine per the standing AI posture)*
33. **Creator-intel increments 3-5** — inc 3 is pure glue (vision
    `oppTeamRead` → `creator-intel.ts`, both halves shipped); inc 4 (LLM
    piloting extraction to `leads`/`gamePlan`/`tech`) touches the AI opt-in
    posture — get an explicit go/no-go before building; inc 5 is small once 4
    exists (`makePilotPolicy` already takes a plan). *(small-medium / medium /
    small)*

## Tier 7 — doc + repo hygiene (do early, it's cheap)

34. **Reconcile `mechanics-coverage.md`** against `unmodeled.ts` — ~19 matrix
    rows claim GAP/PARTIAL for mechanics the search closed (Yawn, Wish, Future
    Sight, recharge, Counter, Disable/Torment/Imprison, Magic Bounce,
    Disguise/Ice Face, Booster Energy, Black Sludge, Spotlight, …). Misleading
    enough to cause wasted work. *(small-medium)*
35. **Stale-doc sweep** — `vision-plan.md` (Wide/Quick Guard shipped `7cc95cf`;
    131 not 90 refs; UVC stub is deliberate-permanent), `ui-polish-plan.md`
    (§3 shipped, §4 half, §5 partial), `live-share-plan.md` (Phase D 2-of-3
    built), `endgame-search-plan.md` ("deferred: pivot moves / sleep" is now
    false — both shipped), `roadmap.md` pillar-status block,
    `roadmap-2026-06.md` Theme 6 sprite claim, `training-data-plan.md` +
    `future-directions.md` §1 status blocks (the playout pivot superseded
    them). *(small)*
36. **Stale in-code comments** — `hpRead.ts:14`, `visionSource.ts:4`,
    `assemble.ts:13-16`, `web/App.tsx:1-4`, `server/routes/shares.ts:10-13`,
    duplicated trustProxy block `app.ts:51-59`. *(trivial)*
37. **Script pruning** — delete the 8 `_`-prefixed dead repros; archive ~25
    completed one-off investigation scripts; note that `mb-explore-megas.ts`
    output is untrustworthy until its placeholder abilities are emulated.
    *(small)*

## Deliberate non-goals (unchanged)

- Switch-control hardware/live-send — **permanently shelved (ToS)**.
- Probabilistic secondaries in the maximin decision rule (flinch, 33%
  confusion self-hit, full-para, acc/eva) — informational by policy.
- Spite/PP tracking — unreachable inside a bounded horizon, by design.
- Tera/Z/Dynamax gimmicks — scaffolds exist; wait for a regulation rotation.
- GPU search phase — shelved by measurement (2026-06-06); do not resurrect
  without new numbers.
- Mobile/web expansion, tournament tooling — out of scope.
