import { describe, test, expect } from 'vitest';
import { predictOffense, predictOffenseAll, predictThreat, predictThreatAll, speedVerdict } from '../src/domain/predictions.js';
import type { PokemonSet, OpponentEntry, FieldState } from '../src/domain/types.js';
import { NEUTRAL_FIELD, MAX_IVS, ZERO_EVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return {
    level: 50,
    nature: 'Hardy',
    evs: { ...ZERO_EVS },
    ivs: MAX_IVS,
    ...p,
  };
}

const incineroar = mon({
  species: 'Incineroar', ability: 'Intimidate', nature: 'Careful',
  evs: { hp: 244, atk: 0, def: 0, spa: 0, spd: 252, spe: 12 },
  moves: ['Flare Blitz', 'Knock Off', 'Fake Out', 'Parting Shot'],
});

describe('predictOffense', () => {
  const sneasler = mon({
    species: 'Sneasler', ability: 'Unburden', nature: 'Jolly',
    evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
    moves: ['Close Combat', 'Dire Claw', 'Fake Out', 'Protect'],
  });

  test('returns a non-null cell against a known defender', () => {
    const opp: OpponentEntry = { species: 'Incineroar', knownMoves: [], candidates: [incineroar] };
    const r = predictOffense({ attacker: sneasler, opponent: opp, field: NEUTRAL_FIELD });
    expect(r).not.toBeNull();
    expect(r!.move).toBe('Close Combat'); // 4x effective
    expect(r!.maxPercent).toBeGreaterThan(0);
    expect(r!.candidatesConsidered).toBe(1);
  });

  test('range widens when opponent has multiple candidate spreads', () => {
    const opp: OpponentEntry = { species: 'Incineroar', knownMoves: [], candidates: [incineroar] };
    const single = predictOffense({ attacker: sneasler, opponent: opp, field: NEUTRAL_FIELD })!;

    const beefier = mon({
      ...incineroar,
      evs: { hp: 252, atk: 0, def: 4, spa: 0, spd: 252, spe: 0 },
    });
    const opp3: OpponentEntry = { species: 'Incineroar', knownMoves: [], candidates: [incineroar, beefier] };
    const multi = predictOffense({ attacker: sneasler, opponent: opp3, field: NEUTRAL_FIELD })!;

    expect(multi.candidatesConsidered).toBe(2);
    // Multi-candidate range should be at least as wide as the single
    const singleWidth = single.maxPercent - single.minPercent;
    const multiWidth = multi.maxPercent - multi.minPercent;
    expect(multiWidth).toBeGreaterThanOrEqual(singleWidth);
  });

  test('uses defaultOpponentSet when candidates is empty', () => {
    const opp: OpponentEntry = { species: 'Incineroar', knownMoves: [] };
    const r = predictOffense({ attacker: sneasler, opponent: opp, field: NEUTRAL_FIELD });
    expect(r).not.toBeNull();
    expect(r!.candidatesConsidered).toBe(1);
  });
});

describe('predictOffenseAll', () => {
  const sneasler = mon({
    species: 'Sneasler', ability: 'Unburden', nature: 'Jolly',
    evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
    moves: ['Close Combat', 'Dire Claw', 'Fake Out', 'Protect'],
  });

  test('returns one entry per damaging move, sorted by max desc', () => {
    const opp: OpponentEntry = { species: 'Incineroar', knownMoves: [], candidates: [incineroar] };
    const rows = predictOffenseAll({ attacker: sneasler, opponent: opp, field: NEUTRAL_FIELD });
    // Status-only / failing moves get skipped silently; we expect at least the
    // damaging ones (Close Combat, Dire Claw, Fake Out) — Protect won't compute.
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const moves = rows.map(r => r.move);
    expect(moves).toContain('Close Combat');
    expect(moves).toContain('Dire Claw');
    // Sort: max descending.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.maxPercent).toBeGreaterThanOrEqual(rows[i]!.maxPercent);
    }
    // Close Combat is 4x effective vs Incineroar → should be the top entry.
    expect(rows[0]!.move).toBe('Close Combat');
  });

  test('returns empty when opp species has no candidate spreads at all', () => {
    const opp: OpponentEntry = { species: 'NotAPokemon' as string, knownMoves: [] };
    const rows = predictOffenseAll({ attacker: sneasler, opponent: opp, field: NEUTRAL_FIELD });
    expect(rows).toEqual([]);
  });
});

describe('predictThreat', () => {
  const mySneasler = mon({
    species: 'Sneasler', nature: 'Jolly',
    evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
    moves: [],
  });

  test('uses knownMoves when present (not Pikalytics moves)', () => {
    // Constrain known to one damaging move; verify it's picked even though
    // Pikalytics' top Incineroar moves include several stronger options.
    const opp: OpponentEntry = {
      species: 'Incineroar',
      knownMoves: ['Knock Off'],
      candidates: [incineroar],
    };
    const r = predictThreat({ opponent: opp, defender: mySneasler, field: NEUTRAL_FIELD });
    expect(r).not.toBeNull();
    expect(r!.move).toBe('Knock Off');
    expect(r!.maxPercent).toBeGreaterThan(0);
  });

  test('falls back to Pikalytics top moves when knownMoves is empty', () => {
    const opp: OpponentEntry = { species: 'Incineroar', knownMoves: [], candidates: [incineroar] };
    const r = predictThreat({ opponent: opp, defender: mySneasler, field: NEUTRAL_FIELD });
    expect(r).not.toBeNull();
    // Pikalytics' top Incineroar moves should include Flare Blitz / Knock Off etc.
    expect(['Flare Blitz', 'Knock Off', 'Fake Out', 'Parting Shot']).toContain(r!.move);
    expect(r!.maxPercent).toBeGreaterThan(0);
  });

  test('returns null when nothing can be calculated', () => {
    const opp: OpponentEntry = { species: 'Nonexistmon', knownMoves: [] };
    const r = predictThreat({ opponent: opp, defender: mySneasler, field: NEUTRAL_FIELD });
    // species unknown + no moves -> null
    expect(r).toBeNull();
  });
});

describe('predictThreatAll', () => {
  const mySneasler = mon({
    species: 'Sneasler', nature: 'Jolly',
    evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
    moves: [],
  });

  test('returns one row per known move, sorted by max desc', () => {
    const opp: OpponentEntry = { species: 'Incineroar', knownMoves: ['Knock Off', 'Flare Blitz'], candidates: [incineroar] };
    const rows = predictThreatAll({ opponent: opp, defender: mySneasler, field: NEUTRAL_FIELD });
    const moves = rows.map(r => r.move);
    expect(moves).toContain('Knock Off');
    expect(moves).toContain('Flare Blitz');
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.maxPercent).toBeGreaterThanOrEqual(rows[i]!.maxPercent);
    }
  });

  test('falls back to Pikalytics expected moves when knownMoves is empty', () => {
    const opp: OpponentEntry = { species: 'Incineroar', knownMoves: [], candidates: [incineroar] };
    const rows = predictThreatAll({ opponent: opp, defender: mySneasler, field: NEUTRAL_FIELD });
    expect(rows.length).toBeGreaterThan(0);
    // Expected Incineroar moves come from Pikalytics, not an empty list.
    expect(rows.some(r => ['Flare Blitz', 'Knock Off', 'Fake Out', 'Parting Shot'].includes(r.move))).toBe(true);
  });

  test('an Encore lock collapses the pool to the single forced move', () => {
    const opp: OpponentEntry = { species: 'Incineroar', knownMoves: ['Knock Off', 'Flare Blitz'], encoreMove: 'Flare Blitz', candidates: [incineroar] };
    const rows = predictThreatAll({ opponent: opp, defender: mySneasler, field: NEUTRAL_FIELD });
    expect(rows.map(r => r.move)).toEqual(['Flare Blitz']);
  });
});

describe('speedVerdict', () => {
  const fast = mon({
    species: 'Sneasler', nature: 'Jolly',
    evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
    moves: [],
  });

  test('faster when opp ceiling is below my speed', () => {
    const opp: OpponentEntry = { species: 'Incineroar', knownMoves: [], speedCeiling: 100 };
    expect(speedVerdict({ mySet: fast, opp, field: NEUTRAL_FIELD })).toBe('faster');
  });

  test('slower when opp floor exceeds my speed', () => {
    const opp: OpponentEntry = { species: 'Sneasler', knownMoves: [], speedFloor: 1000 };
    expect(speedVerdict({ mySet: fast, opp, field: NEUTRAL_FIELD })).toBe('slower');
  });

  test('unknown when no bounds set', () => {
    const opp: OpponentEntry = { species: 'Whimsicott', knownMoves: [] };
    expect(speedVerdict({ mySet: fast, opp, field: NEUTRAL_FIELD })).toBe('unknown');
  });

  test('scarf-flag overrides other verdicts when scarfSuspected is true', () => {
    const opp: OpponentEntry = { species: 'Incineroar', knownMoves: [], speedCeiling: 100, scarfSuspected: true };
    expect(speedVerdict({ mySet: fast, opp, field: NEUTRAL_FIELD })).toBe('scarf-flag');
  });

  test('my tailwind doubles my effective speed (flips slower → faster on borderline)', () => {
    // Need both bounds: my 178 starts below opp.floor=200 (definitely slower),
    // tailwind doubles me to 356 which is above opp.ceiling=300 (definitely
    // faster). Only with both bounds known can we conclude definitively.
    const opp: OpponentEntry = {
      species: 'Talonflame', knownMoves: [],
      speedFloor: 200, speedCeiling: 300,
    };
    expect(speedVerdict({ mySet: fast, opp, field: NEUTRAL_FIELD })).toBe('slower');
    expect(speedVerdict({ mySet: fast, opp, field: { ...NEUTRAL_FIELD, myTailwind: true } })).toBe('faster');
  });

  test('trick room inverts faster/slower', () => {
    const opp: OpponentEntry = { species: 'Incineroar', knownMoves: [], speedCeiling: 100 };
    // Without TR: my 178 > their 100 → faster
    expect(speedVerdict({ mySet: fast, opp, field: NEUTRAL_FIELD })).toBe('faster');
    // With TR: my 178 > their 100 → I'm slower in turn order → 'slower'
    expect(speedVerdict({ mySet: fast, opp, field: { ...NEUTRAL_FIELD, trickRoom: true } })).toBe('slower');
  });
});

describe('percentRolls — spread + roll distribution for KO odds', () => {
  const flutter = mon({
    species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid',
    evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Moonblast'],
  });

  test('is populated and pools rolls across candidate spreads', () => {
    const bulky = mon({ species: 'Garchomp', nature: 'Jolly', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: [] });
    const frail = mon({ species: 'Garchomp', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: [] });
    const opp: OpponentEntry = { species: 'Garchomp', knownMoves: [], candidates: [bulky, frail] };
    const off = predictOffense({ attacker: flutter, opponent: opp, field: NEUTRAL_FIELD });
    // Rolls pooled across BOTH spreads (16 each) → distribution spans bulk uncertainty.
    expect(off!.percentRolls!.length).toBeGreaterThan(16);
    expect(Math.min(...off!.percentRolls!)).toBeLessThan(Math.max(...off!.percentRolls!));
  });
});
