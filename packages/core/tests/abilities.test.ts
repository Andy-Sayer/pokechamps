// Switch-in ability triggers (A.2): unit tests for the effect/reaction tables
// plus engine-integration tests proving Intimidate / weather / terrain land on
// the right side's state through finalizeTurn.
import { describe, test, expect } from 'vitest';
import {
  switchInAbilityEffect,
  intimidateReaction,
  certainAbility,
} from '../src/domain/abilities.js';
import { finalizeTurn, type ActiveIdx } from '../src/match/engine.js';
import type { Match, PokemonSet, OpponentEntry, MoveAction } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

describe('switchInAbilityEffect', () => {
  test('Intimidate flags an intimidate effect', () => {
    expect(switchInAbilityEffect('Intimidate')).toEqual({ intimidate: true });
  });
  test('weather setters map to the right weather', () => {
    expect(switchInAbilityEffect('Drought')?.weather).toBe('Sun');
    expect(switchInAbilityEffect('Drizzle')?.weather).toBe('Rain');
    expect(switchInAbilityEffect('Sand Stream')?.weather).toBe('Sand');
    expect(switchInAbilityEffect('Snow Warning')?.weather).toBe('Snow');
  });
  test('terrain setters map to the right terrain', () => {
    expect(switchInAbilityEffect('Electric Surge')?.terrain).toBe('Electric');
    expect(switchInAbilityEffect('Grassy Surge')?.terrain).toBe('Grassy');
    expect(switchInAbilityEffect('Misty Surge')?.terrain).toBe('Misty');
    expect(switchInAbilityEffect('Psychic Surge')?.terrain).toBe('Psychic');
    expect(switchInAbilityEffect('Hadron Engine')?.terrain).toBe('Electric');
  });
  test('self-boost abilities', () => {
    expect(switchInAbilityEffect('Intrepid Sword')?.selfBoosts).toEqual({ atk: 1 });
    expect(switchInAbilityEffect('Dauntless Shield')?.selfBoosts).toEqual({ def: 1 });
  });
  test('abilities with no switch-in effect return null', () => {
    expect(switchInAbilityEffect('Levitate')).toBeNull();
    expect(switchInAbilityEffect(undefined)).toBeNull();
    expect(switchInAbilityEffect(null)).toBeNull();
  });
});

describe('intimidateReaction', () => {
  test('stat-drop blockers prevent the Atk drop', () => {
    expect(intimidateReaction('Clear Body')).toEqual({ blocked: true });
    expect(intimidateReaction('Hyper Cutter')).toEqual({ blocked: true });
    expect(intimidateReaction('Inner Focus')).toEqual({ blocked: true });
  });
  test('Guard Dog blocks the drop and raises Atk instead', () => {
    expect(intimidateReaction('Guard Dog')).toEqual({ blocked: true, reaction: { atk: 1 } });
  });
  test('Defiant / Competitive take the drop but retaliate', () => {
    expect(intimidateReaction('Defiant')).toEqual({ blocked: false, reaction: { atk: 2 } });
    expect(intimidateReaction('Competitive')).toEqual({ blocked: false, reaction: { spa: 2 } });
    expect(intimidateReaction('Rattled')).toEqual({ blocked: false, reaction: { spe: 1 } });
  });
  test('an unrelated ability just takes the drop', () => {
    expect(intimidateReaction('Levitate')).toEqual({ blocked: false });
    expect(intimidateReaction(undefined)).toEqual({ blocked: false });
  });
});

describe('certainAbility', () => {
  test('a known (observed) ability is used directly', () => {
    expect(certainAbility({ knownAbility: 'Intimidate', species: 'Salamence' })).toBe('Intimidate');
  });
  test('a single-ability species resolves even without observation', () => {
    // Gholdengo only has Good as Gold.
    expect(certainAbility({ species: 'Gholdengo' })).toBe('Good as Gold');
  });
  test('a multi-ability species stays uncertain until observed', () => {
    // Salamence: Intimidate / Moxie (H) — can't assume which.
    expect(certainAbility({ species: 'Salamence' })).toBeUndefined();
  });
});

// ---------------- engine integration ----------------

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}

const sneasler = mon({ species: 'Sneasler', ability: 'Unburden', moves: ['Close Combat'] });
const rillaboom = mon({ species: 'Rillaboom', ability: 'Grassy Surge', moves: ['Grassy Glide'] });
const torkoal = mon({ species: 'Torkoal', ability: 'Drought', moves: ['Eruption'] });
const flutterMane = mon({ species: 'Flutter Mane', ability: 'Protosynthesis', moves: ['Moonblast'] });

function freshMatch(opts?: { myTeam?: PokemonSet[]; oppSpecies?: string[] }): Match {
  const myTeam = opts?.myTeam ?? [sneasler, rillaboom, torkoal, flutterMane];
  const oppSpecies = opts?.oppSpecies ?? ['Incineroar', 'Amoonguss', 'Garchomp', 'Talonflame'];
  const opponentTeam: OpponentEntry[] = oppSpecies.map(species => ({ species, knownMoves: [] }));
  return {
    id: 'test', startedAt: '2026-05-24T00:00:00.000Z',
    myTeam, opponentTeam, bring: [0, 1, 2, 3],
    opponentBrought: [0, 1], turns: [], field: NEUTRAL_FIELD,
    active: { mine: [null, null], theirs: [null, null] },
  };
}

const startActive: ActiveIdx = { mine: [0, 1], theirs: [0, 1] };

function oppSwitch(targetTeamIndex: number): MoveAction {
  return { side: 'theirs', attackerSlot: 0, kind: 'switch', move: 'x', target: 'self', targetTeamIndex, order: 1 };
}
function mineSwitch(targetTeamIndex: number): MoveAction {
  return { side: 'mine', attackerSlot: 0, kind: 'switch', move: 'x', target: 'self', targetTeamIndex, order: 1 };
}

describe('finalizeTurn: switch-in abilities', () => {
  test('opp Intimidate drops Atk of both my actives', () => {
    const match = freshMatch();
    match.opponentTeam[2] = { ...match.opponentTeam[2]!, ability: 'Intimidate' };
    const r = finalizeTurn({ match, turn: { actions: [oppSwitch(2)], field: match.field }, activeIdx: startActive });
    expect(r.match.myBoosts?.[0]?.atk).toBe(-1);
    expect(r.match.myBoosts?.[1]?.atk).toBe(-1);
    expect(r.inferenceNotes.some(n => /Intimidate/.test(n))).toBe(true);
  });

  test('Clear Body foe is immune; Defiant foe drops but gains +2 Atk', () => {
    const myTeam = [
      mon({ species: 'Metagross', ability: 'Clear Body', moves: ['Meteor Mash'] }),
      mon({ species: 'Bisharp', ability: 'Defiant', moves: ['Sucker Punch'] }),
      torkoal, flutterMane,
    ];
    const match = freshMatch({ myTeam });
    match.opponentTeam[2] = { ...match.opponentTeam[2]!, ability: 'Intimidate' };
    const r = finalizeTurn({ match, turn: { actions: [oppSwitch(2)], field: match.field }, activeIdx: startActive });
    // Clear Body (slot 0): no change.
    expect(r.match.myBoosts?.[0]?.atk ?? 0).toBe(0);
    // Defiant (slot 1): -1 from Intimidate, +2 reaction = net +1.
    expect(r.match.myBoosts?.[1]?.atk).toBe(1);
  });

  test('uncertain opp ability does not trigger Intimidate', () => {
    // Salamence has Intimidate OR Moxie; unconfirmed, so no drop.
    const match = freshMatch({ oppSpecies: ['Incineroar', 'Amoonguss', 'Salamence', 'Talonflame'] });
    const r = finalizeTurn({ match, turn: { actions: [oppSwitch(2)], field: match.field }, activeIdx: startActive });
    expect(r.match.myBoosts?.[0]?.atk ?? 0).toBe(0);
    expect(r.match.myBoosts?.[1]?.atk ?? 0).toBe(0);
  });

  test('my Drought switch-in sets Sun', () => {
    const match = freshMatch();
    // Torkoal is myTeam[2]; switch it into slot 0.
    const r = finalizeTurn({ match, turn: { actions: [mineSwitch(2)], field: match.field }, activeIdx: startActive });
    expect(r.match.field?.weather).toBe('Sun');
  });

  test('my Grassy Surge switch-in sets Grassy Terrain', () => {
    // Put Rillaboom at an inactive index and switch it in.
    const myTeam = [sneasler, torkoal, rillaboom, flutterMane];
    const match = freshMatch({ myTeam });
    const r = finalizeTurn({ match, turn: { actions: [mineSwitch(2)], field: match.field }, activeIdx: startActive });
    expect(r.match.field?.terrain).toBe('Grassy');
  });
});
