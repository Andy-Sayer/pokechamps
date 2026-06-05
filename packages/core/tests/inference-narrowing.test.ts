// New inference narrowing axes:
//  #2 item permanence — a consumed item collapses the item axis to "no item"
//  #3 joint reconcile — candidates must satisfy the FULL observation history
//  #4 ability inference — a landed hit rules out the type-immunity ability
import { describe, test, expect } from 'vitest';
import {
  inferSpread, scoreSpread, reconcileCandidates, abilitiesRuledOutByHit,
  type SpreadCandidate, type StoredObservation,
} from '../src/domain/inference.js';
import { damageRange } from '../src/domain/damage.js';
import type { PokemonSet, DamageObservation } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

const calyrex: PokemonSet = {
  species: 'Calyrex-Shadow', level: 50, item: 'Choice Specs', ability: 'As One (Spectrier)',
  nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, ivs: MAX_IVS, moves: ['Astral Barrage'],
};
const observe = (damageHpPercent: number): DamageObservation => ({
  attackerSide: 'mine', attackerSpecies: 'Calyrex-Shadow',
  defenderSide: 'theirs', defenderSpecies: 'Incineroar', move: 'Astral Barrage',
  field: NEUTRAL_FIELD, damageHpPercent,
});
const base = {
  defenderSpecies: 'Incineroar', defenderLevel: 50, knownDefenderMoves: [],
  attackerSet: calyrex, quickOnly: true as const,
};

describe('#4 ability inference — type-immunity abilities ruled out by a landed hit', () => {
  test('abilitiesRuledOutByHit maps each immunity type to its ability', () => {
    expect(abilitiesRuledOutByHit('Ground').has('levitate')).toBe(true);
    expect(abilitiesRuledOutByHit('Electric').has('voltabsorb')).toBe(true);
    expect(abilitiesRuledOutByHit('Water').has('waterabsorb')).toBe(true);
    expect(abilitiesRuledOutByHit('Fire').has('flashfire')).toBe(true);
    // Dry Skin is immune to Water (not Fire) — only ruled out by a Water hit.
    expect(abilitiesRuledOutByHit('Water').has('dryskin')).toBe(true);
    expect(abilitiesRuledOutByHit('Fire').has('dryskin')).toBe(false);
    // A non-immunity type rules out nothing.
    expect(abilitiesRuledOutByHit('Normal').size).toBe(0);
    expect(abilitiesRuledOutByHit(undefined).size).toBe(0);
  });

  test('a Ground hit that dealt damage drops Levitate from the candidate set', () => {
    // Two explicit candidates differing only in ability. A Ground move that
    // dealt real damage rules out the Levitate one (Levitate ⇒ Ground-immune),
    // before the damage filter even runs.
    const starting: SpreadCandidate[] = [
      { evs: { ...ZERO_EVS, hp: 252, def: 4 }, nature: 'Impish', ability: 'Levitate' },
      { evs: { ...ZERO_EVS, hp: 252, def: 4 }, nature: 'Impish', ability: 'Rough Skin' },
    ];
    const cands = scoreSpread({
      defenderSpecies: 'Hippowdon', defenderLevel: 50, knownDefenderMoves: [],
      attackerSet: { ...calyrex, species: 'Garchomp', ability: 'Rough Skin', nature: 'Adamant',
        evs: { ...ZERO_EVS, atk: 252 }, item: undefined, moves: ['Earthquake'] },
      observation: {
        attackerSide: 'mine', attackerSpecies: 'Garchomp', defenderSide: 'theirs',
        defenderSpecies: 'Hippowdon', move: 'Earthquake', field: NEUTRAL_FIELD, damageHpPercent: 30,
      },
      startingCandidates: starting,
      quickOnly: true,
    });
    const abilityId = (a?: string) => (a ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.some(c => abilityId(c.candidate.ability) === 'levitate')).toBe(false);
    expect(cands.some(c => abilityId(c.candidate.ability) === 'roughskin')).toBe(true);
  });
});

describe('#2 item permanence — itemKnownGone collapses the item axis', () => {
  test('no candidate holds an item once the item is known consumed', () => {
    const withItem = inferSpread({ ...base, observation: observe(40) });
    expect(withItem.some(c => !!c.item)).toBe(true); // sanity: items normally appear
    const gone = inferSpread({ ...base, observation: observe(40), itemKnownGone: true });
    expect(gone.length).toBeGreaterThan(0);
    expect(gone.every(c => !c.item)).toBe(true);
  });
});

describe('#3 joint reconcile — candidates must satisfy the FULL history', () => {
  test('drops a frail candidate that an earlier observation contradicts', () => {
    const bulky: PokemonSet = {
      species: 'Incineroar', level: 50, nature: 'Careful',
      evs: { ...ZERO_EVS, hp: 252, spd: 252 }, ivs: MAX_IVS, moves: [],
    };
    // Observed damage produced by the bulky spread (its true identity).
    const ref = damageRange({ attacker: calyrex, defender: bulky, move: 'Astral Barrage', field: NEUTRAL_FIELD, attackerSide: 'mine' });
    const obs = observe((ref.minPercent + ref.maxPercent) / 2);

    const bulkyCand: SpreadCandidate = { evs: { ...ZERO_EVS, hp: 252, spd: 252 }, nature: 'Careful' };
    const frailCand: SpreadCandidate = { evs: { ...ZERO_EVS }, nature: 'Hardy' };
    const history: StoredObservation[] = [
      { oppIsAttacker: false, otherSet: calyrex, observation: obs },
      { oppIsAttacker: false, otherSet: calyrex, observation: obs },
    ];
    const r = reconcileCandidates({
      oppSpecies: 'Incineroar', oppLevel: 50, knownMoves: [],
      candidates: [bulkyCand, frailCand], history,
    });
    expect(r.candidates).toContainEqual(bulkyCand);
    expect(r.candidates).not.toContainEqual(frailCand);
  });

  test('never empties: a history nothing satisfies returns the input set', () => {
    const cands: SpreadCandidate[] = [
      { evs: { ...ZERO_EVS, hp: 252 }, nature: 'Careful' },
      { evs: { ...ZERO_EVS }, nature: 'Hardy' },
    ];
    const impossible = observe(100); // no Incineroar spread takes 100% from one hit
    const history: StoredObservation[] = [
      { oppIsAttacker: false, otherSet: calyrex, observation: impossible },
      { oppIsAttacker: false, otherSet: calyrex, observation: impossible },
    ];
    const r = reconcileCandidates({ oppSpecies: 'Incineroar', oppLevel: 50, knownMoves: [], candidates: cands, history });
    expect(r.candidates).toEqual(cands);
  });
});
