// Pikalytics /ai markdown parser tolerance for the Reg M-B schema. M-B's export
// degrades several fields vs M-A: the index reports usage as "N/A" and ranks by
// raw game volume (win rate + W-L-T record in extra columns); Common Teammates
// render "undefined%"; and the FAQ top-spread omits the nature label. The
// parser must still ingest all of it — names + spreads are what team
// composition and the meta report rely on. See refresh-pikalytics.ts.
import { describe, test, expect } from 'vitest';
import { parseEntry, parseIndexRows, inferNatureFromSp } from '../src/scripts/refresh-pikalytics.js';

// Trimmed real-shape Reg M-B per-species page (Garchomp): blank nature,
// undefined teammate %, real move/ability/item %.
const MB_SPECIES_MD = `
## Common Moves
- **Dragon Claw**: 89.4%
- **Earthquake**: 80.7%

## Common Abilities
- **Rough Skin**: 98.5%

## Common Items
- **Life Orb**: 51.5%

## Common Teammates
- **Whimsicott**: undefined%
- **Charizard**: undefined%

## Featured Teams with Garchomp

### Team 1 by burningblazer
*Record: 14-2*

**Garchomp Set**:
- **Ability**: Rough Skin
- **Item**: Life Orb
- **Moves**: Earthquake, Rock Slide, Protect, Dragon Claw

### What is the most common EV Spread and Nature for Garchomp?
The top build for Garchomp features a **** nature with an EV spread of \`2/32/0/0/0/32\`. This configuration accounts for 32.7% of competitive builds.
`;

describe('parseEntry — Reg M-B schema tolerance', () => {
  const e = parseEntry(MB_SPECIES_MD, 'Garchomp');

  test('real-percentage sections still parse', () => {
    expect(e.moves[0]).toEqual({ name: 'Dragon Claw', pct: 89.4 });
    expect(e.abilities[0]).toEqual({ name: 'Rough Skin', pct: 98.5 });
    expect(e.items[0]).toEqual({ name: 'Life Orb', pct: 51.5 });
  });

  test('"undefined%" teammates keep their names (ordered), pct 0', () => {
    expect(e.teammates.map(t => t.name)).toEqual(['Whimsicott', 'Charizard']);
    expect(e.teammates.every(t => t.pct === 0)).toBe(true);
  });

  test('blank-nature top spread keeps the EVs and infers the nature', () => {
    expect(e.topSpread?.sp).toEqual([2, 32, 0, 0, 0, 32]);
    expect(e.topSpread?.nature).toBe('Jolly'); // max Atk + max Spe
    expect(e.topSpread?.pct).toBe(32.7);
  });

  test('featured set still parses item/ability/moves', () => {
    expect(e.featuredSets[0]?.item).toBe('Life Orb');
    expect(e.featuredSets[0]?.moves).toHaveLength(4);
  });
});

describe('inferNatureFromSp — deterministic shape → nature', () => {
  // sp = [hp, atk, def, spa, spd, spe]
  test('max Atk + max Spe → Jolly', () => expect(inferNatureFromSp([2, 32, 0, 0, 0, 32])).toBe('Jolly'));
  test('max SpA + max Spe → Timid', () => expect(inferNatureFromSp([2, 0, 0, 32, 0, 32])).toBe('Timid'));
  test('max Atk, no Spe → Adamant', () => expect(inferNatureFromSp([20, 32, 0, 0, 12, 0])).toBe('Adamant'));
  test('max SpA, no Spe → Modest', () => expect(inferNatureFromSp([20, 0, 0, 32, 12, 0])).toBe('Modest'));
  test('bulky AV (HP/SpD, trace SpA) → Calm', () => expect(inferNatureFromSp([32, 0, 1, 5, 25, 3])).toBe('Calm'));
  test('bulky physical wall (HP/Def) → Bold', () => expect(inferNatureFromSp([32, 0, 28, 0, 4, 0])).toBe('Bold'));
});

describe('parseIndexRows — M-A usage% and M-B N/A+winRate layouts', () => {
  const MA_INDEX = `
| Rank | Pokemon | Usage % | Web Page | AI Data |
|------|---------|---------|----------|---------|
| 1 | **Sneasler** | 43.80% | [View](x) | [AI](y) |
| 2 | **Garchomp** | 40.00% | [View](x) | [AI](y) |
`;
  const MB_INDEX = `
| Rank | Pokemon | Usage % | Win Rate | Record | Web Page | AI Data |
|------|---------|---------|----------|--------|----------|---------|
| 1 | **Garchomp** | N/A% | 52.366% | 15196-13822-15 | [View](x) | [AI](y) |
| 2 | **Sinistcha** | N/A% | 50.202% | 9812-9733-8 | [View](x) | [AI](y) |
`;

  test('M-A: usage parsed, no win rate', () => {
    const rows = parseIndexRows(MA_INDEX, 60);
    expect(rows.map(r => r.name)).toEqual(['Sneasler', 'Garchomp']);
    expect(rows[0]!.usage).toBe(43.8);
    expect(rows[0]!.winRate).toBeUndefined();
  });

  test('M-B: usage 0 on N/A, win rate + record captured, order = rank', () => {
    const rows = parseIndexRows(MB_INDEX, 60);
    expect(rows.map(r => r.name)).toEqual(['Garchomp', 'Sinistcha']);
    expect(rows[0]!.usage).toBe(0);
    expect(rows[0]!.winRate).toBe(52.366);
    expect(rows[0]!.record).toBe('15196-13822-15');
  });
});
