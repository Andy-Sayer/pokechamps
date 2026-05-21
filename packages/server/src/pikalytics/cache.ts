// Server-side Pikalytics cache. Reuses @pokechamps/core's parseEntry to
// convert the markdown response into a PikalyticsEntry, then persists per
// (format, species) row in sqlite. Fetches are deduped in-process so a burst
// of GETs for the same species only hits Pikalytics once.
//
// We don't TTL anything in v1 — Pikalytics updates monthly and a manual
// POST /pikalytics/:species/refresh is enough for now.
import type Database from 'better-sqlite3';
import { parseEntry, type PikalyticsEntry } from '@pokechamps/core/scripts/refresh-pikalytics.js';

// The format slug Pikalytics uses for the Reg M-A endpoint. Mirrors the
// constant in @pokechamps/core/scripts/refresh-pikalytics.ts. When the format
// rolls, both constants need to update.
export const PIKALYTICS_FORMAT = 'gen9championsvgc2026regma';
const BASE = 'https://www.pikalytics.com/ai/pokedex';

interface CachedRow {
  entry_json: string;
  fetched_at: string;
}

export interface CachedEntry {
  species: string;
  entry: PikalyticsEntry;
  fetchedAt: string;
}

const inFlight = new Map<string, Promise<PikalyticsEntry | null>>();

// Override the network fetcher (tests inject a mock; prod uses global fetch).
type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
let fetcher: Fetcher = (url) => fetch(url, {
  headers: { 'User-Agent': 'pokechamps-server/0.1 (pikalytics-cache)' },
});

export function _setFetcherForTests(f: Fetcher | null): void {
  fetcher = f ?? ((url) => fetch(url, {
    headers: { 'User-Agent': 'pokechamps-server/0.1 (pikalytics-cache)' },
  }));
}

export function _resetInFlight(): void {
  inFlight.clear();
}

export function getEntry(db: Database.Database, species: string): CachedEntry | null {
  const row = db
    .prepare<[string, string], CachedRow>(
      'SELECT entry_json, fetched_at FROM pikalytics_entries WHERE format = ? AND species = ?',
    )
    .get(PIKALYTICS_FORMAT, species);
  if (!row) return null;
  return {
    species,
    entry: JSON.parse(row.entry_json) as PikalyticsEntry,
    fetchedAt: row.fetched_at,
  };
}

export function listSpecies(db: Database.Database): string[] {
  const rows = db
    .prepare<[string], { species: string }>(
      'SELECT species FROM pikalytics_entries WHERE format = ? ORDER BY species',
    )
    .all(PIKALYTICS_FORMAT);
  return rows.map(r => r.species);
}

function upsertEntry(db: Database.Database, species: string, entry: PikalyticsEntry): void {
  db.prepare(
    `INSERT INTO pikalytics_entries (format, species, entry_json, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(format, species) DO UPDATE SET
       entry_json = excluded.entry_json,
       fetched_at = excluded.fetched_at`,
  ).run(PIKALYTICS_FORMAT, species, JSON.stringify(entry), new Date().toISOString());
}

// Fetch + parse + persist. Deduped: a second call for the same species while
// one is in flight returns the existing promise. Returns the entry on success
// or null on any failure (network, parse, 4xx).
export function fetchAndCache(
  db: Database.Database,
  species: string,
): Promise<PikalyticsEntry | null> {
  const existing = inFlight.get(species);
  if (existing) return existing;

  const p = (async () => {
    try {
      const url = `${BASE}/${PIKALYTICS_FORMAT}/${encodeURIComponent(species)}`;
      const res = await fetcher(url);
      if (!res.ok) return null;
      const md = await res.text();
      const parsed = parseEntry(md, species);
      const entry: PikalyticsEntry = { rank: 0, usage: 0, ...parsed };
      upsertEntry(db, species, entry);
      return entry;
    } catch {
      return null;
    } finally {
      inFlight.delete(species);
    }
  })();

  inFlight.set(species, p);
  return p;
}
