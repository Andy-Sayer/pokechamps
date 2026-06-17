// Joint EV/nature/item inference: when an opponent both TOOK a hit (constrains
// a defensive stat) and DEALT a hit (constrains an offensive stat), a single
// nature must explain BOTH. The sequential pipeline commits to nature
// defensively first; jointSolve enumerates nature once and checks both
// directions together, recovering the true (e.g. Adamant) spread.
import { describe, test, expect } from 'vitest';
import { jointSolve, type StoredObservation } from '../src/domain/inference.js';
import { damageRange } from '../src/domain/damage.js';
import type { PokemonSet, DamageObservation } from '../src/domain/types.js';
import { NEUTRAL_FIELD, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, ivs: { ...MAX_IVS }, ...p };
}

// Build a defensive observation: `attacker` (mine) hits the opp `defender`,
// recording the mid-roll ABSOLUTE damage (damageRange returns absolute HP;
// damageRaw is the matching DamageObservation field).
function defensiveObs(attacker: PokemonSet, oppTrue: PokemonSet, move: string): StoredObservation {
  const r = damageRange({ attacker, defender: oppTrue, move, field: NEUTRAL_FIELD, attackerSide: 'mine' });
  const mid = Math.round((r.min + r.max) / 2);
  const obs: DamageObservation = {
    attackerSide: 'mine', attackerSpecies: attacker.species,
    defenderSide: 'theirs', defenderSpecies: oppTrue.species,
    move, field: { ...NEUTRAL_FIELD }, damageRaw: mid,
  };
  return { oppIsAttacker: false, otherSet: attacker, observation: obs };
}

// Build an offensive observation: opp `attacker` hits MY `defender`.
function offensiveObs(oppTrue: PokemonSet, defender: PokemonSet, move: string): StoredObservation {
  const r = damageRange({ attacker: oppTrue, defender, move, field: NEUTRAL_FIELD, attackerSide: 'theirs' });
  const mid = Math.round((r.min + r.max) / 2);
  const obs: DamageObservation = {
    attackerSide: 'theirs', attackerSpecies: oppTrue.species,
    defenderSide: 'mine', defenderSpecies: defender.species,
    move, field: { ...NEUTRAL_FIELD }, damageRaw: mid,
  };
  return { oppIsAttacker: true, otherSet: defender, observation: obs };
}

describe('jointSolve', () => {
  test('recovers an Adamant (+Atk/-SpD) spread from a special hit taken + physical hit dealt', () => {
    // TRUE opp: Tyranitar, Adamant (+Atk -SpD), invested offensively.
    const oppTrue = mon({
      species: 'Tyranitar', ability: 'Sand Stream', nature: 'Adamant',
      evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
      moves: ['Rock Slide', 'Crunch'],
    });
    const mySpecialAttacker = mon({
      species: 'Primarina', ability: 'Torrent', nature: 'Modest',
      evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 0 }, moves: ['Moonblast'],
    });
    const myPhysicalTarget = mon({
      species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly',
      evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 }, moves: ['Earthquake'],
    });

    const history = [
      defensiveObs(mySpecialAttacker, oppTrue, 'Moonblast'),   // constrains SpD (and HP)
      offensiveObs(oppTrue, myPhysicalTarget, 'Rock Slide'),   // constrains Atk
    ];

    const res = jointSolve({
      oppSpecies: 'Tyranitar', oppLevel: 50,
      knownMoves: ['Rock Slide', 'Crunch', 'Moonblast'],
      history,
      // Exclude Life Orb so this stays a clean test of NATURE recovery. Once
      // Life Orb is legal (Reg M-B), the Rock Slide damage is genuinely
      // ambiguous — high-Atk no-item vs lower-Atk ×1.3 Life Orb — which fans the
      // nature space and (correctly) trips jointSolve's discrimination gate to
      // null. That meta ambiguity is real but orthogonal to the nature-collapse
      // logic under test; pinning the item axis keeps the unit deterministic.
      excludeItems: ['Life Orb'],
    });
    expect(res).toBeTruthy();
    expect(res!.candidates.length).toBeGreaterThan(0);
    const top = res!.candidates[0]!;
    // The defensive-first sequential read would prefer a +SpD nature (Careful/
    // Calm) to explain the special hit; the truth is -SpD Adamant (took MORE
    // special damage) with heavy Atk. The joint top candidate must NOT be a
    // -Atk nature, and must carry real Atk investment.
    const minusAtk = ['Bold', 'Calm', 'Timid', 'Modest', 'Impish'];
    expect(minusAtk).not.toContain(top.nature);
    // Real Atk investment (the hit can't be explained by a min-invest spread).
    // The exact value isn't pinned — a wide damage roll admits a band of Atk —
    // but it must be substantial, not the 0 the defensive solver would leave.
    expect(top.evs.atk).toBeGreaterThanOrEqual(100);
    // Every kept candidate is jointly consistent: no -Atk survivor at all (the
    // big special hit rules out +SpD/-Atk natures, the physical hit rules out
    // the rest of the -Atk family).
    expect(res!.candidates.some(c => minusAtk.includes(c.nature))).toBe(false);
  });

  test('returns null for single-direction histories (sequential path handles those)', () => {
    const opp = mon({ species: 'Garchomp', moves: ['Earthquake'] });
    const me = mon({ species: 'Incineroar', moves: ['Flare Blitz'] });
    // Two DEFENSIVE obs only → not a mixed history.
    const res = jointSolve({
      oppSpecies: 'Garchomp', oppLevel: 50, knownMoves: ['Earthquake'],
      history: [defensiveObs(me, opp, 'Flare Blitz'), defensiveObs(me, opp, 'Flare Blitz')],
    });
    expect(res).toBeNull();
  });

  test('budget guard bails to null on an oversized axis projection', () => {
    const opp = mon({ species: 'Tyranitar', moves: ['Rock Slide'] });
    const me = mon({ species: 'Primarina', moves: ['Moonblast'] });
    const res = jointSolve({
      oppSpecies: 'Tyranitar', oppLevel: 50, knownMoves: ['Rock Slide', 'Moonblast'],
      history: [defensiveObs(me, opp, 'Moonblast'), offensiveObs(opp, me, 'Rock Slide')],
      calcBudget: 1, // absurdly small → must bail
    });
    expect(res).toBeNull();
  });
});
