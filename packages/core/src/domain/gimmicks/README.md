# Gimmicks

Battle gimmicks (Mega, Tera, Z-Move, Dynamax) sit behind a single `Gimmick` interface (`types.ts`) so each regulation set can swap one in without touching the rest of the engine. The active gimmick is selected by `format.champions.json`'s `gimmick` field, resolved lazily through `activeGimmick()` in `index.ts`, and dispatched to via optional hooks — anything a gimmick doesn't care about it simply omits, and the null-object `noneGimmick` (`none.ts`) covers the "no gimmick" case.

## Adding a new gimmick

1. Create a sibling file (e.g. `tera.ts`) that exports a `Gimmick` with `id`, `label`, and whichever hooks below apply.
2. Add the id to the `GimmickId` union in `types.ts` (already includes `'none' | 'mega' | 'tera' | 'zmove' | 'dynamax'` — extend if you go beyond these).
3. Register the module in the `REGISTRY` map in `index.ts`, replacing the `noneGimmick` placeholder for that id.
4. Set `"gimmick"` in `data/format.champions.json` to the new id. Also update `ChampionsFormat.gimmick` in `src/domain/types.ts` if you added a new id.
5. If the gimmick needs team-time data (e.g. a chosen Tera type, a Z-crystal flag), add the field to `PokemonSet` in `src/domain/types.ts` and teach `parseShowdownLine` / `formatShowdownLines` to round-trip it.

## Hooks each type likely needs

- **Mega.** `battleControl` (per-Pokemon activation toggle), `enumerateOpponentVariants` (every legal stone for a species), `validateSet` (stone-species match, legal-item check). No calc enrichment — `@smogon/calc` auto-resolves the mega forme from the held stone.
- **Tera.** `parseShowdownLine` + `formatShowdownLines` (read/write the `Tera Type:` line), `enrichCalcPokemon` (set `teraType` on the calc Pokemon options).
- **Z-Move.** `enrichCalcMove` (set `useZ` on the calc Move options); typically also `battleControl` to pick the move.
- **Dynamax.** `enrichCalcPokemon` (set `isDynamaxed` and `dynamaxLevel` on the calc Pokemon options).

Most gimmicks will also want `validateSet` (format-aware legality) and `describeSet` (one-liner appended to AI prompt summaries).

## Calc option quick reference

The `enrichCalc*` hooks mutate plain `Record<string, unknown>` bags passed to `new CalcPokemon(...)` / `new CalcMove(...)`. Relevant keys (see `node_modules/@smogon/calc/dist/state.d.ts`):

| Hook                 | Key            | Type      |
| -------------------- | -------------- | --------- |
| `enrichCalcPokemon`  | `teraType`     | TypeName  |
| `enrichCalcPokemon`  | `isDynamaxed`  | boolean   |
| `enrichCalcPokemon`  | `dynamaxLevel` | number    |
| `enrichCalcMove`     | `useZ`         | boolean   |
| `enrichCalcMove`     | `useMax`       | boolean   |

The bags are intentionally untyped to insulate the `Gimmick` contract from `@smogon/calc` upgrades.
