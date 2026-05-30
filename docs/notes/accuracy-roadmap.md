# Accuracy roadmap

**Last updated 2026-05-29.** A tactical breakdown of correctness gaps and the order to close them. Complements [`roadmap.md`](roadmap.md) (strategic / pillars) — this doc is purely about **damage / state / prediction fidelity**.

## What we mean by "accurate"

Five axes of correctness, in rough order of how often a gap *visibly* misleads the user:

1. **Damage calculation** — every move's `damageRange` matches the canonical formula (@smogon/calc), with our overrides for format-custom mechanics the calc doesn't know.
2. **State tracking** — turn-by-turn residuals, auto-applied move/ability effects, status, boosts, items consumed/replaced. The match snapshot should converge with the real game state without the user logging every micro-effect.
3. **Inference (spread/EV/nature/item/ability)** — narrowed by observations, honest about uncertainty, commits only on strong evidence.
4. **Speed / dynamic speed** — Gen 9 dynamic-speed reconstruction, intra-turn changes, TR last.
5. **Lookahead search** — the action space and residual-aware turn simulation behind the recommended play.

## Recently shipped (this arc)

**Damage:** custom mega abilities applied in the calc (Tough Claws / Aerilate / Mega Launcher / Pixilate / Adaptability / Filter / Thick Fat / Multiscale / Technician etc.); Mega Sol emulated as personal sun; multi-hit moves total per-hit rolls × `move.hits` (Dual Wingbeat etc. were undercounted app-wide).

**State:** Leech Seed residual (drain + heal, clears on switch-out); drain-move self-heal (Giga Drain / Drain Punch / …); move self-stat drops (Overheat / Leaf Storm / Draco Meteor / Close Combat / Hammer Arm — Contrary inverts); Spicy Spray on-hit burn (defender ability resolved through mega).

**Inference:** offensive-EV inference (`scoreOffensiveSpread`) — Atk/SpA inferred from opp hits on my known mons, pruning natures/items that can't reach the damage; nature promotion on extreme hit; speed → EV/+Speed-nature commit when scarf is ruled out.

**Search:** three damage regimes + survival items (`forced` requires worst-case rolls + Sash/Sturdy + all 4 revealed + worst opp mega); empirical KO probability (pooled across candidate spreads × rolls); concrete bench switch-in named in risks.

**Speed:** Gen 9 dynamic-speed inference (per-action effective speed, intra-turn Tailwind reconstruction, TR-resolves-last); already-mega'd mon at mega speed.

---

## Tier 1 — Quick wins (low-medium effort, broad impact)

Deterministic Bulbapedia effects we can auto-apply alongside the existing `finalizeTurn` loops in `engine.ts` + `BattleScreen.tsx`. Each is ~1 file change + dual-mirror + test.

| Item | Source | Notes |
|---|---|---|
| **Status moves auto-apply status** | move dex `status` field | Will-O-Wisp → brn, Thunder Wave → par, Sleep Powder → slp, Toxic → tox, Glare, Nuzzle, Spore. Mirror the move-self-drops pattern. Skip if target already non-volatile statused; respect type immunities (Fire→brn, Electric→par, Grass→powder, Ghost→Tox if non-Poison). |
| **Setup self-boost moves** | move dex `boosts` | Swords Dance / Nasty Plot / Calm Mind / Dragon Dance / Bulk Up / Iron Defense / Coil / Quiver Dance / Shell Smash. Apply on use (no damage required). Current self-drop code is damage-gated; add a parallel "status self-boost" path for moves with `target:'self'` and `boosts`. |
| **Recoil moves** | move dex `recoil`/`mindBlownRecoil` | Brave Bird / Wood Hammer / Flare Blitz / Double-Edge / Head Smash / Wild Charge / Light of Ruin / Mind Blown / Steel Beam. Apply recoil to user's HP after damage. Rock Head ability blocks. |
| **Toxic / Flame Orb auto-status** | item EOT | Toxic Orb → tox, Flame Orb → brn at EOT for the holder. Skip Magic Guard / type-immune (Fire→Flame Orb is wasted; Steel/Poison can be Tox'd by Toxic Orb; Fire-immune to brn). |
| **Berry auto-consume thresholds** | item triggers | Sitrus <50% → heal 25%; Salac/Liechi/Petaya/Ganlon/Apicot in pinch (25%) → +1 to relevant stat; Lum cures status; Figy/Mago/etc. heal 33% (confuse on +Atk dislike). |
| **Other residuals** | move/ability | Aqua Ring +1/16 EOT; Ingrain +1/16; Curse −1/4 EOT (the user that used it); partial-trap chip (Bind/Wrap/Fire Spin: 1/8 over 4-5 turns); Salt Cure (1/8, 1/4 vs Water/Steel); Nightmare. |
| **Regenerator on switch-out** | ability | Common in Champions (Tangrowth-like). Heal +1/3 on switch-out via the existing switch-out cleanup hooks. |
| **On-hit chip abilities** | defender ability | Rough Skin / Iron Barbs / Aftermath (KO only) — deterministic; mirror Spicy Spray. |
| **Liquid Ooze** | defender ability | Reverses drain — attacker loses HP instead. Plumb into the drain block. |
| **Bad Dreams, Dry Skin, Solar Power, Rain Dish, Ice Body, Snow Cloak (defensive)** | abilities | EOT chip/heal under matching weather/state. |
| **Bag/permanent items mod**: Heavy-Duty Boots already in hazards; verify Air Balloon, Eject Pack, Red Card, Weakness Policy auto-effects | items | Each one-off but cumulatively important. |

**Sequencing:** start with status moves + setup boosts (biggest day-to-day visibility), then recoil, then EOT/berry, then on-hit chip abilities.

## Tier 2 — Medium-effort accuracy gains

| Item | Why it matters |
|---|---|
| **Format-custom non-mega abilities audit** | We catalogued the 17 mega abilities (15 standard, 2 custom: Spicy Spray, Mega Sol). The Champions format may also invent **non-mega** custom abilities. Plan: scan `data/abilities.json` for entries marked custom / missing from `@smogon/calc`, audit each for damage relevance, add gimmick or calc hooks as needed. (Same audit for `items.json`, `moves.json`.) |
| **Substitute mechanics** | Costs 25% HP, blocks status + secondaries + boost decrements + Leech Seed application; transparent to damage but a substitute mon's HP/status reads differ. Visible state, not just calc. |
| **Magic Bounce / Magic Coat** | Reflects status moves — Will-O-Wisp/T-Wave/Toxic bounce back. Affects Spicy Spray's burn-back chain too. |
| **Magic Guard** | Blocks all indirect damage (status chip, hazards, Leech Seed, recoil, life orb). Common ability — a big residual filter. |
| **Joint nature/item/EV inference** | Currently sequential: defensive scoreSpread → offensive scoreOffensiveSpread → speed commit. A joint solve would reduce conflicts (e.g., offensive nature change invalidating defensive observations). Higher accuracy at moderate cost. |
| **Ability inference from observations** | Today we mostly take the Pikalytics top ability; only Sturdy/Spicy Spray etc. get reasoned about implicitly. Could narrow: e.g., a fast turn-1 reveals not-Truant, observed neutral damage rules out Levitate vs Ground, paralysis-immune-on-hit reveals not Limber, Hydration in rain clears status etc. |
| **Multi-hit variable-range** | @smogon/calc averages at 3 hits (or 5 with Skill Link). Distributional per-hit-count would tighten KO odds for Bullet Seed / Rock Blast / Triple Axel / Icicle Spear / Population Bomb. |
| **Choice item lock enforcement** | We track `choiceLock` for display; the predictor should also gate the choice-locked mon's move selection in the matchup grid + search until the lock breaks. |
| **Booster Energy / Quark Drive / Protosynthesis** | Boost-on-condition; in Champions presumably handled by calc, but verify the +30%/+50% boost is in play across our path. |
| **Trick Room ability triggers** | Indeedee / others; mostly via switch-in ability triggers (already partial). |

## Tier 3 — Larger pieces (Phase-2 search expansion)

Each of these is its own multi-commit project and changes the **lookahead search's action space**, not just turn-tracking.

1. **Non-damaging actions in the search** — speed control (Tailwind / Trick Room / Icy Wind / Thunder Wave); Protect / redirection (Follow Me / Rage Powder); setup (Swords Dance etc.). Per the earlier user prio: speed-control + Protect/redirection first. Requires state evolution across simulated turns (boost stages, decrementing field counters, status) and dynamic-speed re-sort after each action.
2. **Opponent switch modeling** — add a "switch to bench mon" action to the maximin; include benched mons in the search state; model switch-in damage (Intimidate, hazards, Stealth Rock chip). Today the bench is only an *informational* risk; this would let the search actually consider their pivots.
3. **HP-triggered decision points** in the simulated tree — Salac speed boost at low HP, berry heal at <50%, Sash threshold, Multiscale at full HP — so the search picks the right line through them.
4. **Strategic refill heuristic** — current refill brings in the highest-damage benched mon; could pick by survivability vs the line's likely incoming damage.

## Tier 4 — Edge cases (often deliberately skipped)

| Item | Why we skip |
|---|---|
| **Probabilistic secondary effects** (Flamethrower 10% brn, Energy Ball 10% −1 SpD, Scald 30% brn) | Auto-applying would corrupt state when the roll didn't proc. User logs status manually if it lands. Honest behaviour. |
| **Counter / Mirror Coat / Metal Burst** | Reactive moves; rare in VGC; not worth the search-side complexity until requested. |
| **Pursuit** (catches switching mons for 2× damage) | Cute but rare; needs switch-modeling first anyway. |
| **Lock-On / Mind Reader** (guarantee next hit) | Rare. |
| **Multi-turn locked moves** (Outrage / Thrash / Petal Dance) — locks for 2-3 turns then confuses self | Would need lock state + confusion model; rare. |
| **Future Sight / Doom Desire** — delayed damage 2 turns later | Niche; needs delayed-action queue. |
| **Wish / Healing Wish / Lunar Dance** | Wish is in some support sets; small follow-on. |
| **Bide / Sleep Talk / Snore / Metronome** | Edge utility. |

## Format-custom audit (one-off survey)

Before the bigger pieces it's worth a one-shot **catalog of all format-custom data** so we know what calc-engine doesn't model:

1. **Abilities** — diff `data/abilities.json` against standard Gen 9. For each Champions-custom ability: classify (offensive damage / defensive / on-hit / EOT / weather / speed / switch-in) and decide handling — calc hook (if damage-affecting) vs engine state (if residual) vs none (cosmetic).
2. **Items** — diff `data/items.json`. Same triage.
3. **Moves** — diff `data/moves.json`. Same.
4. **Mega formes** — already done (17 megas: 15 standard, Spicy Spray + Mega Sol custom).

Output: a `docs/notes/champions-custom-data.md` listing every custom entry, its effect, and whether our code respects it. Then crank through the calc-engine gaps surfaced.

## Sequencing recommendation

1. **Tier 1 quick wins** (one PR each, dual-mirror + tests). Stop at any time — each commit independently raises accuracy.
2. **Format-custom audit** (one focused PR). Produces a punch-list.
3. **Tier 2 medium work**, driven by the audit's findings + Substitute / Magic Bounce / Magic Guard.
4. **Tier 3 search expansion** — staged: speed-control + Protect first, then opponent switching, then HP-triggered points. Each is a multi-week effort.

Probabilistic secondaries (Tier 4 line 1) stay deliberately not-auto-applied.

## How to keep accuracy improving over time

- The **end-to-end battle-validation harness** described in [`roadmap.md`](roadmap.md) (Showdown replay corpus, consistency vs containment) is the long-run safety net. As Tier 1/2 ship, plug those move/ability effects into the harness so regressions trip a test.
- **CI bulbapedia spot-checks** — keep adding precise-numbers tests like the multi-hit-totals + Tough Claws + Thick Fat + Mega Sol tests for any new ability/move we wire. Each one locks in a Bulbapedia equality.
