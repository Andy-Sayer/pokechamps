import { describe, test, expect } from 'vitest';
import { setSig, cellKey, CellCache } from '../src/domain/cellCache.js';
import { cachedBringWinRate } from '../src/domain/playoutPool.js';
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
    c.put(k, 2, 4);                      // 2 wins / 4 games
    expect(c.get(k, 4)).toBe(0.5);      // enough samples → hit (wins/games)
    expect(c.get(k, 8)).toBeUndefined(); // wants more games than cached → miss
    expect(c.getRec(k)).toEqual({ wins: 2, games: 4 }); // stored as integer counts
  });
});

describe('cachedBringWinRate — breadth-first, supplement games without recomputing', () => {
  test('a higher games target plays ONLY the shortfall (new seeds) and merges by sample weight', async () => {
    const c = new CellCache('vitest-supplement-fmt'); // empty
    const runs: { seed: [number, number, number, number] }[][] = [];
    // Fake pool: p1 wins the first 4 seeds (k=0..3 → seed[0]=1..4), loses after — so the two
    // batches have different win-rates, making a merge (vs recompute) observable.
    const fakePool = {
      async run(tasks: { seed: [number, number, number, number] }[]) {
        runs.push(tasks);
        return tasks.map(t => ({ winner: t.seed[0] <= 4 ? 'p1' : 'p2', turns: 1 }));
      },
    } as unknown as Parameters<typeof cachedBringWinRate>[1];

    const wr4 = await cachedBringWinRate(c, fakePool, my, opp, 4, 3);   // depth 3
    expect(wr4).toBe(1);                                                 // 4/4 wins

    const wr10 = await cachedBringWinRate(c, fakePool, my, opp, 10, 3);  // supplement to 10
    expect(wr10).toBeCloseTo(0.4, 5);                                    // (1·4 + 0·6)/10

    // Proof it SUPPLEMENTED (not recomputed): the 2nd run played exactly the 6 shortfall games,
    // with seeds continuing the sequence (k=4 → seed[0]=5), not repeating 0..9.
    expect(runs[1]!.length).toBe(6);
    expect(runs[1]![0]!.seed[0]).toBe(5);
    // Stored as EXACT integer counts (4 wins over 10 games), not a lossy float.
    expect(c.getRec(cellKey(my, opp, 'minimax-d3'))).toEqual({ wins: 4, games: 10 });
    // A third call at the SAME target is a pure hit — no new games.
    const runsBefore = runs.length;
    const wr10b = await cachedBringWinRate(c, fakePool, my, opp, 10, 3);
    expect(wr10b).toBeCloseTo(0.4, 5);
    expect(runs.length).toBe(runsBefore);
  });
});
