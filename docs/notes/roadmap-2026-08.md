# PokeChamps roadmap — August 2026

> **Provenance.** Written 2026-08-01 from a three-way code audit (core engine ·
> TUI/vision/server/web · plan-docs vs implementations), verified against HEAD
> `794eb13`; re-tiered same day per user rulings. Supersedes the priority tiers
> of [`roadmap.md`](roadmap.md), which stays as the strategic/historical record.
> Baseline: **1471 tests / 127 files green**, Reg M-B, working tree clean.
>
> **User rulings 2026-08-01 (steer everything below):**
> - **The two biggest gaps are BRING PICKING and BEST-MOVE SUGGESTIONS.** They
>   are Focus A and Focus B; everything else is supporting cast.
> - **Sixel in-battle sprites are DROPPED by decision** — fun, but in the way of
>   a decent TUI. Not a regression to fix; the disabled infra can be deleted.
> - **The live ranked shakeout is deferred until much later.** It stays the
>   right validation step but is parked, not queued.
> - Standing exclusions: the Switch-control output path is **permanently
>   shelved** (ToS/ban risk — scaffold frozen, do not resume); AI/LLM battle
>   judgement stays opt-in-only.

## Audit headline

The code is ahead of the docs almost everywhere. `unmodeled.ts` — the
authoritative gap list — is down to **two deliberate policy rules**
(accuracy/evasion drops and confusion stay informational because maximin never
prices dice). The "open" lists in `mechanics-coverage.md`, `vision-plan.md`,
`ui-polish-plan.md`, `live-share-plan.md` and `endgame-search-plan.md` are all
stale in the code-is-further-along direction. The last two weeks of commits
were entirely reactive to live ladder play (the perish-trap arc, vision
hardening); the training-data, creator-intel and team-composition plans have
been dormant — which is exactly where the bring-picking gap lives.

---

## Focus A — bring picking

The pipeline that would make bring picking good is **built and unwired**: the
picker still runs the hand-rolled heuristic while the playout/value machinery
sits unused in CLI scripts.

1. **Retrain the bring-value model against the real team** — it was trained
   2026-06-29 on `anti-meta-mb` playouts; the shipped team is
   `TalonFlameAndyBoy`. `gen-playout-data.ts` + `sim-playout-validate.ts`
   hardcode the old team; the `bring-guide` and `data/prep/` sheets name it
   too. Repoint, replay, regenerate. *(small — compute time, not code)*
2. **Wire `bringWinProb` into the BringPicker** as an opt-in advisory column —
   `bringWinProb` / `bringModelAvailable` are consumed only by CLI scripts
   today; the product never shows them. *(small-medium)*
3. **`scoreBrings` weather-cell corrections** — known mis-picks vs Swampert
   (leaves Meowscarada home) and Ninetales (force-drops Garchomp); the Nash
   sheet path compensates but the heuristic is wrong. Targeted rule, or
   re-derive those cells from the Nash matrix. *(small)*
4. **Run the creator-intel pipeline once** — increments 1-2 are shipped but
   `data/threats/` and `data/captions/` are empty; a single run feeds the
   gauntlet its `[creator]` opponent source. Then increment 3 (glue the shipped
   vision `oppTeamRead` into `creator-intel.ts`) widens the intake.
   *(small, then small-medium)*
5. **Grow the corpus + fidelity** — 204 games in `data/replays-train`;
   match-snapshot and vision-sourced rows are speced but no exporter path
   produces them (`export-training.ts` reads replay dirs only). *(medium,
   grind)*
6. **The Swampert hole** — bring picking can't fix a roster gap: bulky rain is
   an honestly-measured 0/4 (banked 2026-07-02). The breaker hunt (not
   Ice-4×-frail, doesn't fold to Intimidate, or a second win condition that
   isn't Dragonite) is the one structural team change worth compute. *(large)*

## Focus B — best-move suggestions

Two halves: make the fast search's calls sharper, and make `/exact` — the
ground-truth check on a call — actually resolve the full board.

> **⚡ Performance requirement (user, 2026-08-01, from live play): the live
> search is too slow — two deepening iterations consume half the turn timer.
> Target: reach depth ≥4 comfortably inside the turn, because depth 4 is the
> Perish Song horizon (cast → three ticks) and anything shallower can't see the
> trap resolve.** The audit already named the levers, in likely-payoff order:
> **cross-pass TT reuse** (depth is baked into `ttKey`, so every deepening pass
> re-searches the whole tree from scratch — switch gating by depth-remaining
> would let pass N+1 start from pass N's work); **confidence-adaptive breadth**
> (item 8 — shrink `spreadK`/switch width as inference narrows instead of
> paying full width every ply); **root duplicate-option dedup**; plus a fresh
> profile of matrix building vs tree walk before touching anything (the
> mon-keyed cell cache exists — verify it's actually hitting live). Treat
> depth-4-in-time as the acceptance test for all of it.

**Sharpen the search:**

7. **Joint inference wiring** — narrower opponent spreads mean truer damage
   cells mean better calls. `jointSolve` is shipped + tested but
   `refineCandidates` (`inference.ts:842`) is dead code; live mirrors use
   `reconcileCandidates`. Blocker: feedback isolation (re-seeding the
   sequential sweep destabilised the J.4 round-trip). Wire display-only first,
   J.4 as the regression gate. Standing ruling: stat-point ranges stay the
   live mechanism until this proves stable. *(medium)*
8. **Confidence-adaptive search breadth** — widening exists but is driven by
   board width only; "smaller as inference narrows" (`endgameSearch.ts:5229`)
   is unbuilt. Directly buys depth on the positions that matter. *(small-medium)*
9. **Offensive crit pass** — the deferred half of crit-out: crit lets *my*
   needed KO land, priority-aware crit ordering, speed-tie halving. *(medium)*
10. **Phantom mega-evolution** — an unrevealed opponent switch-in that would
    mega is under-rated; phantom gating covers material only. *(small-medium)*
11. **Mega as a non-root decision** — mega commits at the search root; a future
    switch-in can't plan to mega (`endgameSearch.ts:5287`). *(medium)*
12. **Small real search gaps** (verified absent by grep, unflagged by
    `unmodeled.ts`): absorb-ability heal (Water/Volt Absorb, Sap Sipper);
    Storm Drain/Lightning Rod +1 SpA; residual passives
    Curse/Nightmare/Ingrain/Aqua Ring; boost-berries (Liechi/Petaya/Salac);
    Mental Herb; Zero-to-Hero; same-turn dynamic terrain for priority.
    *(small each)*
13. **"Trapper left the field" alert** — the perish arc's biggest practical
    gain: when the trapper leaves, Shadow Tag lifts — say "you can switch
    NOW". Vision already reads the perish clock. *(small)*
14. **Search levers from the plan** — root-move min/max damage bracketing
    (cells collapse to `dmgMid`); cross-pass TT incrementality; root
    duplicate-option dedup. *(medium / medium / small)*
15. **Mixed-strategy refinement** — the plan's own trigger ("if maximin proves
    too pessimistic") is arguably met: the playbook records Nash floors of 26%
    and 19% converting to ~even under best play. Needs an explicit go/no-go
    before the large build. *(large)*

**Make `/exact` honest** (it's the verification layer for move calls):

16. **Plumb full state through `simBridge`** — `SimSlotState` is
    `{hpPct, status, boosts}` + `{weather, terrain}` only: hazards, screens,
    Tailwind, Trick Room, Substitute HP, Taunt/Encore/Disable, sleep/toxic
    counters, Leech Seed, perish counts, item-consumed state and `timesHit`
    are all silently dropped. Both audits flagged it independently.
    *(medium-large)*
17. **Rage Fist divergence** — the vendored `@pkmn/sim` persists the counter
    across switches; Champions resets (our engine/calc/search all reset).
    Local sim mod or documented exclusion, plus a warning comment in
    `simOracle.ts` (the caveat lives only in `champions-custom-data.md:122`).
    *(medium)*
18. **Board shapes** — only full 2v2 and true 1v1 load; a "one active + live
    bench" 2v1 refuses (`simOracle.ts:118-128`). *(medium)*
19. **Sim-diff harness: switches + status lines** — the divergence harness
    drives best-damage attacks (+Protect) only; no switches (positions have no
    bench), no sleep/redirection/pivot/setup. Needs a new position generator
    to measure what Focus B actually fixed. *(medium-large)*

## Hard date — regulation rotation

20. **Reg M-B ends Sept 2, 2026 (~4 weeks).** The runbook in
    `regulation-m-b.md` is proven; the tooling exists (`stage-roster`,
    `validate-format`, `refresh-data`, `refresh-pikalytics`,
    `tactics-catalog`). Block the switch-day. Watch item: the Pikalytics `/ai`
    export layout has degraded once already; no monitoring exists for a third
    change. *(small per step, scheduled)*

## Parked

- **Live ranked shakeout** — deferred until much later by user ruling. Still
  the right end-to-end validation of vision + engine when it happens; every
  prior live session surfaced defects offline replay could not.

## Supporting — vision data (feeds bring picking via team reads)

21. **Meta sprite-ref gaps ×4** — Annihilape, Corviknight, Glimmora, Tsareena
    (44/48 meta; all four need new VOD sources). **Regional formes 3/17**,
    most wanted **Raichu-Alola** (the M-B headline mega base). Backfill the
    **6 crop-less refs** (`arcanine, azumarill, florges, gholdengo,
    meowscarada, zoroarkhisui`) — `readOppTeam` gates on `verified: true`, so
    they're dead today. Shinies mismatch the histogram by construction — store
    `id + isShiny`. *(small each, grind; these are the colour-histogram ID
    refs, NOT the dropped display sprites)*
22. **Wire + calibrate `bringRead.ts`** — the player-bring reader is built,
    exported, uncalibrated, and consumed by nothing; the "zero-typing bring"
    win is unrealised. *(medium)*
23. **Calibrate `statusIcon` + `moveMenu` regions** — zero-rects
    (`regions.ts:197-218`); status only ever arrives via banner grammar.
    *(medium)*
24. **Fragility hardening (opportunistic)** — ±6px crop sensitivity; my-side
    digit garbling silently falls back to the bar read; partial proposals
    aren't ratifiable mid-turn. *(small each)*

## Supporting — TUI + server polish

25. **Replay predictions overlay** — replay is solid (scrub, autoplay, exact HP
    bars) but shows no "what the engine would have advised per turn" layer —
    directly serves Focus B as the offline review loop. *(medium)*
26. **Resize-awareness beyond BattleScreen/MatchHistory** — the other ~10
    screens ignore terminal size. *(small per screen)*
27. **Server: validate remote turns server-side** — PATCH `/matches/:id` is a
    full blob replace trusting the client (`matches.ts:131`). *(medium-large)*
28. **Small:** prefs breadth beyond BattleScreen; sleep-wake override
    affordance; Pikalytics cache TTL sweep; redacted spectator view; web
    `App.tsx` component split. *(small each)*

## Hygiene (cheap, do opportunistically)

29. **Delete the dead sprite-display path** — `showSprites` is hard-false and
    the feature is now dropped by decision: remove `spriteCache`,
    `spriteStrip`, `SixelImage`/`HalfBlockImage` usage in BattleScreen and the
    `/sprites` no-op (the Pika spinner and sixel preview can stay). *(small)*
30. **Reconcile `mechanics-coverage.md`** against `unmodeled.ts` — ~19 matrix
    rows claim GAP/PARTIAL for closed mechanics. *(small-medium)*
31. **Stale-doc sweep** — `vision-plan.md` (Wide/Quick Guard shipped; 131 not
    90 refs; UVC stub deliberate-permanent), `ui-polish-plan.md`,
    `live-share-plan.md` (Phase D 2-of-3 built), `endgame-search-plan.md`
    ("deferred: pivot/sleep" now false), `roadmap.md` pillar block,
    `roadmap-2026-06.md` Theme 6 (sprites now DROPPED, not shipped),
    `training-data-plan.md` team-target note ✅ done 2026-08-01. *(small)*
32. **Stale in-code comments** — `hpRead.ts:14`, `visionSource.ts:4`,
    `assemble.ts:13-16`, `web/App.tsx:1-4`, `server/routes/shares.ts:10-13`,
    duplicated trustProxy block `app.ts:51-59`. *(trivial)*
33. **Script pruning** — delete the 8 `_`-prefixed dead repros; archive ~25
    completed one-off investigation scripts; `mb-explore-megas.ts` output
    untrustworthy until its placeholder abilities are emulated. *(small)*
34. **Training-data larger increments** (behind Focus A's quick wins):
    `ObservedState`/`DecisionRecord` schema + `projectMatchState()`; Task B
    (learned move-ordering prior) / Task C (learned spread prior); a written
    privacy/scope note for first-party `matches/` data. *(large; opt-in and
    advisory per the standing AI posture)*

## Deliberate non-goals (unchanged + new)

- **In-battle sixel sprites — dropped by decision 2026-08-01** (in the way of a
  decent TUI). The vision colour-histogram refs are unrelated and stay.
- Switch-control hardware/live-send — **permanently shelved (ToS)**.
- Probabilistic secondaries in the maximin decision rule — informational by
  policy (flinch, confusion, full-para, acc/eva).
- Spite/PP tracking — unreachable inside a bounded horizon, by design.
- Tera/Z/Dynamax gimmicks — scaffolds exist; wait for a regulation rotation.
- GPU search phase — shelved by measurement (2026-06-06).
- Mobile/web expansion, tournament tooling — out of scope.
