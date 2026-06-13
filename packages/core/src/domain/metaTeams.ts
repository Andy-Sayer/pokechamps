// Meta team construction from Pikalytics usage data — real sets (tournament
// featured sets first, else top-usage moves/ability/item + most common
// spread), composed into 6-mon teams via teammate correlations under the
// format's item clause + a one-mega-stone cap. Shared by suggest-teams.ts
// (suggestions) and anti-meta-team.ts (battle-simulated counter-teaming).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSpecies, getItem, toId, dataDirPath, loadFormat, isLegalSpecies } from './data.js';
import { evFromSp } from './pikalytics.js';
import type { PokemonSet } from './types.js';
import { MAX_IVS } from './types.js';

export interface PikaMon {
  rank: number; usage: number;
  moves: { name: string; pct: number }[];
  abilities: { name: string; pct: number }[];
  items: { name: string; pct: number }[];
  teammates: { name: string; pct: number }[];
  topSpread?: { nature: string; sp: number[]; pct: number };
  featuredSets?: { player: string; record: string; item: string; ability: string; moves: string[] }[];
}
export interface PikaData { topPokemon: string[]; pokemon: Record<string, PikaMon> }

/** Format id matches data/pikalytics.<format>.json — update on regulation
 *  change (see docs/notes/regulation-m-b.md runbook). */
export const PIKA_FORMAT = 'gen9championsvgc2026regma';

export function loadPikaData(): PikaData {
  return JSON.parse(readFileSync(join(dataDirPath(), `pikalytics.${PIKA_FORMAT}.json`), 'utf8')) as PikaData;
}

/** Pikalytics names mega FORMES ('Floette-Mega'); our sets store the BASE
 *  species + stone (the gimmick resolves the forme). */
export function baseSpeciesFor(name: string): string {
  const sp = getSpecies(name) as { name?: string; baseSpecies?: string; forme?: string } | undefined;
  if (sp?.baseSpecies && sp.forme?.includes('Mega')) return sp.baseSpecies;
  return sp?.name ?? name;
}

/** Build a real set for a Pikalytics entry. `usedItems` enforces the item
 *  clause — clashes fall through to the next item choice; null when nothing
 *  legal/complete can be built. */
export function buildSet(pika: PikaData, name: string, usedItems: Set<string>): PokemonSet | null {
  const d = pika.pokemon[name];
  if (!d) return null;
  const format = loadFormat();
  const species = baseSpeciesFor(name);
  if (!isLegalSpecies(toId(species), format)) return null;
  const feat = d.featuredSets?.[0];
  let item = feat?.item ?? d.items.find(i => i.name !== 'Other')?.name ?? '';
  if (usedItems.has(toId(item))) {
    const alt = d.items.find(i => i.name !== 'Other' && !usedItems.has(toId(i.name)))?.name;
    if (!alt) return null;
    item = alt;
  }
  const ability = feat?.ability ?? d.abilities[0]?.name ?? '';
  const moves = (feat?.moves ?? d.moves.filter(m => m.name !== 'Other').slice(0, 4).map(m => m.name)).slice(0, 4);
  if (moves.length < 4) return null;
  const sp = d.topSpread?.sp ?? [0, 0, 0, 0, 0, 0];
  const evs = { hp: evFromSp(sp[0] ?? 0), atk: evFromSp(sp[1] ?? 0), def: evFromSp(sp[2] ?? 0), spa: evFromSp(sp[3] ?? 0), spd: evFromSp(sp[4] ?? 0), spe: evFromSp(sp[5] ?? 0) };
  usedItems.add(toId(item));
  return { species, level: format.level, nature: d.topSpread?.nature ?? 'Hardy', ability, item, evs, ivs: { ...MAX_IVS }, moves };
}

/** Greedy team from anchors + teammate correlations + global usage. Respects
 *  species clause, item clause, and at most one mega stone. Null unless a
 *  full 6 can be composed. */
export function composeTeam(pika: PikaData, anchors: string[]): PokemonSet[] | null {
  const used = new Set<string>();
  const species = new Set<string>();
  const sets: PokemonSet[] = [];
  let megas = 0;
  const tryAdd = (name: string): boolean => {
    if (sets.length >= 6) return false;
    const base = baseSpeciesFor(name);
    if (species.has(base)) return false;
    const set = buildSet(pika, name, used);
    if (!set) return false;
    const holdsStone = !!(getItem(set.item ?? '') as { megaStone?: unknown } | undefined)?.megaStone;
    if (holdsStone && megas >= 1) { used.delete(toId(set.item!)); return false; }
    if (holdsStone) megas++;
    species.add(base);
    sets.push(set);
    return true;
  };
  for (const a of anchors) tryAdd(a);
  if (!sets.length) return null;
  const pool = [
    ...(pika.pokemon[anchors[0]!]?.teammates ?? []).map(t => t.name),
    ...pika.topPokemon,
  ];
  for (const name of pool) {
    if (sets.length >= 6) break;
    tryAdd(name);
  }
  return sets.length === 6 ? sets : null;
}

/** The top-N meta teams: each top-usage mon as anchor, filled by its real
 *  teammate correlations. `maxOverlap` is a DIVERSITY gate — a new team may
 *  share at most that many species with any already-selected team, so the
 *  pool spans archetypes (goodstuff / sun / rain / Trick Room / Tailwind)
 *  instead of five rotations of the same Sneasler-Garchomp core. */
export function metaTeams(pika: PikaData, n: number, maxOverlap = 6): { anchor: string; sets: PokemonSet[] }[] {
  const out: { anchor: string; sets: PokemonSet[] }[] = [];
  const seen: Set<string>[] = [];
  for (const anchor of pika.topPokemon) {
    if (out.length >= n) break;
    const sets = composeTeam(pika, [anchor]);
    if (!sets) continue;
    const species = new Set(sets.map(s => s.species));
    const tooSimilar = seen.some(prev => {
      let shared = 0;
      for (const sp of species) if (prev.has(sp)) shared++;
      return shared > maxOverlap;
    });
    if (tooSimilar) continue;
    seen.push(species);
    out.push({ anchor, sets });
  }
  return out;
}
