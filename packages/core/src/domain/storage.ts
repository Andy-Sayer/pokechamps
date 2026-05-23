import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PokemonSet, Match } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..', '..', '..');
const teamsDir = join(rootDir, 'data', 'my-teams');
const matchesDir = join(rootDir, 'matches');

mkdirSync(teamsDir, { recursive: true });
mkdirSync(matchesDir, { recursive: true });

export function listTeams(): { name: string; team: PokemonSet[] }[] {
  if (!existsSync(teamsDir)) return [];
  return readdirSync(teamsDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const raw = JSON.parse(readFileSync(join(teamsDir, f), 'utf8'));
      return { name: f.replace(/\.json$/, ''), team: raw as PokemonSet[] };
    });
}

export function saveTeam(name: string, team: PokemonSet[]): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const path = join(teamsDir, `${safe}.json`);
  writeFileSync(path, JSON.stringify(team, null, 2));
  return path;
}

export function saveMatch(match: Match): string {
  const path = join(matchesDir, `${match.id}.json`);
  writeFileSync(path, JSON.stringify(match, null, 2));
  return path;
}

// Inventory of snapshots in matches/, newest first. Each entry parses just
// enough to render a list (id, startedAt, outcome, opp species summary).
export function listMatches(): Array<{ id: string; path: string; match: Match }> {
  if (!existsSync(matchesDir)) return [];
  return readdirSync(matchesDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const path = join(matchesDir, f);
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Match;
      return { id: f.replace(/\.json$/, ''), path, match: raw };
    })
    .sort((a, b) => (b.match.startedAt ?? '').localeCompare(a.match.startedAt ?? ''));
}
