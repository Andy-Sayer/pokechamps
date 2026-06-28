// On-the-fly Pikalytics fetcher. Hits the same /ai/pokedex/<format>/<species>
// markdown endpoint as the offline refresh script and merges results into
// the in-memory cache plus the data/pikalytics.<format>.json file so they
// survive across sessions.
//
// Trigger pattern: fire-and-forget. UI re-renders pick up new entries when
// the in-flight resolution lands.
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEntry, type PikalyticsEntry, type PikalyticsFile } from '../scripts/refresh-pikalytics.js';
import { mergeEntry } from './pikalytics.js';
import { CHAMPIONS_PIKA_FORMAT } from './data.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', '..', '..', '..', 'data');
const BASE = 'https://www.pikalytics.com/ai/pokedex';
const FORMAT = CHAMPIONS_PIKA_FORMAT;

// Dedup concurrent fetches for the same species. Also remembers failures so
// we don't hammer the endpoint repeatedly within one session.
const inFlight = new Set<string>();
const failed = new Set<string>();
const listeners = new Set<() => void>();

export function onPikalyticsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function notify() {
  for (const cb of listeners) try { cb(); } catch { /* swallow */ }
}

export function isFetching(species: string): boolean {
  return inFlight.has(species);
}

// Kick off a background fetch + cache merge. Returns immediately. Safe to
// call repeatedly (deduped). Fail-silent — UI just sees no entry yet.
export function fetchAndCache(species: string): void {
  if (inFlight.has(species) || failed.has(species)) return;
  inFlight.add(species);
  doFetch(species).finally(() => {
    inFlight.delete(species);
    notify();
  });
}

async function doFetch(species: string): Promise<void> {
  try {
    const url = `${BASE}/${FORMAT}/${encodeURIComponent(species)}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'pokechamps-tui/0.1 (background-fetch)' } });
    if (!res.ok) { failed.add(species); return; }
    const md = await res.text();
    const parsed = parseEntry(md, species);
    // Background-fetched entries get rank=0 (unranked relative to top-10)
    // and usage=0; the static top-10 entries keep their original ranks.
    const entry: PikalyticsEntry = { rank: 0, usage: 0, ...parsed };
    mergeEntry(species, entry);
    persistEntry(species, entry);
  } catch {
    failed.add(species);
  }
}

// Atomic-ish write: read existing file → merge → write to temp → rename.
// On Windows rename across same dir is atomic enough; on POSIX it is too.
function persistEntry(species: string, entry: PikalyticsEntry): void {
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, `pikalytics.${FORMAT}.json`);
    let data: PikalyticsFile;
    if (existsSync(path)) {
      data = JSON.parse(readFileSync(path, 'utf8'));
    } else {
      data = { format: FORMAT, fetchedAt: new Date().toISOString().slice(0, 10), topPokemon: [], pokemon: {} };
    }
    // Preserve a known rank/usage — this background entry carries rank/usage 0,
    // which must not overwrite the static top-N ranking of an already-ranked mon.
    const prev = data.pokemon[species];
    data.pokemon[species] = prev
      ? { ...entry, rank: prev.rank || entry.rank, usage: prev.usage || entry.usage }
      : entry;
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
  } catch { /* persistence failure is non-fatal — memory cache still updated */ }
}
