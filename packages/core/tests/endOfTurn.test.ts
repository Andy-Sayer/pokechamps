// Residual end-of-turn effects: chip and HP changes applied between turns.
import { describe, test, expect } from 'vitest';
import { endOfTurn, orbStatusFor, weatherAbilityEffect } from '../src/domain/endOfTurn.js';
import type { Match, OpponentEntry, PokemonSet } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, moves: [], ...p };
}

function freshMatch(myTeam: PokemonSet[], oppSpecies: string[]): Match {
  return {
    id: 't', startedAt: '2026-05-29T00:00:00.000Z',
    myTeam, opponentTeam: oppSpecies.map(s => ({ species: s, knownMoves: [] } as OpponentEntry)),
    bring: [0, 1], opponentBrought: [0, 1], turns: [], field: { ...NEUTRAL_FIELD },
    active: { mine: [0, 1], theirs: [0, 1] },
    myCurrentHp: { 0: 100, 1: 100 }, myFainted: [],
  };
}

describe('Leech Seed residual', () => {
  test('drains 1/8 from the seeded foe and heals the seeder', () => {
    const my = mon({ species: 'Scovillain' });
    const m = freshMatch([my], ['Incineroar']);
    // Scovillain (m1) seeded the opp Incineroar (o1).
    m.opponentTeam[0]!.currentHpPercent = 80;
    m.opponentTeam[0]!.leechSeeded = { seederSide: 'mine', seederIndex: 0 };
    m.myCurrentHp![0] = 60;

    const { match: out } = endOfTurn(m, m.field, { mine: [0, null], theirs: [0, null] });

    // Opp loses 12.5% (1/8 of max). Scovillain heals by an equivalent absolute
    // HP, converted to its own % — clamped to 100.
    expect(out.opponentTeam[0]!.currentHpPercent!).toBeCloseTo(80 - 100 / 8, 1);
    expect(out.myCurrentHp![0]).toBeGreaterThan(60);
  });

  test('drain still hits but heal is wasted when the seeder has switched out', () => {
    const m = freshMatch([mon({ species: 'Scovillain' }), mon({ species: 'Garchomp' })], ['Incineroar']);
    m.opponentTeam[0]!.currentHpPercent = 80;
    m.opponentTeam[0]!.leechSeeded = { seederSide: 'mine', seederIndex: 0 }; // seeded by Scovillain
    m.myCurrentHp![1] = 60;
    // Scovillain (idx 0) has switched out — Garchomp (idx 1) is the active slot 0.
    const { match: out } = endOfTurn(m, m.field, { mine: [1, null], theirs: [0, null] });

    expect(out.opponentTeam[0]!.currentHpPercent!).toBeCloseTo(80 - 100 / 8, 1); // drain still hits
    expect(out.myCurrentHp![1]).toBe(60); // Garchomp (active) didn't heal — it wasn't the seeder
    expect(out.myCurrentHp![0]).toBe(100); // benched seeder unchanged
  });

  test('drain can faint the target', () => {
    const m = freshMatch([mon({ species: 'Scovillain' })], ['Incineroar']);
    m.opponentTeam[0]!.currentHpPercent = 5; // below 12.5%
    m.opponentTeam[0]!.leechSeeded = { seederSide: 'mine', seederIndex: 0 };
    const { match: out } = endOfTurn(m, m.field, { mine: [0, null], theirs: [0, null] });
    expect(out.opponentTeam[0]!.currentHpPercent).toBe(0);
    expect(out.opponentTeam[0]!.fainted).toBe(true);
  });
});

describe('orbStatusFor', () => {
  test('Toxic Orb inflicts tox on neutral type', () => {
    expect(orbStatusFor('Toxic Orb', 'Incineroar', undefined)).toBe('tox');
  });
  test('Toxic Orb does nothing on Poison type', () => {
    expect(orbStatusFor('Toxic Orb', 'Toxapex', undefined)).toBeNull();
  });
  test('Toxic Orb does nothing on Steel type', () => {
    expect(orbStatusFor('Toxic Orb', 'Ferrothorn', undefined)).toBeNull();
  });
  test('Flame Orb inflicts brn on neutral type', () => {
    expect(orbStatusFor('Flame Orb', 'Urshifu', undefined)).toBe('brn');
  });
  test('Flame Orb does nothing on Fire type', () => {
    expect(orbStatusFor('Flame Orb', 'Incineroar', undefined)).toBeNull();
  });
  test('orb does nothing when already statused', () => {
    expect(orbStatusFor('Toxic Orb', 'Incineroar', 'brn')).toBeNull();
  });
  test('orb does nothing when item is null/undefined', () => {
    expect(orbStatusFor(null, 'Incineroar', undefined)).toBeNull();
    expect(orbStatusFor(undefined, 'Incineroar', undefined)).toBeNull();
  });

  test('Toxic Orb applies tox via endOfTurn on my active', () => {
    const m = freshMatch([mon({ species: 'Incineroar', item: 'Toxic Orb' })], ['Scovillain']);
    const { match: out, notes } = endOfTurn(m, m.field, { mine: [0, null], theirs: [0, null] });
    expect(out.myStatus![0]).toBe('tox');
    expect(notes.some(n => n.includes('tox'))).toBe(true);
  });

  test('Flame Orb applies brn via endOfTurn on opp active when item is known', () => {
    const m = freshMatch([mon({ species: 'Scovillain' })], ['Urshifu']);
    m.opponentTeam[0]!.item = 'Flame Orb';
    const { match: out, notes } = endOfTurn(m, m.field, { mine: [0, null], theirs: [0, null] });
    expect(out.opponentTeam[0]!.status).toBe('brn');
    expect(notes.some(n => n.includes('brn'))).toBe(true);
  });

  test('orb does not fire again if already statused from prior EOT', () => {
    const m = freshMatch([mon({ species: 'Incineroar', item: 'Toxic Orb' })], ['Scovillain']);
    m.myStatus = { 0: 'tox' };
    m.myToxCounter = { 0: 2 };
    const { match: out } = endOfTurn(m, m.field, { mine: [0, null], theirs: [0, null] });
    // Status stays tox, counter increments (chip from existing tox)
    expect(out.myStatus![0]).toBe('tox');
    expect(out.myToxCounter![0]).toBe(3);
  });
});

describe('weatherAbilityEffect', () => {
  test('Rain Dish heals 1/16 in rain', () => {
    expect(weatherAbilityEffect('Rain', 'raindish')).toBeCloseTo(100 / 16, 5);
  });
  test('Rain Dish does nothing outside rain', () => {
    expect(weatherAbilityEffect('Sun', 'raindish')).toBe(0);
    expect(weatherAbilityEffect(null, 'raindish')).toBe(0);
  });
  test('Dry Skin heals 1/8 in rain', () => {
    expect(weatherAbilityEffect('Rain', 'dryskin')).toBeCloseTo(100 / 8, 5);
  });
  test('Dry Skin damages 1/8 in sun', () => {
    expect(weatherAbilityEffect('Sun', 'dryskin')).toBeCloseTo(-(100 / 8), 5);
  });
  test('Dry Skin and Heavy Rain / Harsh Sunshine', () => {
    expect(weatherAbilityEffect('Heavy Rain', 'dryskin')).toBeCloseTo(100 / 8, 5);
    expect(weatherAbilityEffect('Harsh Sunshine', 'dryskin')).toBeCloseTo(-(100 / 8), 5);
  });
  test('Ice Body heals 1/16 in Hail', () => {
    expect(weatherAbilityEffect('Hail', 'icebody')).toBeCloseTo(100 / 16, 5);
  });
  test('Ice Body heals 1/16 in Snow', () => {
    expect(weatherAbilityEffect('Snow', 'icebody')).toBeCloseTo(100 / 16, 5);
  });
  test('Ice Body does nothing in rain', () => {
    expect(weatherAbilityEffect('Rain', 'icebody')).toBe(0);
  });
  test('Solar Power chips 1/8 in sun', () => {
    expect(weatherAbilityEffect('Sun', 'solarpower')).toBeCloseTo(-(100 / 8), 5);
  });
  test('Solar Power does nothing in rain', () => {
    expect(weatherAbilityEffect('Rain', 'solarpower')).toBe(0);
  });

  test('Rain Dish heals my mon in rain via endOfTurn', () => {
    const ludicolo = mon({ species: 'Ludicolo', ability: 'Rain Dish' });
    const m = freshMatch([ludicolo], ['Incineroar']);
    m.myCurrentHp = { 0: 60 };
    const rainField = { ...NEUTRAL_FIELD, weather: 'Rain' as const };
    const { match: out } = endOfTurn(m, rainField, { mine: [0, null], theirs: [0, null] });
    expect(out.myCurrentHp![0]).toBeGreaterThan(60);
  });

  test('Solar Power chips opp mon in sun when ability is known', () => {
    const m = freshMatch([mon({ species: 'Scovillain' })], ['Charizard']);
    m.opponentTeam[0]!.ability = 'Solar Power';
    m.opponentTeam[0]!.currentHpPercent = 80;
    const sunField = { ...NEUTRAL_FIELD, weather: 'Sun' as const };
    const { match: out } = endOfTurn(m, sunField, { mine: [0, null], theirs: [0, null] });
    expect(out.opponentTeam[0]!.currentHpPercent).toBeLessThan(80);
  });

  test('Solar Power does NOT chip opp mon when ability is unknown', () => {
    const m = freshMatch([mon({ species: 'Scovillain' })], ['Charizard']);
    m.opponentTeam[0]!.currentHpPercent = 80;
    // No ability set on opp
    const sunField = { ...NEUTRAL_FIELD, weather: 'Sun' as const };
    const { match: out } = endOfTurn(m, sunField, { mine: [0, null], theirs: [0, null] });
    expect(out.opponentTeam[0]!.currentHpPercent).toBe(80);
  });
});

describe('Bad Dreams chips sleeping foes', () => {
  test('my Bad Dreams holder chips sleeping opp each EOT', () => {
    const darkrai = mon({ species: 'Incineroar', ability: 'Bad Dreams' }); // use Incineroar as proxy
    const m = freshMatch([darkrai], ['Amoonguss']);
    m.opponentTeam[0]!.currentHpPercent = 80;
    m.opponentTeam[0]!.status = 'slp';
    m.opponentTeam[0]!.sleepCounter = 3;
    const { match: out, notes } = endOfTurn(m, m.field, { mine: [0, null], theirs: [0, null] });
    expect(out.opponentTeam[0]!.currentHpPercent).toBeCloseTo(80 - 100 / 8, 1);
    expect(notes.some(n => n.includes('Bad Dreams'))).toBe(true);
  });

  test('Bad Dreams does not chip a non-sleeping opp', () => {
    const darkrai = mon({ species: 'Incineroar', ability: 'Bad Dreams' });
    const m = freshMatch([darkrai], ['Amoonguss']);
    m.opponentTeam[0]!.currentHpPercent = 80;
    // No status
    const { match: out } = endOfTurn(m, m.field, { mine: [0, null], theirs: [0, null] });
    expect(out.opponentTeam[0]!.currentHpPercent).toBe(80);
  });

  test('opp Bad Dreams chips my sleeping mon when opp ability known', () => {
    const m = freshMatch([mon({ species: 'Amoonguss' })], ['Incineroar']);
    m.opponentTeam[0]!.ability = 'Bad Dreams';
    m.myCurrentHp = { 0: 80 };
    m.myStatus = { 0: 'slp' };
    m.mySleepCounter = { 0: 3 };
    const { match: out } = endOfTurn(m, m.field, { mine: [0, null], theirs: [0, null] });
    expect(out.myCurrentHp![0]).toBeCloseTo(80 - 100 / 8, 1);
  });
});
