// Field-setting moves (weather / terrain / Trick Room / Tailwind / screens):
// unit tests for the effect table + applyFieldMove, plus engine integration.
import { describe, test, expect } from 'vitest';
import { fieldMoveEffect, applyFieldMove } from '../src/domain/fieldMoves.js';
import { weatherDuration, screenDuration } from '../src/domain/durations.js';
import { finalizeTurn, type ActiveIdx } from '../src/match/engine.js';
import type { Match, PokemonSet, OpponentEntry, MoveAction, FieldState } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

describe('fieldMoveEffect', () => {
  test('weather moves', () => {
    expect(fieldMoveEffect('Sunny Day')?.weather).toBe('Sun');
    expect(fieldMoveEffect('Rain Dance')?.weather).toBe('Rain');
    expect(fieldMoveEffect('Sandstorm')?.weather).toBe('Sand');
    expect(fieldMoveEffect('Snowscape')?.weather).toBe('Snow');
    expect(fieldMoveEffect('Chilly Reception')?.weather).toBe('Snow');
  });
  test('terrain moves', () => {
    expect(fieldMoveEffect('Electric Terrain')?.terrain).toBe('Electric');
    expect(fieldMoveEffect('Grassy Terrain')?.terrain).toBe('Grassy');
    expect(fieldMoveEffect('Misty Terrain')?.terrain).toBe('Misty');
    expect(fieldMoveEffect('Psychic Terrain')?.terrain).toBe('Psychic');
  });
  test('room / tailwind / screens', () => {
    expect(fieldMoveEffect('Trick Room')?.trickRoom).toBe('toggle');
    expect(fieldMoveEffect('Tailwind')?.tailwind).toBe(true);
    expect(fieldMoveEffect('Reflect')?.reflect).toBe(true);
    expect(fieldMoveEffect('Light Screen')?.lightScreen).toBe(true);
    expect(fieldMoveEffect('Aurora Veil')?.auroraVeil).toBe(true);
  });
  test('non-field moves return null', () => {
    expect(fieldMoveEffect('Earthquake')).toBeNull();
    expect(fieldMoveEffect('Protect')).toBeNull();
  });
});

describe('weatherDuration', () => {
  test('defaults to 5 turns without an item', () => {
    expect(weatherDuration()).toBe(5);
    expect(weatherDuration(null)).toBe(5);
    expect(weatherDuration(undefined)).toBe(5);
  });
  test('extends to 8 turns with Damp Rock / Heat Rock / Smooth Rock / Icy Rock', () => {
    expect(weatherDuration('Damp Rock')).toBe(8);
    expect(weatherDuration('Heat Rock')).toBe(8);
    expect(weatherDuration('Smooth Rock')).toBe(8);
    expect(weatherDuration('Icy Rock')).toBe(8);
  });
  test('stays at 5 turns with unrelated items', () => {
    expect(weatherDuration('Choice Scarf')).toBe(5);
    expect(weatherDuration('Assault Vest')).toBe(5);
  });
});

describe('screenDuration', () => {
  test('defaults to 5 turns without Light Clay', () => {
    expect(screenDuration()).toBe(5);
    expect(screenDuration(null)).toBe(5);
    expect(screenDuration(undefined)).toBe(5);
  });
  test('extends to 8 turns with Light Clay', () => {
    expect(screenDuration('Light Clay')).toBe(8);
  });
  test('stays at 5 turns with unrelated items', () => {
    expect(screenDuration('Choice Scarf')).toBe(5);
    expect(screenDuration('Heat Rock')).toBe(5);
  });
});

describe('applyFieldMove', () => {
  test('Trick Room toggles', () => {
    const on = applyFieldMove(NEUTRAL_FIELD, 'mine', { trickRoom: 'toggle' });
    expect(on.trickRoom).toBe(true);
    const off = applyFieldMove(on, 'theirs', { trickRoom: 'toggle' });
    expect(off.trickRoom).toBe(false);
  });
  test('Tailwind / screens apply to the user side only', () => {
    const f = applyFieldMove(NEUTRAL_FIELD, 'theirs', { tailwind: true });
    expect(f.theirTailwind).toBe(true);
    expect(f.myTailwind).toBe(false);
    const r = applyFieldMove(NEUTRAL_FIELD, 'mine', { reflect: true });
    expect(r.myReflect).toBe(true);
    expect(r.theirReflect).toBe(false);
  });
  test('Aurora Veil sets both screens on the user side', () => {
    const f = applyFieldMove(NEUTRAL_FIELD, 'mine', { auroraVeil: true });
    expect(f.myReflect).toBe(true);
    expect(f.myLightScreen).toBe(true);
  });
  test('weather duration defaults to 5 turns', () => {
    const f = applyFieldMove(NEUTRAL_FIELD, 'mine', { weather: 'Sun' });
    expect(f.weather).toBe('Sun');
    expect(f.weatherTurns).toBe(5);
  });
  test('weather duration extends to 8 with Heat Rock', () => {
    const f = applyFieldMove(NEUTRAL_FIELD, 'mine', { weather: 'Sun' }, 'Heat Rock');
    expect(f.weatherTurns).toBe(8);
  });
  test('screen duration defaults to 5 turns', () => {
    const f = applyFieldMove(NEUTRAL_FIELD, 'mine', { reflect: true });
    expect(f.myReflect).toBe(true);
    expect(f.myReflectTurns).toBe(5);
  });
  test('screen duration extends to 8 with Light Clay', () => {
    const f = applyFieldMove(NEUTRAL_FIELD, 'mine', { lightScreen: true }, 'Light Clay');
    expect(f.myLightScreenTurns).toBe(8);
  });
  test('Aurora Veil respects Light Clay for both screens', () => {
    const f = applyFieldMove(NEUTRAL_FIELD, 'mine', { auroraVeil: true }, 'Light Clay');
    expect(f.myReflectTurns).toBe(8);
    expect(f.myLightScreenTurns).toBe(8);
  });
});

// ---------------- engine integration ----------------

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}

function freshMatch(field: FieldState): Match {
  const myTeam = [
    mon({ species: 'Torkoal', ability: 'Drought', moves: ['Sunny Day', 'Eruption'] }),
    mon({ species: 'Indeedee', ability: 'Psychic Surge', moves: ['Trick Room', 'Expanding Force'] }),
    mon({ species: 'Sneasler', ability: 'Unburden', moves: ['Tailwind'] }),
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

describe('finalizeTurn: field-setting moves', () => {
  test('Sunny Day sets Sun', () => {
    const match = freshMatch(NEUTRAL_FIELD);
    const a: MoveAction = { side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move', move: 'Sunny Day', target: 'self', order: 1 };
    const r = finalizeTurn({ match, turn: { actions: [a], field: match.field }, activeIdx: startActive });
    expect(r.match.field?.weather).toBe('Sun');
  });

  test('Trick Room from an opp action toggles trickRoom on', () => {
    const match = freshMatch(NEUTRAL_FIELD);
    const a: MoveAction = { side: 'theirs', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move', move: 'Trick Room', target: 'self', order: 1 };
    const r = finalizeTurn({ match, turn: { actions: [a], field: match.field }, activeIdx: startActive });
    expect(r.match.field?.trickRoom).toBe(true);
  });

  test('Tailwind sets the acting side tailwind only', () => {
    const match = freshMatch(NEUTRAL_FIELD);
    const a: MoveAction = { side: 'mine', attackerSlot: 0, attackerTeamIndex: 2, kind: 'move', move: 'Tailwind', target: 'self', order: 1 };
    const r = finalizeTurn({ match, turn: { actions: [a], field: match.field }, activeIdx: startActive });
    expect(r.match.field?.myTailwind).toBe(true);
    expect(r.match.field?.theirTailwind).toBe(false);
  });
});
