// Matchup cell now carries the most-likely (least-invested) spread's range +
// a confidence rating, alongside the honest min/max envelope.
import { describe, test, expect } from 'vitest';
import { predictOffense } from '../src/domain/predictions.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

const attacker: PokemonSet = {
  species: 'Calyrex-Shadow', level: 50, item: 'Choice Specs', ability: 'As One (Spectrier)',
  nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, ivs: MAX_IVS, moves: ['Astral Barrage'],
};

function inc(evs: Partial<PokemonSet['evs']>, nature = 'Careful', item?: string): PokemonSet {
  return { species: 'Incineroar', level: 50, ability: 'Intimidate', item, nature, evs: { ...ZERO_EVS, ...evs }, ivs: MAX_IVS, moves: [] };
}

describe('predictOffense confidence + likely range', () => {
  test('no inference yet → low confidence (prior), envelope brackets the likely range', () => {
    const opp: OpponentEntry = { species: 'Incineroar', knownMoves: [] };
    const cell = predictOffense({ attacker, opponent: opp, field: NEUTRAL_FIELD })!;
    expect(cell).not.toBeNull();
    expect(cell.confidence).toBe('low');
    if (cell.likelyMinPercent != null) {
      expect(cell.likelyMinPercent).toBeGreaterThanOrEqual(cell.minPercent - 0.01);
      expect(cell.likelyMaxPercent!).toBeLessThanOrEqual(cell.maxPercent + 0.01);
    }
  });

  test('the least-invested candidate drives the likely range', () => {
    const minimal = inc({}, 'Hardy');                         // frail → takes the most
    const bulky = inc({ hp: 252, spd: 252 }, 'Careful');      // invested → takes less
    const opp: OpponentEntry = {
      species: 'Incineroar', knownMoves: [],
      candidates: [bulky, minimal], candidateLikelihoods: [0.9, 0.1],
    };
    const cell = predictOffense({ attacker, opponent: opp, field: NEUTRAL_FIELD })!;
    // minimal is the least-invested → it's the "likely" spread, so the likely
    // MAX should match the high end of the envelope (frail takes the most).
    expect(cell.likelyMaxPercent!).toBeGreaterThanOrEqual(cell.maxPercent - 0.5);
    expect(['high', 'med', 'low']).toContain(cell.confidence);
  });
});
