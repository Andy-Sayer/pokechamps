import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PikalyticsFile, PikalyticsEntry, PikalyticsRanking } from '../scripts/refresh-pikalytics.js';
import { dataDirPath, loadFormat, toId, CHAMPIONS_PIKA_FORMAT } from './data.js';

// Resolve through data.ts's probing (env override / source tree / bundle-
// adjacent / cwd) — a private import.meta-relative path here silently loses
// the priors file in ANY bundled build (found via search-bench: the bundled
// live scenario collapsed to default spreads while the source-tree run had
// real priors — and the shipped TUI bundle had the same latent hole).
const dataDir = dataDirPath();

let cache: { format: string; data: PikalyticsFile | null } | null = null;

function load(): PikalyticsFile | null {
  const fmt = loadFormat();
  // The Pikalytics file is keyed by format slug, sourced from the single
  // CHAMPIONS_PIKA_FORMAT constant (update it on a regulation switch).
  const slug = CHAMPIONS_PIKA_FORMAT;
  void fmt;
  if (cache && cache.format === slug) return cache.data;
  const path = join(dataDir, `pikalytics.${slug}.json`);
  if (!existsSync(path)) {
    cache = { format: slug, data: null };
    return null;
  }
  const data = JSON.parse(readFileSync(path, 'utf8')) as PikalyticsFile;
  // Merge the LIVE sidecar (on-the-fly fetches, pikalyticsFetch.ts) for species the
  // curated warm-up file lacks. Canonical ALWAYS wins — a sparse live stub never
  // overrides real data, and the canonical file on disk is never mutated by play.
  const livePath = join(dataDir, `pikalytics.${slug}.live.json`);
  if (existsSync(livePath)) {
    try {
      const live = JSON.parse(readFileSync(livePath, 'utf8')) as PikalyticsFile;
      for (const [name, entry] of Object.entries(live.pokemon ?? {})) {
        if (!data.pokemon[name]) data.pokemon[name] = entry;
      }
    } catch { /* corrupt sidecar → ignore, canonical stands */ }
  }
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

// Format-level ranking for a species (rank/usage/winRate/record). Lives apart
// from the set data because it comes from the format index, which the live
// per-species fetch can't see — so a live-only species returns null (unranked),
// which callers treat as "off the top list".
export function getRanking(speciesName: string): PikalyticsRanking | null {
  const data = load();
  if (!data?.ranking) return null;
  if (data.ranking[speciesName]) return data.ranking[speciesName]!;
  const id = toId(speciesName);
  for (const [name, r] of Object.entries(data.ranking)) {
    if (toId(name) === id) return r;
  }
  return null;
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
    // Entries are pure SET data now (ranking lives in data.ranking, untouched
    // here), so a live fetch slots in directly — no field-preservation needed.
    data.pokemon[speciesName] = entry;
  } else {
    // No cache file yet — seed an in-memory one so subsequent gets work.
    cache = {
      format: CHAMPIONS_PIKA_FORMAT,
      data: {
        format: CHAMPIONS_PIKA_FORMAT,
        fetchedAt: new Date().toISOString().slice(0, 10),
        topPokemon: [],
        pokemon: { [speciesName]: entry },
      },
    };
  }
}
