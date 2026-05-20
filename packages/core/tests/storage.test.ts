import { describe, test, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveTeam, listTeams, saveMatch } from '../src/domain/storage.js';
import type { PokemonSet, Match } from '../src/domain/types.js';
import { ZERO_EVS, MAX_IVS, NEUTRAL_FIELD } from '../src/domain/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..', '..');
const teamsDir = join(rootDir, 'data', 'my-teams');
const matchesDir = join(rootDir, 'matches');

// Track files we created so we can clean up even if a test throws.
const createdFiles: string[] = [];

afterEach(() => {
  for (const f of createdFiles.splice(0)) {
    try { rmSync(f, { force: true }); } catch { /* ignore */ }
  }
});

function makeSet(overrides: Partial<PokemonSet> = {}): PokemonSet {
  return {
    species: 'Incineroar',
    level: 50,
    item: 'Sitrus Berry',
    ability: 'Intimidate',
    nature: 'Adamant',
    evs: { ...ZERO_EVS, hp: 244, atk: 4, spd: 12, spe: 244 },
    ivs: { ...MAX_IVS },
    moves: ['Flare Blitz', 'Knock Off', 'Fake Out', 'Parting Shot'],
    ...overrides,
  };
}

describe('storage', () => {
  test('saveTeam writes JSON and listTeams reads it back, preserving every field', () => {
    const name = `vitest-team-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const team: PokemonSet[] = [
      makeSet(),
      makeSet({ species: 'Charizard', item: 'Charizardite Y', ability: 'Blaze', nature: 'Timid',
        evs: { ...ZERO_EVS, spa: 252, spe: 252, hp: 4 },
        ivs: { ...MAX_IVS, atk: 0 },
        moves: ['Heat Wave', 'Solar Beam', 'Protect', 'Tailwind'] }),
    ];
    const path = saveTeam(name, team);
    createdFiles.push(path);

    expect(existsSync(path)).toBe(true);
    expect(path.endsWith(`${name}.json`)).toBe(true);

    const all = listTeams();
    const found = all.find(t => t.name === name);
    expect(found).toBeDefined();
    expect(found!.team).toEqual(team);
  });

  test('special chars in the team name are sanitized to a safe filename', () => {
    const unsafe = `weird / team! ${Date.now()}`;
    const path = saveTeam(unsafe, [makeSet()]);
    createdFiles.push(path);

    const base = basename(path);
    // The filename should contain only [a-zA-Z0-9_-] plus the .json extension.
    expect(base).toMatch(/^[A-Za-z0-9_-]+\.json$/);
    expect(base).not.toContain('/');
    expect(base).not.toContain('!');
    expect(base).not.toContain(' ');
    expect(existsSync(path)).toBe(true);
  });

  test('saveMatch writes a snapshot file at matches/<id>.json', () => {
    const id = `vitest-match-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const match: Match = {
      id,
      startedAt: new Date().toISOString(),
      myTeam: [makeSet()],
      opponentTeam: [],
      bring: [0, 1, 2, 3],
      turns: [],
      field: { ...NEUTRAL_FIELD },
      active: { mine: [null, null], theirs: [null, null] },
    };
    const path = saveMatch(match);
    createdFiles.push(path);

    expect(path).toBe(join(matchesDir, `${id}.json`));
    expect(existsSync(path)).toBe(true);
    const round = JSON.parse(readFileSync(path, 'utf8'));
    expect(round.id).toBe(id);
    expect(round.bring).toEqual([0, 1, 2, 3]);
    expect(round.myTeam[0].species).toBe('Incineroar');
  });
});
