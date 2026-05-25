import type { FieldState } from './types.js';
import { EFFECT_DURATIONS } from './durations.js';

// Field-setting moves. Weather / terrain / Trick Room / Tailwind / screens are
// logged as ordinary (usually targetless) move actions — the parser already
// accepts them (see turnparser's no-target shape) but nothing applied their
// effect to the field. Detect them by name in finalizeTurn and mutate the
// field so the matchup grid's damage/speed calcs reflect them.
//
// Durations aren't modelled (consistent with the rest of FieldState, which is
// a set/cleared snapshot) — the user logs the move because it succeeded, and
// can clear it later (e.g. weather overwritten, Defog removes screens).

export interface FieldMoveEffect {
  weather?: NonNullable<FieldState['weather']>;
  terrain?: NonNullable<FieldState['terrain']>;
  trickRoom?: 'toggle'; // Trick Room flips on/off each use
  tailwind?: boolean; // sets the USER's side tailwind
  reflect?: boolean; // USER's side
  lightScreen?: boolean; // USER's side
  auroraVeil?: boolean; // USER's side — modelled as Reflect + Light Screen
}

const WEATHER_MOVES: Record<string, NonNullable<FieldState['weather']>> = {
  'Sunny Day': 'Sun',
  'Rain Dance': 'Rain',
  Sandstorm: 'Sand',
  Snowscape: 'Snow',
  'Chilly Reception': 'Snow', // also a pivot move; the switch is handled separately
};

const TERRAIN_MOVES: Record<string, NonNullable<FieldState['terrain']>> = {
  'Electric Terrain': 'Electric',
  'Grassy Terrain': 'Grassy',
  'Misty Terrain': 'Misty',
  'Psychic Terrain': 'Psychic',
};

export function fieldMoveEffect(move: string): FieldMoveEffect | null {
  const e: FieldMoveEffect = {};
  const w = WEATHER_MOVES[move];
  if (w) e.weather = w;
  const t = TERRAIN_MOVES[move];
  if (t) e.terrain = t;
  if (move === 'Trick Room') e.trickRoom = 'toggle';
  if (move === 'Tailwind') e.tailwind = true;
  if (move === 'Reflect') e.reflect = true;
  if (move === 'Light Screen') e.lightScreen = true;
  if (move === 'Aurora Veil') e.auroraVeil = true;
  return Object.keys(e).length ? e : null;
}

// Apply a field-setting move from the user's side. Returns a fresh FieldState.
export function applyFieldMove(
  field: FieldState,
  userSide: 'mine' | 'theirs',
  e: FieldMoveEffect,
): FieldState {
  const f: FieldState = { ...field };
  if (e.weather) { f.weather = e.weather; f.weatherTurns = EFFECT_DURATIONS.weather; }
  if (e.terrain) f.terrain = e.terrain;
  if (e.trickRoom === 'toggle') {
    f.trickRoom = !f.trickRoom;
    f.trickRoomTurns = f.trickRoom ? EFFECT_DURATIONS.trickRoom : undefined;
  }
  if (e.tailwind) { if (userSide === 'mine') f.myTailwind = true; else f.theirTailwind = true; }
  if (e.reflect) { if (userSide === 'mine') f.myReflect = true; else f.theirReflect = true; }
  if (e.lightScreen) { if (userSide === 'mine') f.myLightScreen = true; else f.theirLightScreen = true; }
  if (e.auroraVeil) {
    if (userSide === 'mine') { f.myReflect = true; f.myLightScreen = true; }
    else { f.theirReflect = true; f.theirLightScreen = true; }
  }
  return f;
}
