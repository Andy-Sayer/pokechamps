# Champions custom-data audit (Reg M-A)

One-shot survey (2026-06-12) of every format-custom entry reachable through
the legal lists, and whether our three layers (calc / live engine / search)
respect it. Method: scan `data/*.json` for `isNonstandard` entries reachable
via `format.champions.json` allow-lists + legal mega stones. Regenerate after
each regulation change (see [`regulation-m-b.md`](regulation-m-b.md)).

## Result: the custom surface is exactly 4 abilities

- **Custom moves in legal learnsets: 0.**
- **Custom items: only the mega stones** (`Past`/`Future`-tagged) — pure
  gimmick machinery, fully handled by `gimmicks/mega.ts` (forme resolve,
  validation, candidate enumeration).
- **Custom abilities reachable (all via mega formes):**

| Ability | Holder | Effect | Handling |
|---|---|---|---|
| **Mega Sol** | Meganium-Mega | Holder acts under personal sun | ✅ `damage.ts` emulates sun for the holder's offense (overrides ambient weather); tactics `weather` detector treats it as self-only sun |
| **Spicy Spray** | Scovillain-Mega | Burns attackers on hit | ✅ on-hit burn in both engine mirrors (defender ability resolved through mega) |
| **Dragonize** | Feraligatr-Mega | Normal-type moves become Dragon | ✅ `damage.ts` type-override mirror of the Mega Sol pattern |
| **Piercing Drill** | Excadrill-Mega | Contact moves pierce protection at ¼ damage | ✅ **fixed in this audit** — the search's Protect fizzle now lets a Piercing Drill contact move through at 0.25× (both directions; opp side only when the ability is KNOWN). Previously Protect was modeled as a full block against it |

Also re-verified this pass: Mega Raichu X/Y (Reg M-B) abilities are **standard**
(Electric Surge / No Guard) — no new custom hooks needed, only the
`refresh-data.ts` `SPECIES_PATCHES` data correction.

## Reg M-B custom-mega audit (2026-06-16, pre-launch)

M-B (June 17) adds 22 base species + 16 mega formes. All species/formes/stones
are already in the `@pkmn/dex` dump and format-staged (legality.allow 208,
items.allow 148). The custom surface is the **mega abilities**, split three ways:

| Group | Megas | Ability | Status |
|---|---|---|---|
| Canonical (calc-native) | Sceptile, Blaziken, Swampert, Mawile, Metagross | Lightning Rod / Speed Boost / Swift Swim / Huge Power / Tough Claws | ✅ correct in dump, calc handles |
| Standard (already patched + tested) | Raichu X, Raichu Y | Electric Surge / No Guard | ✅ `SPECIES_PATCHES`; `tests/regulation-m-b.test.ts` |
| Custom — EMULATED (2026-06-17) | Eelektross, Pyroar | **Eelevate** = Levitate + Beast Boost · **Fire Mane** = permanent Blaze (Fire ×1.5) | ✅ calc-correct. Fire Mane ×1.5 Fire override + Eelevate→Levitate immunity in `damage.ts`; the calc reads the mega ability from `@pkmn/dex` (placeholder), so the real name is forced via `MEGA_ABILITY_OVERRIDES` in `gimmicks/mega.ts`. Tests in `damage.test.ts`. Eelevate's Beast Boost half (KO → +1 highest stat) is modeled in the search (`koBoostForSet`, 2026-06-18) — it resolves the MEGA forme's ability + highest stat from the held stone |
| Standard — CONFIRMED 2026-06-18 | Staraptor (Contrary), Scolipede (Shell Armor), Scrafty (Intimidate), Malamar (Contrary), Barbaracle (Tough Claws), Dragalge (Regenerator), Falinks (Defiant) | standard | ✅ pinned in `SPECIES_PATCHES` + `MEGA_ABILITY_OVERRIDES` + species.json. All STANDARD abilities — calc/search handle natively, no emulation. Sources: The Game Haus / Pokéos / PLDH; Staraptor independently seen in live battle footage |

**Why this matters:** like M-A's Dragonize/Mega Sol, any custom ability that
changes type/damage/weather must be emulated in `damage.ts` (+ the
`MEGA_ABILITY_OVERRIDES` map in `gimmicks/mega.ts`, since the calc resolves the
mega ability from `@pkmn/dex`, not our patched `species.json`) — the calc won't
know it otherwise. **Eelevate + Fire Mane are emulated** (2026-06-17).

**ALL M-B mega abilities are now pinned (2026-06-18) — no blanks remain.** The
other 7 invented megas turned out to use STANDARD abilities (Contrary / Shell
Armor / Intimidate / Tough Claws / Regenerator / Defiant), which the calc and
search already handle, so resolving the forme to the correct ability is the whole
fix — no emulation. Only Eelevate + Fire Mane have custom effects. NOTE these were
filled directly into `SPECIES_PATCHES` + `MEGA_ABILITY_OVERRIDES` + `species.json`
WITHOUT a full `npm run refresh-data` (avoids a wide dex re-dump mid-cycle); the
patches are in `SPECIES_PATCHES` so the next refresh reproduces them.

## Reg M-B move changes (2026-06-28)

Champions rebalanced some moves; `@pkmn/dex` carries NONE of these (mainline
data ≠ Champions custom data). Three kinds, handled separately:

**1. Learnset removals — ✅ PATCHED.** Per-species move cuts live in
`format.champions.json` `moves.removeBySpecies` (species name → removed move
names) and are stripped by `getLearnset()` — so they apply everywhere move pools
are derived (opp autocomplete, tactics potential-mode, bring threat detection,
replay/sim legality). Compiled from The Game Haus + Game8 patch notes (UNION —
each list was incomplete; the in-game data is the final authority and the map is
a one-line edit if any entry is wrong):

| Species | Removed |
|---|---|
| Metagross | Heavy Slam, Knock Off |
| Annihilape | Final Gambit |
| Grimmsnarl | Thunder Wave, False Surrender |
| Scrafty | Parting Shot |
| Overqwil | Mortal Spin |
| Gholdengo | Thunder Wave |
| Pyroar | Earth Power |

Test: `champions-move-removals.test.ts` (removed gone, real moves kept,
per-species scoping verified).

**2. Move-DATA changes — ✅ PATCHED.** *Make It Rain*: accuracy 100→95,
self SpA drop −1→−2. Applied directly in `data/moves.json` and re-applied on
every refresh via `MOVE_PATCHES` in `refresh-data.ts` (same survival contract
as `SPECIES_PATCHES`). The engine reads `move.self.boosts` for the self-debuff
(both finalizeTurn mirrors + `endgameSearch`) so the −2 flows through; affects
display/inference, not maximin (accuracy isn't priced). Test:
`champions-move-data.test.ts`.

**3. Move-MECHANIC changes — NOT yet applied.** *Rage Fist* now resets its power
when Annihilape switches out (M-B nerf). Engine work — the search + live engine
model Rage Fist as +1×/hit-taken-this-turn; a switch-out reset would refine it.
Low priority.

## Caveats / accepted simplifications

- Piercing Drill is modeled in the **search** only. The forward damage calc
  never computes "damage into Protect" (the user logs real damage), and the
  live engine takes logged damage as truth — so the search was the only layer
  that wrongly hard-blocked it.
- The pierce applies on the main single-target attack path; the spread and
  priority sub-paths still treat Protect as absolute for it (Excadrill-Mega
  has no meaningful contact spread/priority moves; revisit if a future forme
  gets the ability).
