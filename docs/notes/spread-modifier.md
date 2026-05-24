# Spread modifier (doubles 0.75x)

In doubles, moves targeting both opps (`allAdjacentFoes`) or all adjacent slots (`allAdjacent` — both opps + ally) take a 0.75x damage multiplier. `@smogon/calc`'s `Move` honors this via the `isSpread` flag.

`packages/core/src/domain/damage.ts` derives `isSpread` from the dex move target before constructing the `CalcMove`:

```ts
if (moveData?.target === 'allAdjacentFoes' || moveData?.target === 'allAdjacent') {
  moveOpts.isSpread = true;
}
```

## Why this mattered

Before the fix, every spread move in the matchup grid was being calc'd as full single-target damage — overstating Heat Wave / Earthquake / Rock Slide / Astral Barrage / Make It Rain / Discharge / Blizzard / Surf etc. by ~33%. Users would see "this OHKOs everything" and pick the wrong move.

Single-target moves (`target === 'normal'` or `'any'`) leave `isSpread` unset — single hit, no reduction.

## Caveats

- We always set `isSpread` if the move is a spread move. In singles only one mon is targeted, but at the format level PokeChamps is doubles-only, so this is correct.
- A gimmick could override `isSpread` after this auto-set (Dynamax Cannon variants etc.) — the auto-set runs **before** `enrichCalcMove`.
- We do NOT currently model the "spread modifier only when 2+ targets present" edge case for moves like Earthquake when ally fainted or absent. Damage is still 0.75x even with one target on the field, which is slightly conservative but matches the calc default.
