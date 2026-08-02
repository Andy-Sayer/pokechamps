import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PokemonSet, Match } from './types.js';
import { dataDirPath } from './data.js';

// Anchor on the probed data dir (env / source tree / bundle-adjacent / cwd)
// rather than a private import.meta-relative root: teams live INSIDE data/,
// and matches/ sits beside it (repo root in the source tree, the bundle dir
// in a bundled TUI). Same bug class as pikalytics.ts.
const teamsDir = join(dataDirPath(), 'my-teams');
const matchesDir = join(dirname(dataDirPath()), 'matches');

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

// Delete a saved team. Name is sanitized the same way saveTeam writes it, so a
// list entry's name (already a filename) round-trips. No-op if absent.
export function deleteTeam(name: string): void {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  rmSync(join(teamsDir, `${safe}.json`), { force: true });
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
