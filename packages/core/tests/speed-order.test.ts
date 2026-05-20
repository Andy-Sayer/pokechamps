import { describe, test, expect } from 'vitest';
import { predictTurnOrder, actualSpeed } from '../src/domain/speed.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, MAX_IVS, ZERO_EVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string }): PokemonSet {
  return {
    level: 50,
    nature: 'Hardy',
    evs: { ...ZERO_EVS },
    ivs: MAX_IVS,
    moves: ['Tackle'],
    ...p,
  };
}

const fastSneasler = mon({
  species: 'Sneasler', nature: 'Jolly',
  evs: { ...ZERO_EVS, atk: 252, spe: 252 },
});
const slowTorkoal = mon({ species: 'Torkoal', nature: 'Quiet' });

describe('predictTurnOrder', () => {
  test('orders fastest first by default; unknowns to the back', () => {
    const order = predictTurnOrder({
      myActives: [
        { slot: 0, set: fastSneasler },
        { slot: 1, set: slowTorkoal },
      ],
      oppActives: [
        { slot: 0, entry: { species: 'Incineroar', knownMoves: [], speedFloor: 110, speedCeiling: 110 } },
        { slot: 1, entry: null },
      ],
      field: NEUTRAL_FIELD,
    });
    expect(order[0]!.label).toBe('m1'); // Sneasler ~178 fastest
    expect(order[1]!.label).toBe('o1'); // Incineroar 110
    expect(order[2]!.label).toBe('m2'); // Torkoal ~36
    // Only 3 actives in this scenario (null opp slot 2 contributes no row).
    expect(order).toHaveLength(3);
  });

  test('opp with no observations gets an envelope range from base stats', () => {
    // Sylveon: base Spe 60 → envelope ~[54, 121]. Should NOT be 'unknown'.
    const order = predictTurnOrder({
      myActives: [{ slot: 0, set: fastSneasler }, { slot: 1, set: null }],
      oppActives: [
        { slot: 0, entry: { species: 'Sylveon', knownMoves: [] } },
        { slot: 1, entry: null },
      ],
      field: NEUTRAL_FIELD,
    });
    const sylveon = order.find(r => r.label === 'o1')!;
    expect(sylveon.unknown).toBe(false);
    expect(sylveon.uncertain).toBe(true);
    expect(sylveon.speedMin).toBeLessThan(sylveon.speedMax);
    expect(sylveon.speedMin).toBeGreaterThan(40);
    expect(sylveon.speedMax).toBeLessThan(200);
  });

  test('paralyzed opp has speed halved', () => {
    const order = predictTurnOrder({
      myActives: [{ slot: 0, set: fastSneasler }, { slot: 1, set: null }],
      oppActives: [
        { slot: 0, entry: { species: 'Incineroar', knownMoves: [], speedFloor: 110, speedCeiling: 110, status: 'par' } },
        { slot: 1, entry: null },
      ],
      field: NEUTRAL_FIELD,
    });
    const incin = order.find(r => r.label === 'o1')!;
    expect(incin.paralyzed).toBe(true);
    expect(incin.speedMin).toBe(55); // 110 × 0.5
    expect(incin.speedMax).toBe(55);
  });

  test('trick room inverts the sort (slowest first, unknowns still last)', () => {
    const order = predictTurnOrder({
      myActives: [
        { slot: 0, set: fastSneasler },
        { slot: 1, set: slowTorkoal },
      ],
      oppActives: [
        { slot: 0, entry: { species: 'Incineroar', knownMoves: [], speedFloor: 110, speedCeiling: 110 } },
        { slot: 1, entry: null },
      ],
      field: { ...NEUTRAL_FIELD, trickRoom: true },
    });
    // In TR, slowest first: Torkoal < Incineroar < Sneasler
    expect(order[0]!.label).toBe('m2');
    expect(order[1]!.label).toBe('o1');
    expect(order[2]!.label).toBe('m1');
  });

  test('scarf flag preserved on opp entry', () => {
    const order = predictTurnOrder({
      myActives: [{ slot: 0, set: fastSneasler }, { slot: 1, set: null }],
      oppActives: [{ slot: 0, entry: { species: 'Incineroar', knownMoves: [], speedFloor: 200, scarfSuspected: true } }, { slot: 1, entry: null }],
      field: NEUTRAL_FIELD,
    });
    const oppRow = order.find(r => r.label === 'o1')!;
    expect(oppRow.scarf).toBe(true);
  });

  test('actualSpeed sanity for Jolly 252 Spe', () => {
    expect(actualSpeed(fastSneasler)).toBeGreaterThan(170);
  });
});
