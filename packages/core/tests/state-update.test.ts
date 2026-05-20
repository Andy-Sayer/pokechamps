import { describe, test, expect } from 'vitest';
import { predictOffense } from '../src/domain/predictions.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

// These tests cover the predictions module's HP-context branch and the
// shape of state updates. End-to-end state mutation in BattleScreen is
// exercised in the manual smoke test.

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return {
    level: 50,
    nature: 'Hardy',
    evs: { ...ZERO_EVS },
    ivs: MAX_IVS,
    ...p,
  };
}

const sneasler = mon({
  species: 'Sneasler', ability: 'Unburden', nature: 'Jolly',
  evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
  moves: ['Close Combat', 'Dire Claw', 'Fake Out', 'Protect'],
});

const incineroar = mon({
  species: 'Incineroar', ability: 'Intimidate', nature: 'Careful',
  evs: { hp: 244, atk: 0, def: 0, spa: 0, spd: 252, spe: 12 },
  moves: ['Flare Blitz', 'Knock Off', 'Fake Out', 'Parting Shot'],
});

describe('predictOffense with defenderCurrentHpPercent', () => {
  test('OHKO call uses remaining HP, not max HP', () => {
    // Sneasler Close Combat vs Incineroar at full would be ~50-60% (rough).
    // At 30% remaining, even the min roll OHKOs.
    const opp: OpponentEntry = { species: 'Incineroar', knownMoves: [], candidates: [incineroar] };
    const atFull = predictOffense({ attacker: sneasler, opponent: opp, field: NEUTRAL_FIELD })!;
    const at30 = predictOffense({
      attacker: sneasler, opponent: opp, field: NEUTRAL_FIELD,
      defenderCurrentHpPercent: 30,
    })!;
    // Same move chosen either way
    expect(at30.move).toBe(atFull.move);
    // KO text differs: full-HP uses the calc's text, low-HP uses our recompute
    expect(at30.koChance).not.toBe(atFull.koChance);
    // 30% remaining should yield a guaranteed-KO-ish call if min damage > 30
    if (atFull.minPercent >= 30) {
      expect(at30.koChance).toBe('guaranteed KO');
    }
  });

  test('weak attacker vs healthy defender reports survives', () => {
    // 0-Atk Bold Smeargle Tackle vs full Incineroar: nowhere near OHKO.
    // remaining=80 means max% < remaining → "survives" branch.
    const wimp = mon({
      species: 'Smeargle', ability: 'Own Tempo', nature: 'Bold',
      evs: { ...ZERO_EVS },
      moves: ['Tackle'],
    });
    const opp: OpponentEntry = { species: 'Incineroar', knownMoves: [], candidates: [incineroar] };
    const r = predictOffense({
      attacker: wimp, opponent: opp, field: NEUTRAL_FIELD,
      defenderCurrentHpPercent: 80,
    })!;
    expect(r.koChance).toMatch(/survives/);
  });

  test('full HP path leaves koChance untouched (matches default)', () => {
    const opp: OpponentEntry = { species: 'Incineroar', knownMoves: [], candidates: [incineroar] };
    const a = predictOffense({ attacker: sneasler, opponent: opp, field: NEUTRAL_FIELD })!;
    const b = predictOffense({
      attacker: sneasler, opponent: opp, field: NEUTRAL_FIELD,
      defenderCurrentHpPercent: 100,
    })!;
    // 100% remaining == max HP → no override, use calc's koChance text
    expect(b.koChance).toBe(a.koChance);
  });
});
