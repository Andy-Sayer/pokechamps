import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSpecies, getMove } from './data.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const typesPath = join(__dirname, '..', '..', '..', '..', 'data', 'types.json');

// damageTaken encoding (Showdown): 0=neutral, 1=resist (.5x), 2=weak (2x), 3=immune (0x)
const MULT: Record<number, number> = { 0: 1, 1: 0.5, 2: 2, 3: 0 };

type TypeEntry = { damageTaken?: Record<string, number> };
const TYPES: Record<string, TypeEntry> = existsSync(typesPath)
  ? JSON.parse(readFileSync(typesPath, 'utf8'))
  : {};

const lc = (s: string) => s.toLowerCase();
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

// Multiplier of `attackType` vs a defender of `defenderTypes`. Returns 1 (neutral)
// if either side is unknown so callers don't have to special-case missing data.
export function effectiveness(attackType: string, defenderTypes: string[]): number {
  let mult = 1;
  for (const dt of defenderTypes) {
    const chart = TYPES[lc(dt)];
    if (!chart?.damageTaken) continue;
    const taken = chart.damageTaken[cap(attackType)];
    if (taken == null) continue;
    mult *= MULT[taken] ?? 1;
  }
  return mult;
}

export function speciesTypes(speciesName: string): string[] {
  const s = getSpecies(speciesName);
  return ((s as any)?.types ?? []) as string[];
}

// Distinct damaging-move types carried by a set. Status moves are excluded —
// their type doesn't shape the matchup.
export function offensiveTypes(moves: string[]): string[] {
  const seen = new Set<string>();
  for (const name of moves) {
    const m = getMove(name) as any;
    if (!m?.type) continue;
    if (m.category && String(m.category).toLowerCase() === 'status') continue;
    seen.add(m.type);
  }
  return [...seen];
}

// Best (highest) effectiveness of any of `attackerTypes` into `defenderTypes`.
// Returns 0 if attackerTypes is empty (no way to hit them).
export function bestOffensive(attackerTypes: string[], defenderTypes: string[]): number {
  let best = 0;
  for (const t of attackerTypes) {
    const e = effectiveness(t, defenderTypes);
    if (e > best) best = e;
  }
  return best;
}
