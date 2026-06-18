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
| Custom — EMULATED (2026-06-17) | Eelektross, Pyroar | **Eelevate** = Levitate + Beast Boost · **Fire Mane** = permanent Blaze (Fire ×1.5) | ✅ calc-correct. Fire Mane ×1.5 Fire override + Eelevate→Levitate immunity in `damage.ts`; the calc reads the mega ability from `@pkmn/dex` (placeholder), so the real name is forced via `MEGA_ABILITY_OVERRIDES` in `gimmicks/mega.ts`. Tests in `damage.test.ts`. **GAP:** Eelevate's Beast Boost (KO → +1 highest stat) is a post-KO ENGINE effect, not emulated in the search yet |
| Custom — name unpublished | Staraptor, Scolipede, Scrafty, Malamar, Barbaracle, Dragalge, Falinks | ? | ❌ dump carries PLACEHOLDER base abilities; Serebii ability pages still blank |

**Why this matters:** like M-A's Dragonize/Mega Sol, any custom ability that
changes type/damage/weather must be emulated in `damage.ts` (+ the
`MEGA_ABILITY_OVERRIDES` map in `gimmicks/mega.ts`, since the calc resolves the
mega ability from `@pkmn/dex`, not our patched `species.json`) — the calc won't
know it otherwise. **Eelevate + Fire Mane are now emulated** (2026-06-17). The
remaining 7 invented megas still calc on correct stats/types but a placeholder
ability, so treat THOSE as **playable-but-not-damage-exact** until their effects
publish; don't anchor a team on their special ability.

**Launch fill-in (≈10 min once Serebii populates the ability pages):**
1. add the 7 unpublished names to `SPECIES_PATCHES` (refresh-data.ts), run
   `npm run refresh-data`, confirm the `patched species.json/...` log lines;
2. for each ability whose effect touches damage/type/weather/protection, add the
   emulation to `damage.ts` (mirror the Mega Sol / Dragonize / Piercing Drill
   patterns above) + the search;
3. extend `tests/regulation-m-b.test.ts` with a forward-damage assertion per
   emulated ability.

## Caveats / accepted simplifications

- Piercing Drill is modeled in the **search** only. The forward damage calc
  never computes "damage into Protect" (the user logs real damage), and the
  live engine takes logged damage as truth — so the search was the only layer
  that wrongly hard-blocked it.
- The pierce applies on the main single-target attack path; the spread and
  priority sub-paths still treat Protect as absolute for it (Excadrill-Mega
  has no meaningful contact spread/priority moves; revisit if a future forme
  gets the ability).
