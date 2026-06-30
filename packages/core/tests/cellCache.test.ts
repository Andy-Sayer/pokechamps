import { describe, test, expect } from 'vitest';
import { setSig, cellKey, CellCache } from '../src/domain/cellCache.js';
import type { PokemonSet } from '../src/domain/types.js';

const mk = (species: string, item: string): PokemonSet => ({
  species, level: 50, nature: 'Jolly', ability: 'X', item,
  evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
  ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  moves: ['A', 'B', 'C', 'D'],
});
const my = [mk('M1', 'i1'), mk('M2', 'i2'), mk('M3', 'i3'), mk('M4', 'i4')];
const opp = [mk('O1', 'j1'), mk('O2', 'j2'), mk('O3', 'j3'), mk('O4', 'j4')];

describe('cellCache — 4v4 results keyed by mon sets, not by team', () => {
  test('cellKey is order-independent within a side', () => {
    const shuffled = [my[3]!, my[1]!, my[0]!, my[2]!];
    expect(cellKey(my, opp, 'worst')).toBe(cellKey(shuffled, opp, 'worst'));
  });

  test('setSig is set-sensitive — Life Orb vs Scarf Garchomp are distinct', () => {
    expect(setSig(mk('Garchomp', 'Life Orb'))).not.toBe(setSig(mk('Garchomp', 'Choice Scarf')));
  });

  test('cellKey is side-aware — my-4 vs their-4 is not symmetric', () => {
    expect(cellKey(my, opp, 'worst')).not.toBe(cellKey(opp, my, 'worst'));
  });

  test('opp model is part of the key', () => {
    expect(cellKey(my, opp, 'worst')).not.toBe(cellKey(my, opp, 'pilot'));
  });

  test('CellCache.get only reuses when the cached sample is large enough', () => {
    const c = new CellCache('vitest-nonexistent-fmt'); // no file → starts empty
    const k = cellKey(my, opp, 'worst');
    expect(c.get(k, 4)).toBeUndefined();
    c.put(k, 0.42, 4);
    expect(c.get(k, 4)).toBe(0.42);     // enough samples → hit
    expect(c.get(k, 8)).toBeUndefined(); // wants more games than cached → miss
  });
});
