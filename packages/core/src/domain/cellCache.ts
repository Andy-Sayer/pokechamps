// Content-addressed cache of 4v4 win-rates, keyed by the MON SETS in the matchup
// — NOT by the 6-mon team they were brought from. A 4v4 playout's result depends
// only on the 8 sets actually in play, so the same (my-4 vs their-4) result is
// reusable across teams and, crucially, across evolutionary mutations: changing
// one mon only invalidates the cells whose 4 contain that mon's new set; every
// other 4v4 is a cache hit. Keyed by SET (species+item+ability+nature+evs+moves),
// so Life-Orb Garchomp and Scarf Garchomp are correctly distinct.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from './data.js';
import type { PokemonSet } from './types.js';

/** Stable signature of one mon's full set. Identical sets → identical sig. */
export function setSig(s: PokemonSet): string {
  const e = s.evs;
  const evs = e ? `${e.hp ?? 0},${e.atk ?? 0},${e.def ?? 0},${e.spa ?? 0},${e.spd ?? 0},${e.spe ?? 0}` : '';
  const moves = [...s.moves].map(m => m.toLowerCase().replace(/[^a-z0-9]/g, '')).sort().join('|');
  return [s.species, s.item ?? '', s.ability ?? '', s.nature ?? '', s.level ?? 50, evs, moves]
    .join('#').toLowerCase();
}

/** Key for one 4v4 cell: my 4 sets (order-independent) vs their 4 (order-independent)
 *  under a given opponent model. Sides are NOT interchangeable (I am always p1). */
export function cellKey(my4: PokemonSet[], their4: PokemonSet[], oppMode: string): string {
  const a = my4.map(setSig).sort().join('+');
  const b = their4.map(setSig).sort().join('+');
  return createHash('sha1').update(`${a}__${b}__${oppMode}`).digest('hex').slice(0, 16);
}

interface CellRec { wr: number; games: number }

/** Persistent map cellKey → {wr, games}. One file per format. */
export class CellCache {
  private map = new Map<string, CellRec>();
  private hits = 0;
  private misses = 0;
  private path: string;
  constructor(fmt: string) {
    this.path = join(dataDirPath(), `cell-cache.${fmt}.json`);
    if (existsSync(this.path)) {
      try { this.map = new Map(Object.entries(JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, CellRec>)); } catch { /* corrupt → start empty */ }
    }
  }
  /** Cached win-rate if present AND computed with at least `minGames` samples. */
  get(key: string, minGames: number): number | undefined {
    const r = this.map.get(key);
    if (r && r.games >= minGames) { this.hits++; return r.wr; }
    this.misses++;
    return undefined;
  }
  put(key: string, wr: number, games: number): void {
    const prev = this.map.get(key);
    // Keep the higher-sample estimate if we recompute the same cell.
    if (!prev || games >= prev.games) this.map.set(key, { wr, games });
  }
  stats(): { hits: number; misses: number; size: number } { return { hits: this.hits, misses: this.misses, size: this.map.size }; }
  save(): void { writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.map)) + '\n', 'utf8'); }
}
