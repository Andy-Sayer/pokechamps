import { describe, test, expect } from 'vitest';
import { scoreBrings, resolvedOpponentSet } from '../src/domain/bring.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';

function mon(partial: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return {
    level: 50,
    nature: 'Hardy',
    evs: { hp: 0, atk: 252, def: 0, spa: 252, spd: 4, spe: 0 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    ...partial,
  };
}

function baseTeam(): PokemonSet[] {
  return [
    mon({ species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake', 'Dragon Claw', 'Rock Slide', 'Protect'] }),
    mon({ species: 'Gardevoir', ability: 'Trace', moves: ['Moonblast', 'Psychic', 'Shadow Ball', 'Protect'] }),
    mon({ species: 'Heracross', ability: 'Guts', moves: ['Close Combat', 'Megahorn', 'Rock Slide', 'Protect'] }),
    mon({ species: 'Tyranitar', ability: 'Sand Stream', moves: ['Rock Slide', 'Crunch', 'Earthquake', 'Protect'] }),
    mon({ species: 'Sylveon', ability: 'Pixilate', moves: ['Hyper Voice', 'Shadow Ball', 'Psyshock', 'Protect'] }),
    mon({ species: 'Excadrill', ability: 'Sand Rush', moves: ['Earthquake', 'Iron Head', 'Rock Slide', 'Protect'] }),
  ];
}

function defaultOpponents(): OpponentEntry[] {
  return [
    { species: 'Charizard', knownMoves: ['Flamethrower'] },
    { species: 'Venusaur', knownMoves: ['Giga Drain'] },
    { species: 'Blastoise', knownMoves: ['Hydro Pump'] },
    { species: 'Pikachu', knownMoves: ['Thunderbolt'] },
  ];
}

describe('scoreBrings', () => {
  test('returns exactly C(6,4) = 15 entries', () => {
    const result = scoreBrings(baseTeam(), defaultOpponents());
    expect(result).toHaveLength(15);
  });

  test('each BringScore has 4 unique indices in 0..5', () => {
    const result = scoreBrings(baseTeam(), defaultOpponents());
    for (const score of result) {
      expect(score.myIndices).toHaveLength(4);
      const unique = new Set(score.myIndices);
      expect(unique.size).toBe(4);
      for (const idx of score.myIndices) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThanOrEqual(5);
      }
    }
  });

  test('results are sorted by total descending', () => {
    const result = scoreBrings(baseTeam(), defaultOpponents());
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1]!.total).toBeGreaterThanOrEqual(result[i]!.total);
    }
  });

  test('per-score axes are non-negative; rationale array exists', () => {
    const result = scoreBrings(baseTeam(), defaultOpponents());
    for (const s of result) {
      expect(s.offense).toBeGreaterThanOrEqual(0);
      expect(s.defense).toBeGreaterThanOrEqual(0);
      expect(s.speed).toBeGreaterThanOrEqual(0);
      expect(s.roles).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(s.rationale)).toBe(true);
    }
  });

  test('broken species does not crash — safeScore keeps slot at 0', () => {
    const team = baseTeam();
    team[2] = mon({ species: 'NotARealMon', ability: 'Pressure', moves: ['Tackle'] });
    const result = scoreBrings(team, defaultOpponents());
    expect(result).toHaveLength(15);
    // Each bring should still be a structurally valid score
    for (const s of result) {
      expect(s.myIndices).toHaveLength(4);
      expect(Number.isFinite(s.total)).toBe(true);
    }
  });

  test('speed-control mon (Tailwind) raises the roles axis when included', () => {
    const team = baseTeam();
    // Inject Tailwind onto slot 4 (Sylveon).
    team[4] = mon({
      species: 'Sylveon',
      ability: 'Pixilate',
      moves: ['Hyper Voice', 'Tailwind', 'Psyshock', 'Protect'],
    });
    const result = scoreBrings(team, defaultOpponents());
    const includes4 = result.filter(s => s.myIndices.includes(4));
    const excludes4 = result.filter(s => !s.myIndices.includes(4));
    expect(includes4.length).toBeGreaterThan(0);
    expect(excludes4.length).toBeGreaterThan(0);
    // Every bring that includes the Tailwind mon must score roles > 0;
    // every bring that excludes it must score roles == 0 from speed control.
    for (const s of includes4) expect(s.roles).toBeGreaterThanOrEqual(30);
    for (const s of excludes4) expect(s.roles).toBe(0);
  });

  test('redirection (Lightning Rod ability) raises roles when included', () => {
    const team = baseTeam();
    team[1] = mon({
      species: 'Manectric',
      ability: 'Lightning Rod',
      moves: ['Thunderbolt', 'Volt Switch', 'Overheat', 'Protect'],
    });
    const result = scoreBrings(team, defaultOpponents());
    const includes1 = result.filter(s => s.myIndices.includes(1));
    const excludes1 = result.filter(s => !s.myIndices.includes(1));
    expect(includes1.length).toBeGreaterThan(0);
    expect(excludes1.length).toBeGreaterThan(0);
    for (const s of includes1) expect(s.roles).toBeGreaterThanOrEqual(20);
    for (const s of excludes1) expect(s.roles).toBe(0);
  });

  test('redirection (Follow Me move) raises roles when included', () => {
    const team = baseTeam();
    team[3] = mon({
      species: 'Clefable',
      ability: 'Unaware',
      moves: ['Follow Me', 'Moonblast', 'Protect', 'Helping Hand'],
    });
    const result = scoreBrings(team, defaultOpponents());
    const includes3 = result.filter(s => s.myIndices.includes(3));
    expect(includes3.length).toBeGreaterThan(0);
    for (const s of includes3) expect(s.roles).toBeGreaterThanOrEqual(20);
  });
});

describe('resolvedOpponentSet', () => {
  test('returns first candidate when candidates are present', () => {
    const cand: PokemonSet = mon({
      species: 'Charizard',
      ability: 'Blaze',
      item: 'Charcoal',
      moves: ['Flamethrower', 'Air Slash', 'Solar Beam', 'Protect'],
    });
    const entry: OpponentEntry = { species: 'Charizard', knownMoves: [], candidates: [cand] };
    expect(resolvedOpponentSet(entry, 50)).toBe(cand);
  });

  test('falls back to a synthesized default set when candidates are missing', () => {
    const entry: OpponentEntry = { species: 'Charizard', knownMoves: ['Flamethrower'] };
    const set = resolvedOpponentSet(entry, 50);
    expect(set.species.toLowerCase()).toContain('charizard');
    expect(set.level).toBe(50);
    expect(set.moves).toContain('Flamethrower');
  });

  test('default set uses Tackle when no moves are known', () => {
    const entry: OpponentEntry = { species: 'Pikachu', knownMoves: [] };
    const set = resolvedOpponentSet(entry, 50);
    expect(set.moves).toEqual(['Tackle']);
  });
});
