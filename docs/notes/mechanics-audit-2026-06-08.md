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
constants are right. The pass found **3 real bugs (all FIXED + tested)** plus 5
lower-severity notes, each with an **explicit verdict** so nothing is left as a vague
"judgment call."

> **Clarification — the custom "Future" megas are LEGAL RIGHT NOW.** Pokémon Champions'
> original megas (Feraligatr, Excadrill, Delphox, Greninja, Scovillain, …) are fully
> legal in Reg M-A today. `@pkmn/dex` tags them `isNonstandard:"Future"` purely as a
> data-versioning label (Champions is a 2026 release) — that tag does **not** mean
> "not yet legal." They have real stats/types and `@smogon/calc` builds them; the only
> gaps were their custom *abilities* (below), now all handled.

**Bugs fixed:**

| # | Bug | Sev | Fix |
|---|---|---|---|
| 1 | **Dragonize** (Mega Feraligatr): the calc dropped this custom -ate ability, so its Normal moves stayed Normal — wrong type/effectiveness, no Water/**Dragon** STAB, no ×1.2 | 🔴 high | emulated in `damage.ts` |
| 2 | **Mega Sol** (Mega Meganium): did **nothing** under real weather; should always act as if Sun (e.g. Weather Ball is Fire in the rain, Fire moves ×1.5 in the rain) | 🟠 | force Sun in `damage.ts` |
| 3 | **Black Sludge**: *healed* non-Poison holders; should chip them 1/8 (Poison types heal 1/16) | 🟠 | fixed in `endOfTurn.ts` |

(Plus the stale `format.champions.json __notes` corrected.)

**Lower-severity notes — each with a verdict (no ambiguity):**

| # | Note | Verdict |
|---|---|---|
| 4 | **Piercing Drill** (Mega Excadrill): the protect-pierce-for-1/4 effect isn't modelled | ✅ **leave as-is** — normal-hit damage is unaffected; only the rare "hit through Protect" case differs |
| 5 | **Defiant/Competitive** +2 reaction is applied in the search but **not** in the live HP/boost tracker (consistent across both mirrors) | ⚠️ **real live-layer gap** — fix if you want Defiant mons tracked correctly after an Intimidate/foe-drop live; not drift |
| 6 | **Wish** heals 50% of the **recipient's** max HP, not the **wisher's** | ✅ **leave as-is for now** — exact for same-mon/similar-bulk wishes; only wrong when wishing for a very different-bulk teammate |
| 7 | **EOT residual order** differs from Showdown's `onResidualOrder` | ✅ **not a bug** — only changes *which* effect lands a KO at an exact EOT HP boundary; the sum-then-faint model is correct for an HP tracker |
| 8 | `damageRange` **throws** on a fully-immune hit (calc's `kochance()` errors at 0 damage) | ✅ **not a bug** — every caller wraps it in `try/catch` and skips; an immune move is never chosen anyway |

**External validation (per the user's compare-to-rules mandate):** the **Dragonize**
fix matches the official rule verbatim ("turns all Normal-type attacks into Dragon-type,
+20% power; Mega Feraligatr is Water/Dragon"), **Mega Sol** is confirmed to override
any weather ("Weather Ball does Fire damage in the rain"), and **Piercing Drill** is
"contact moves pierce Protect for 1/4 damage" — per
[Pokemon.com — Mega Feraligatr](https://www.pokemon.com/us/strategy/pokemon-champions-how-to-build-a-mega-feraligatr-team),
[Bulbapedia — Piercing Drill](https://bulbapedia.bulbagarden.net/wiki/Piercing_Drill_(Ability)),
and [Kotaku — Champions mega abilities](https://kotaku.com/pokemon-legends-z-a-mega-evolutions-abilities-champions-2000683952).
The custom-mega data in `@pkmn/dex` (= Showdown's Champions mod) is the source of truth
and was used directly.

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
- ✅ **Mega Sol (Meganium-Mega) — FIXED.** The emulation only forced Sun when there was no real weather, so under Rain/Sand the ability did nothing. Confirmed by the user: Mega Sol acts as if Sunny Day **no matter the weather** — Weather Ball is Fire-typed and Fire moves get ×1.5 even in the rain (and Water moves are weakened even in the rain). Removed the `!field.weather` guard → always force Sun in the holder's offensive calc (offense-only; a defending Mega Sol mon still takes the incoming hit under real weather). Verified: base Weather Ball in Rain = "100 BP Water"; Mega Sol = "100 BP Fire … in Sun" (106-126% vs 37-44% on Skarmory). Known in-code limitation: forcing Sun also drops the defender's real-weather SpD/Def boost (Sand→Rock, Snow→Ice) for that one calc — a rare edge.
- 🟡 **Piercing Drill (Excadrill-Mega) not modelled.** "Contact moves ignore protection and deal 1/4 damage [through it]." Only matters in the protect-pierce case; normal-hit damage unaffected. Low priority.
- 🟢 **Spicy Spray (Scovillain-Mega)** burn-on-hit is handled in the live engine (both finalize mirrors); search doesn't model the downstream burn (acceptable — it's a secondary effect, not damage scaling).
- 🟢 **Other custom Future-mega abilities are standard names the calc knows** (Multiscale, Huge Power, Protean, Adaptability, Magic Bounce, Mold Breaker, Levitate, Fairy Aura, …) — applied correctly via `enrichCalcPokemon`'s ability swap.

### Phase 4 — Reg M-A legality
- 🟢 **Counts match** `CLAUDE.md`: 186 legal species, 117 legal items. All resolve in `@pkmn/dex` (0 unknown species/items).
- 🟢 **Custom Champions megas are legal NOW and DO damage-calc.** All 59 allow-listed mega stones resolve to mega formes with real stats/types in `@pkmn/dex`, and `@smogon/calc` constructs them (verified: Dragonite/Excadrill/Camerupt mega damage differs from base). The Champions-original ones carry the dex's `isNonstandard:"Future"` data tag — **a versioning label, not a legality/timing statement; they are fully legal in current Reg M-A.** The only caveat is the custom *abilities* above, not the formes.
- 🟡 **Stale `format.champions.json` `__notes`.** It claims `dragoninite`/`excadrite` "may not exist in @pkmn/dex yet … won't damage-calculate correctly until the dex is patched." The dex HAS them now and they calc. → **FIX** the note (the real caveat is the custom *abilities*: Dragonize, Piercing Drill, Spicy Spray — not the formes).
- 🟢 Clauses present: `speciesClause`, `itemClause`, `gimmick:"mega"`, `gimmickAllowancePerSide:1`, level 50, team 6 / bring 4, doubles, open sheets.

---

## Fixes applied this pass (all committed to `main`)

- `fix(damage): emulate Dragonize custom mega ability (Feraligatr-Mega)` — Normal→Dragon + 1.2×, via calc move overrides; +3 tests. Also corrected the stale format `__notes`.
- `fix(damage): Mega Sol overrides actual weather (always Sun for its moves)` — Weather Ball is Fire in the rain, Fire ×1.5 in the rain; +1 test.
- `fix(eot): Black Sludge damages non-Poison holders (was healing everyone)` — Poison heals 1/16, non-Poison chips 1/8 (Magic Guard blocks); +3 tests.

All **957 tests green**; core + tui typecheck clean.

## The only remaining OPEN item that's a real gap (your call)

- **Defiant/Competitive live-layer reaction** (note #5). The search applies the +2; the
  live HP/boost tracker (both `finalizeTurn` mirrors) does not. So after an Intimidate
  or a foe stat-drop, a live-tracked Defiant/Competitive mon won't show the +2. Worth
  fixing **only if you want live Defiant tracking** — it's a clean addition (mirror of
  the existing Intimidate handling, applied when a foe-drop lands). Everything else in
  the notes table has verdict ✅ leave-as-is.

Optional/cosmetic (not gaps): model Piercing Drill's protect-pierce; thread the
wisher's max HP into Wish; have `damageRange` return 0 instead of throwing on immune
hits. None change a verdict today.
