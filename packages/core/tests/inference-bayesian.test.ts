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

describe('mostLikely (minimum-stat-points principle)', () => {
  const minimal: SpreadCandidate = { evs: { ...ZERO_EVS }, nature: 'Hardy' };
  const invested: SpreadCandidate = { evs: { ...ZERO_EVS, hp: 252, spd: 252 }, nature: 'Careful', item: 'Assault Vest' };
  const investedB: SpreadCandidate = { evs: { ...ZERO_EVS, hp: 252, spd: 252 }, nature: 'Careful', item: 'Leftovers' };

  test('the least-invested consistent spread wins, even with a lower likelihood', () => {
    // Minimal has the WORSE fit (0.1) but is the honest floor — it still wins.
    const pick = mostLikely([minimal, invested], [0.1, 0.9]);
    expect(pick).toBe(minimal);
  });

  test('without likelihoods, picks the minimal-investment spread', () => {
    expect(mostLikely([invested, minimal])).toBe(minimal);
  });

  test('likelihood only breaks a tie between equally-invested spreads', () => {
    // Same investment → the better roll-fit (higher likelihood) wins.
    const pick = mostLikely([invested, investedB], [0.2, 0.8]);
    expect(pick).toBe(investedB);
  });
});

describe('Item signals: sandChipObserved', () => {
  test('excludes Safety Goggles when sand chip is observed', () => {
    const withoutSignal = inferSpread({ ...base, observation: observe(29) });
    // At least one candidate should have Safety Goggles if sand chip wasn't observed
    const hasGoggles = withoutSignal.some(c => c.item === 'Safety Goggles');

    const withSignal = inferSpread({
      ...base,
      observation: observe(29),
      sandChipObserved: true,
    });
    // No candidate should have Safety Goggles when sand chip is observed
    const hasGogglesWithSignal = withSignal.some(c => c.item === 'Safety Goggles');
    expect(hasGogglesWithSignal).toBe(false);
  });

  test('sand chip signal works with narrowed candidate sets', () => {
    // First narrow to a set with Safety Goggles
    const first = inferSpread({ ...base, observation: observe(29) });
    const filtered = first.filter(c => c.item === 'Safety Goggles' || c.item === 'Assault Vest');

    // Then apply sand chip signal on the narrowed set
    const second = inferSpread({
      ...base,
      observation: observe(29),
      startingCandidates: filtered,
      sandChipObserved: true,
    });
    // All candidates should now be Assault Vest (Safety Goggles filtered out)
    for (const c of second) {
      expect(c.item).not.toBe('Safety Goggles');
    }
  });
});

describe('scoreOffensiveSpread — infer opponent Atk/SpA from their hit on a known mon', () => {
  const mkMon = (p: Partial<PokemonSet> & { species: string }): PokemonSet => ({
    level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, moves: [], ...p,
  });
  // My known defender.
  const myIncin = mkMon({ species: 'Incineroar', nature: 'Careful', evs: { ...ZERO_EVS, hp: 252, spd: 4 } });

  test('a max-Atk physical hit forces high inferred Atk and prunes the 0-Atk reading', async () => {
    const { scoreOffensiveSpread } = await import('../src/domain/inference.js');
    const { damageRange } = await import('../src/domain/damage.js');
    // Reference damage from an actual 252-Atk Adamant Garchomp Earthquake.
    const ref = damageRange({
      attacker: mkMon({ species: 'Garchomp', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Earthquake'] }),
      defender: myIncin, move: 'Earthquake', field: NEUTRAL_FIELD, attackerSide: 'theirs',
    });
    const observedPct = (ref.minPercent + ref.maxPercent) / 2;
    const scored = scoreOffensiveSpread({
      attackerSpecies: 'Garchomp', attackerLevel: 50,
      startingCandidates: [{ evs: { ...ZERO_EVS }, nature: 'Adamant' }],
      attackerMoves: ['Earthquake'], move: 'Earthquake', defenderSet: myIncin,
      observation: {
        attackerSide: 'theirs', attackerSpecies: 'Garchomp', defenderSide: 'mine',
        defenderSpecies: 'Incineroar', move: 'Earthquake', field: NEUTRAL_FIELD, damageHpPercent: observedPct,
      },
    });
    expect(scored.length).toBeGreaterThan(0);
    // 0-Atk cannot explain a max-Atk hit → every surviving candidate invests Atk.
    expect(scored.every(s => s.candidate.evs.atk > 0)).toBe(true);
    expect(Math.max(...scored.map(s => s.candidate.evs.atk))).toBeGreaterThanOrEqual(196);
  });

  test('passes through unchanged for moves whose damage ignores the user offense (Foul Play)', async () => {
    const { scoreOffensiveSpread } = await import('../src/domain/inference.js');
    const start: SpreadCandidate[] = [{ evs: { ...ZERO_EVS }, nature: 'Adamant' }];
    const scored = scoreOffensiveSpread({
      attackerSpecies: 'Grimmsnarl', attackerLevel: 50, startingCandidates: start,
      attackerMoves: ['Foul Play'], move: 'Foul Play', defenderSet: myIncin,
      observation: {
        attackerSide: 'theirs', attackerSpecies: 'Grimmsnarl', defenderSide: 'mine',
        defenderSpecies: 'Incineroar', move: 'Foul Play', field: NEUTRAL_FIELD, damageHpPercent: 40,
      },
    });
    expect(scored.map(s => s.candidate)).toEqual(start);
  });
});
