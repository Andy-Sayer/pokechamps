import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PikalyticsFile, PikalyticsEntry } from '../scripts/refresh-pikalytics.js';
import { loadFormat, toId } from './data.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', '..', '..', '..', 'data');

let cache: { format: string; data: PikalyticsFile | null } | null = null;

function load(): PikalyticsFile | null {
  const fmt = loadFormat();
  // The Pikalytics file is keyed by format slug. Today only Reg M-A's slug is
  // known; if the active format changes, refresh-pikalytics needs an updated
  // FORMAT constant.
  const slug = 'gen9championsvgc2026regma';
  void fmt;
  if (cache && cache.format === slug) return cache.data;
  const path = join(dataDir, `pikalytics.${slug}.json`);
  if (!existsSync(path)) {
    cache = { format: slug, data: null };
    return null;
  }
  const data = JSON.parse(readFileSync(path, 'utf8')) as PikalyticsFile;
  cache = { format: slug, data };
  return data;
}

// Convert a PoChamps stat point (0–32) to the @smogon/calc-compatible EV value
// that produces the same final stat at L50 / 31 IV. See
// project-pochamps-ev-scale memory for the derivation.
export function evFromSp(sp: number): number {
  if (sp <= 0) return 0;
  return Math.min(252, 4 + (sp - 1) * 8);
}

export function spFromEv(ev: number): number {
  if (ev < 4) return 0;
  return Math.min(32, Math.floor((ev - 4) / 8) + 1);
}

// Lookup tolerates variants of the species name. Pikalytics keys are display
// names (e.g. "Charizard-Mega-Y", "Floette-Mega"); callers may pass "charizard"
// or "Charizard". Falls back to a toId-based lookup.
export function getPikalytics(speciesName: string): PikalyticsEntry | null {
  const data = load();
  if (!data) return null;
  if (data.pokemon[speciesName]) return data.pokemon[speciesName]!;
  const id = toId(speciesName);
  for (const [name, entry] of Object.entries(data.pokemon)) {
    if (toId(name) === id) return entry;
  }
  return null;
}

export function pikalyticsTopPokemon(): string[] {
  return load()?.topPokemon ?? [];
}

// True when at least one Pikalytics entry is loaded — UI can use this to
// decide whether to surface "(no data — run npm run refresh-pikalytics)" hints.
export function pikalyticsAvailable(): boolean {
  return !!load();
}

// Insert/replace an entry in the in-memory cache. Used by the on-the-fly
// fetcher so freshly-fetched species show up without re-reading the JSON.
export function mergeEntry(speciesName: string, entry: PikalyticsEntry): void {
  const data = load();
  if (data) {
    // The on-the-fly fetcher passes rank/usage 0 (it has no index ranking), so
    // preserve any KNOWN rank/usage — otherwise re-scouting a top mon (e.g.
    // Sneasler) would clobber its ranking to 0.
    const prev = data.pokemon[speciesName];
    data.pokemon[speciesName] = prev
      ? { ...entry, rank: prev.rank || entry.rank, usage: prev.usage || entry.usage }
      : entry;
  } else {
    // No cache file yet — seed an in-memory one so subsequent gets work.
    cache = {
      format: 'gen9championsvgc2026regma',
      data: {
        format: 'gen9championsvgc2026regma',
        fetchedAt: new Date().toISOString().slice(0, 10),
        topPokemon: [],
        pokemon: { [speciesName]: entry },
      },
    };
  }
}
