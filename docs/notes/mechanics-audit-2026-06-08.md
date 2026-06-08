# Mechanics audit — 2026-06-08 (unattended deep pass)

Goal: find gaps **within the codebase** and **vs authoritative rules** (Bulbapedia /
Serebii / Pokémon Showdown sim source). Scope (per user): damage & calc accuracy,
mechanics coverage, type chart & interactions, Reg M-A legality. The existing
[`mechanics-coverage.md`](mechanics-coverage.md) + [`sim-divergences.md`](sim-divergences.md)
already track the *search-layer* gaps well; this pass focuses on **verifying** their
claims against the sources and on what the code implements *directly* (constants,
type chart, emulated mega abilities, legality data) where the calc can't catch it.

Method: each finding tagged severity (🔴 bug / 🟠 likely-wrong / 🟡 minor-or-approx /
🟢 verified-correct), with the source checked and a recommended fix. Safe, test-backed
fixes are implemented + committed to main as I go; risky ones are documented here only.

---

## Summary

The engine is in strong shape — the existing coverage docs are accurate and most
constants are right. The pass found **2 real bugs (both fixed)** and several
documented notes:

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | **Dragonize** (Feraligatr-Mega) custom -ate ability dropped by the calc — Normal moves not converted to Dragon (wrong type/STAB/×1.2) | 🔴 high | **FIXED** (`damage.ts`) |
| 2 | **Black Sludge** heals non-Poison holders instead of chipping 1/8 | 🟠 | **FIXED** (`endOfTurn.ts`) |
| 3 | Stale `format.champions.json __notes` (custom megas DO calc now) | 🟡 | **FIXED** (note) |
| 4 | **Mega Sol** suppressed under real weather (should arguably override) | 🟠 | documented (can't verify Champions intent) |
| 5 | **Piercing Drill** (Excadrill-Mega) protect-pierce 1/4 not modelled | 🟡 niche | documented |
| 6 | EOT residual ORDER differs from Showdown (KO-boundary only) | 🟡 | documented (sum-then-faint is defensible) |
| 7 | `damageRange` throws on a fully-immune hit | 🟡 | verified handled (callers `try/catch`) |
| 8 | Wish heals 50% of the RECIPIENT's max, not the wisher's | 🟡 | documented (minor; search uses %) |

**External validation:** the **Dragonize** fix matches the official rule verbatim
("turns all Normal-type attacks into Dragon-type, +20% power; Feraligatr-Mega is
Water/Dragon") and **Piercing Drill** ("contact moves pierce Protect for 1/4
damage"), per [Pokemon.com — Mega Feraligatr](https://www.pokemon.com/us/strategy/pokemon-champions-how-to-build-a-mega-feraligatr-team),
[Bulbapedia — Piercing Drill](https://bulbapedia.bulbagarden.net/wiki/Piercing_Drill_(Ability)),
and [Kotaku — Champions mega abilities](https://kotaku.com/pokemon-legends-z-a-mega-evolutions-abilities-champions-2000683952).
The custom-mega data in `@pkmn/dex` (= Showdown's Champions mod) is the source of
truth for these and was used directly.

## Findings

### Phase 1 — internal consistency
- 🟢 **`unmodeled.ts` matches the coverage doc** — gap detector is in lockstep; no drift found.
- 🟢 **Dual `finalizeTurn` mirror — no drift.** Systematically compared mechanic coverage across `engine.ts` and `BattleScreen.tsx` (Spicy Spray, Weakness Policy, Counter, recoil/drain, Leech Seed, Salt Cure, Substitute, Sitrus/Leftovers/status/resist berries, Regenerator, Intimidate, Knock Off, Magic Bounce, Nightmare, Perish, hazards, …): every mechanic one mirror handles, the other does too. Count differences are structural (TUI display vs return shape), not coverage gaps.
- 🟡 **Defiant/Competitive reaction is a LIVE-layer gap (consistent in both mirrors).** Neither finalize applies a +2 when a foe-drop / Intimidate hits a Defiant/Competitive mon — it's modelled only in the search (per coverage doc, "reactions deferred"). Both mirrors agree, so it's a documented deferral, not drift. Surfacing it here so the live HP/boost tracking's blind spot is explicit.
- 🟡 **EOT residual ORDER differs from Showdown.** `endOfTurn.ts` applies status chip before Leftovers/Leech Seed; Showdown's `onResidualOrder` is Leftovers(5) → Leech Seed(8) → status(9). The code mitigates by summing all deltas then checking faint ONCE at the end (so Leftovers always offsets chip — *lenient* vs Showdown, which can faint mid-EOT). Matters only at exact EOT KO boundaries. Documented, not fixed (the sum-then-faint model is defensible for an HP tracker; reordering risks regressions for ~zero decision impact).

### Phase 2 — hardcoded constants vs Showdown
Verified every EOT constant in `endOfTurn.ts` against Gen 9 rules — **all correct**: burn 1/16, poison 1/8, toxic n/16 (ramping), sandstorm 1/16, Leftovers 1/16, Leech Seed 1/8, Curse 1/4, partial-trap 1/8, Nightmare 1/4, Salt Cure 1/8 (1/4 Water/Steel), Bad Dreams 1/8, Aqua Ring/Ingrain 1/16, Rain Dish 1/16, Dry Skin ±1/8, Ice Body 1/16, Solar Power −1/8. One bug:
- 🟠 **Black Sludge heals non-Poison holders** (`endOfTurn.ts` ~L165). It's treated identically to Leftovers (+1/16). Real rule: a **non-Poison** holder *loses* 1/8 per turn; only Poison types heal. → **FIX** (my side only; rare but a clear correctness bug).

**Search-layer damage constants (`endgameSearch.ts`) — all verified correct:** Life Orb recoil 1/10, Rocky Helmet 1/6, Rough Skin/Iron Barbs 1/8, Regenerator 1/3, recovery 1/2 flat (Synthesis/Moonlight 2/3 in sun · 1/4 in other weather; Shore Up 2/3 in sand), Sand/Snow defensive ×2/3, Leech Seed 1/8, recoil/drain read from the dex `[num,den]`. 🟢 One minor note:
- 🟡 **Wish** heals 50% of the **recipient's** max HP, not the **wisher's** (real Wish is fixed at cast from the wisher's max). Matters only when wishing for a much bulkier/frailer teammate; the search works in %, so the error is small. Documented, not fixed.

### Phase 3 — type chart + emulated abilities
- 🟢 **Type chart correct.** `data/types.json` is a verbatim `@pkmn/dex` dump; `typechart.ts` interprets it correctly (`MULT={0:1,1:2,2:0.5,3:0}`) — the historical 1↔2 swap is fixed. Verified vs Bug/Dark interactions.
- 🟢 **`mega.ts` reads `item.megaStone` correctly** — it's a `{base:forme}` map in this dex version (not a string), matching the code.
- 🔴 **Dragonize (Feraligatr-Mega) is dropped by the calc.** Custom -ate ability: "Normal-type moves become Dragon type, 1.2× power." `@smogon/calc` doesn't know the name, so a Dragonize mon's Normal move is calc'd as **Normal** (wrong effectiveness — Ghost immunity, Steel/Rock resist vs Dragon's profile — AND missing STAB since Feraligatr-Mega is Water/**Dragon**, AND missing 1.2×). High impact. The calc honors move `overrides` → **FIX** in `damage.ts` (mirrors the Mega Sol emulation; propagates to search cells + inference).
- 🟠 **Mega Sol suppressed under real weather.** `damage.ts` only emulates the holder's personal Sun when `!field.weather`. Ability text is "moves used as if Sunny Day were active" → should arguably override actual weather (a Mega Sol Fire move under Rain should still get ×1.5, not ×0.5). Offense-only, so defender side is fine. **Documented, not fixed** — can't externally verify Champions' exact intent and the existing guard was deliberate; flagged for user decision.
- 🟡 **Piercing Drill (Excadrill-Mega) not modelled.** "Contact moves ignore protection and deal 1/4 damage [through it]." Only matters in the protect-pierce case; normal-hit damage unaffected. Low priority.
- 🟢 **Spicy Spray (Scovillain-Mega)** burn-on-hit is handled in the live engine (both finalize mirrors); search doesn't model the downstream burn (acceptable — it's a secondary effect, not damage scaling).
- 🟢 **Other custom Future-mega abilities are standard names the calc knows** (Multiscale, Huge Power, Protean, Adaptability, Magic Bounce, Mold Breaker, Levitate, Fairy Aura, …) — applied correctly via `enrichCalcPokemon`'s ability swap.

### Phase 4 — Reg M-A legality
- 🟢 **Counts match** `CLAUDE.md`: 186 legal species, 117 legal items. All resolve in `@pkmn/dex` (0 unknown species/items).
- 🟢 **Custom Champions megas DO damage-calc.** All 59 allow-listed mega stones resolve to mega formes with real stats/types in `@pkmn/dex` (the Champions ones are present as `isNonstandard:"Future"`), and `@smogon/calc` constructs them (verified: Dragonite/Excadrill/Camerupt mega damage differs from base). Caveat = the custom *abilities* above, not the formes.
- 🟡 **Stale `format.champions.json` `__notes`.** It claims `dragoninite`/`excadrite` "may not exist in @pkmn/dex yet … won't damage-calculate correctly until the dex is patched." The dex HAS them now and they calc. → **FIX** the note (the real caveat is the custom *abilities*: Dragonize, Piercing Drill, Spicy Spray — not the formes).
- 🟢 Clauses present: `speciesClause`, `itemClause`, `gimmick:"mega"`, `gimmickAllowancePerSide:1`, level 50, team 6 / bring 4, doubles, open sheets.

---

## Fixes applied this pass

- `fix(damage): emulate Dragonize custom mega ability (Feraligatr-Mega)` — Normal→Dragon + 1.2×, via calc move overrides; +3 tests. Also corrected the stale format `__notes`.
- `fix(eot): Black Sludge damages non-Poison holders (was healing everyone)` — Poison heals 1/16, non-Poison chips 1/8 (Magic Guard blocks); +3 tests.

All 956 tests green; core + tui typecheck clean. Both fixes committed to `main`.

## Recommended follow-ups (not done — need a decision / are larger)

1. **Mega Sol under real weather** (#4) — decide whether the holder's "as if Sunny Day" should override an active Rain/Sand for its own offense (likely yes per the ability text). One-line change in `damage.ts` (drop the `!field.weather` guard) if confirmed.
2. **Piercing Drill** (#5) — model the protect-pierce 1/4 in the search's Protect handling. Niche.
3. **Wish wisher-max** (#8) — thread the wisher's max HP into the delayed-heal amount.
4. **EOT residual order** (#6) — only if exact KO-boundary fidelity is wanted; reorder to Showdown's `onResidualOrder` (Leftovers→Leech→status). Low value, regression-risky.
5. **`damageRange` immune-throw** (#7) — could return a 0-damage result instead of throwing, so callers don't need `try/catch`. Cosmetic; current handling is correct.
