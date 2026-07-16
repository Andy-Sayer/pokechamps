// Champions move-DATA rebalances (Reg M-B): @pkmn/dex ships the MAINLINE
// numbers, so data/moves.json is patched (and re-applied on every
// `npm run refresh-data` via MOVE_PATCHES in refresh-data.ts). The engine reads
// these fields directly — accuracy feeds miss-out logic, `self.boosts` feeds
// the self-debuff path in both finalizeTurn mirrors and the search.
import { describe, test, expect } from 'vitest';
import { getMove } from '../src/domain/data.js';

describe('Champions move-data patches', () => {
  test('Make It Rain has the Champions M-B numbers (accuracy 95, self SpA -2)', () => {
    const m = getMove('Make It Rain') as {
      accuracy: number | true;
      self?: { boosts?: { spa?: number } };
    };
    expect(m.accuracy).toBe(95);
    expect(m.self?.boosts?.spa).toBe(-2);
  });

  test('the patch is per-move — Gigaton Hammer keeps its mainline data', () => {
    // A neighbouring Steel nuke NOT on the patch list must be untouched —
    // guards against a patch pass mutating other entries.
    const m = getMove('Gigaton Hammer') as { accuracy: number | true; basePower: number };
    expect(m.accuracy).toBe(100);
    expect(m.basePower).toBe(160);
  });
});
