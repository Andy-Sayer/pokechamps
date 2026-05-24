// B.1 Hybrid candidate weighting: the solver ranks survivors by likelihood and
// — crucially — never returns an empty set, recovering from a contradictory
// observation instead of dead-ending.
import { describe, test, expect } from 'vitest';
import { inferSpread, mostLikely, type SpreadCandidate } from '../src/domain/inference.js';
import type { PokemonSet, DamageObservation } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

const attacker: PokemonSet = {
  species: 'Calyrex-Shadow', level: 50, item: 'Choice Specs', ability: 'As One (Spectrier)',
  nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, ivs: MAX_IVS, moves: ['Astral Barrage'],
};

function observe(damageHpPercent: number): DamageObservation {
  return {
    attackerSide: 'mine', attackerSpecies: 'Calyrex-Shadow',
    defenderSide: 'theirs', defenderSpecies: 'Incineroar',
    move: 'Astral Barrage', field: NEUTRAL_FIELD, damageHpPercent,
  };
}

const base = {
  defenderSpecies: 'Incineroar', defenderLevel: 50, knownDefenderMoves: [],
  attackerSet: attacker, quickOnly: true as const,
};

describe('inferSpread Hybrid weighting', () => {
  test('a plausible observation narrows to a non-empty set', () => {
    const out = inferSpread({ ...base, observation: observe(29) });
    expect(out.length).toBeGreaterThan(0);
  });

  test('a contradictory observation never empties the set (Hybrid fallback)', () => {
    // 95% from a single Astral Barrage on Incineroar is impossible for any
    // realistic spread — the hard filter would yield []. Hybrid keeps the
    // closest-fitting candidates instead.
    const out = inferSpread({ ...base, observation: observe(95) });
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(8);
  });

  test('chained narrowing from startingCandidates stays non-empty under contradiction', () => {
    const first = inferSpread({ ...base, observation: observe(29) });
    expect(first.length).toBeGreaterThan(0);
    const second = inferSpread({
      ...base,
      observation: observe(95),
      startingCandidates: first,
    });
    // Even though 95% contradicts the narrowed set, we recover (closest of the
    // prior candidates) rather than returning [].
    expect(second.length).toBeGreaterThan(0);
    // All returned candidates came from the prior set (no silent re-expansion).
    for (const c of second) expect(first).toContain(c);
  });
});

describe('mostLikely', () => {
  const minimal: SpreadCandidate = { evs: { ...ZERO_EVS }, nature: 'Hardy' };
  const invested: SpreadCandidate = { evs: { ...ZERO_EVS, hp: 252, spd: 252 }, nature: 'Careful', item: 'Assault Vest' };

  test('with likelihoods, the highest-scoring candidate wins (even if heavily invested)', () => {
    const pick = mostLikely([minimal, invested], [0.1, 0.9]);
    expect(pick).toBe(invested);
  });

  test('without likelihoods, falls back to the minimal-EV prior', () => {
    const pick = mostLikely([invested, minimal]);
    expect(pick).toBe(minimal);
  });

  test('likelihood ties break toward the lower-investment prior', () => {
    const pick = mostLikely([invested, minimal], [0.5, 0.5]);
    expect(pick).toBe(minimal);
  });
});
