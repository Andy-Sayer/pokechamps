// Field-clearing moves (Defog / Rapid Spin / Court Change / Tidy Up): unit
// tests for the clear table + applyHazardClear, plus engine integration
// proving a logged clearing move mutates the field through finalizeTurn.
import { describe, test, expect } from 'vitest';
import { hazardClearEffect, applyHazardClear } from '../src/domain/hazards.js';
import { finalizeTurn, type ActiveIdx } from '../src/match/engine.js';
import type { Match, PokemonSet, OpponentEntry, MoveAction, FieldState } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

describe('hazardClearEffect', () => {
  test('Rapid Spin clears own side + Speed boost; Mortal Spin clears own side', () => {
    expect(hazardClearEffect('Rapid Spin')).toEqual({ kind: 'self', userSpeedBoost: 1 });
    expect(hazardClearEffect('Mortal Spin')).toEqual({ kind: 'self' });
  });
  test('Defog / Court Change / Tidy Up map to their kinds', () => {
    expect(hazardClearEffect('Defog')?.kind).toBe('defog');
    expect(hazardClearEffect('Court Change')?.kind).toBe('court-change');
    expect(hazardClearEffect('Tidy Up')).toEqual({ kind: 'tidy-up', userAtkBoost: 1, userSpeedBoost: 1 });
  });
  test('non-clearing moves return null', () => {
    expect(hazardClearEffect('Earthquake')).toBeNull();
    expect(hazardClearEffect('Stealth Rock')).toBeNull();
  });
});

describe('applyHazardClear', () => {
  const base: FieldState = {
    ...NEUTRAL_FIELD,
    myHazards: { rocks: true, spikes: 2 },
    theirHazards: { stickyWeb: true },
    myReflect: true,
    theirLightScreen: true,
    myTailwind: true,
  };

  test('self clears only the user side', () => {
    const f = applyHazardClear(base, 'mine', 'self');
    expect(f.myHazards).toEqual({});
    expect(f.theirHazards).toEqual({ stickyWeb: true });
  });

  test('defog clears hazards and screens on both sides', () => {
    const f = applyHazardClear(base, 'theirs', 'defog');
    expect(f.myHazards).toEqual({});
    expect(f.theirHazards).toEqual({});
    expect(f.myReflect).toBe(false);
    expect(f.theirLightScreen).toBe(false);
    // Tailwind is not touched by Defog.
    expect(f.myTailwind).toBe(true);
  });

  test('court-change swaps all side conditions', () => {
    const f = applyHazardClear(base, 'mine', 'court-change');
    expect(f.myHazards).toEqual({ stickyWeb: true });
    expect(f.theirHazards).toEqual({ rocks: true, spikes: 2 });
    expect(f.theirReflect).toBe(true); // was myReflect
    expect(f.myLightScreen).toBe(true); // was theirLightScreen
    expect(f.theirTailwind).toBe(true); // was myTailwind
  });

  test('tidy-up clears hazards on both sides but leaves screens', () => {
    const f = applyHazardClear(base, 'mine', 'tidy-up');
    expect(f.myHazards).toEqual({});
    expect(f.theirHazards).toEqual({});
    expect(f.myReflect).toBe(true);
  });
});

// ---------------- engine integration ----------------

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}

function freshMatch(field: FieldState): Match {
  const myTeam = [
    mon({ species: 'Great Tusk', ability: 'Protosynthesis', moves: ['Rapid Spin'] }),
    mon({ species: 'Corviknight', ability: 'Pressure', moves: ['Defog'] }),
    mon({ species: 'Sneasler', ability: 'Unburden', moves: ['Close Combat'] }),
    mon({ species: 'Flutter Mane', ability: 'Protosynthesis', moves: ['Moonblast'] }),
  ];
  const opponentTeam: OpponentEntry[] = ['Incineroar', 'Amoonguss', 'Garchomp', 'Talonflame']
    .map(species => ({ species, knownMoves: [] }));
  return {
    id: 'test', startedAt: '2026-05-24T00:00:00.000Z',
    myTeam, opponentTeam, bring: [0, 1, 2, 3],
    opponentBrought: [0, 1], turns: [], field,
    active: { mine: [null, null], theirs: [null, null] },
  };
}

const startActive: ActiveIdx = { mine: [0, 1], theirs: [0, 1] };

describe('finalizeTurn: field-clearing moves', () => {
  test('Rapid Spin clears my-side hazards and gives the user +1 Speed', () => {
    const match = freshMatch({ ...NEUTRAL_FIELD, myHazards: { rocks: true, spikes: 1 } });
    const spin: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Rapid Spin', target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      damageHpPercent: 10, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [spin], field: match.field }, activeIdx: startActive });
    expect(r.match.field?.myHazards).toEqual({});
    expect(r.match.myBoosts?.[0]?.spe).toBe(1);
    expect(r.inferenceNotes.some(n => /Rapid Spin cleared/.test(n))).toBe(true);
  });

  test('Defog clears hazards on both sides', () => {
    const match = freshMatch({
      ...NEUTRAL_FIELD,
      myHazards: { rocks: true },
      theirHazards: { spikes: 3 },
    });
    const defog: MoveAction = {
      side: 'mine', attackerSlot: 1, attackerTeamIndex: 1, kind: 'move',
      move: 'Defog', target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [defog], field: match.field }, activeIdx: startActive });
    expect(r.match.field?.myHazards).toEqual({});
    expect(r.match.field?.theirHazards).toEqual({});
  });
});
