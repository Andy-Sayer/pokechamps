// Meta team construction from Pikalytics usage data — real sets (tournament
// featured sets first, else top-usage moves/ability/item + most common
// spread), composed into 6-mon teams via teammate correlations under the
// format's item clause + a one-mega-stone cap. Shared by suggest-teams.ts
// (suggestions) and anti-meta-team.ts (battle-simulated counter-teaming).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSpecies, getItem, toId, dataDirPath, loadFormat, isLegalSpecies, CHAMPIONS_PIKA_FORMAT } from './data.js';
import { evFromSp } from './pikalytics.js';
import type { PokemonSet } from './types.js';
import { MAX_IVS } from './types.js';

export interface PikaMon {
  moves: { name: string; pct: number }[];
  abilities: { name: string; pct: number }[];
  items: { name: string; pct: number }[];
  teammates: { name: string; pct: number }[];
  topSpread?: { nature: string; sp: number[]; pct: number };
  featuredSets?: { player: string; record: string; item: string; ability: string; moves: string[] }[];
}
export interface PikaRank { rank: number; usage: number; winRate?: number; record?: string }
export interface PikaData {
  topPokemon: string[];
  pokemon: Record<string, PikaMon>;
  ranking?: Record<string, PikaRank>;
}

/** Format id matches data/pikalytics.<format>.json — sourced from the single
 *  constant in data.ts (update there on a regulation change; see the
 *  docs/notes/regulation-m-b.md runbook). Re-exported for existing callers. */
export const PIKA_FORMAT = CHAMPIONS_PIKA_FORMAT;

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
  // Pikalytics marks an ITEMLESS set with a "Nothing"/"No Item"/"None" bucket
  // (real for Acrobatics Talonflame etc.) — normalise those to a true empty
  // item so the set doesn't carry a bogus item string that fails validation.
  const ITEMLESS = new Set(['noitem', 'nothing', 'none', '']);
  const normItem = (s: string | undefined) => (ITEMLESS.has(toId(s ?? '')) ? '' : s ?? '');
  const feat = d.featuredSets?.[0];
  let item = normItem(feat?.item ?? d.items.find(i => i.name !== 'Other')?.name);
  // An itemless set never collides with the item clause; only real items do.
  if (item && usedItems.has(toId(item))) {
    const alt = d.items.find(i => i.name !== 'Other' && !ITEMLESS.has(toId(i.name)) && !usedItems.has(toId(i.name)))?.name;
    if (!alt) return null;
    item = normItem(alt);
  }
  const ability = feat?.ability ?? d.abilities[0]?.name ?? '';
  const moves = (feat?.moves ?? d.moves.filter(m => m.name !== 'Other').slice(0, 4).map(m => m.name)).slice(0, 4);
  if (moves.length < 4) return null;
  const sp = d.topSpread?.sp ?? [0, 0, 0, 0, 0, 0];
  const evs = { hp: evFromSp(sp[0] ?? 0), atk: evFromSp(sp[1] ?? 0), def: evFromSp(sp[2] ?? 0), spa: evFromSp(sp[3] ?? 0), spd: evFromSp(sp[4] ?? 0), spe: evFromSp(sp[5] ?? 0) };
  if (item) usedItems.add(toId(item));
  return { species, level: format.level, nature: d.topSpread?.nature ?? 'Hardy', ability, item: item || undefined, evs, ivs: { ...MAX_IVS }, moves };
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
      // Reject if over the overlap budget OR a full duplicate (every species
      // already present) — the latter keeps the default (maxOverlap = full
      // team) behaving as exact dedup, which the no-arg callers rely on.
      return shared > maxOverlap || shared >= species.size;
    });
    if (tooSimilar) continue;
    seen.push(species);
    out.push({ anchor, sets });
  }
  return out;
}

/** Parse a Pikalytics team record ("14-2") to a win-rate. */
function parseRecord(rec: string): number {
  const m = rec.match(/(\d+)\s*[-/]\s*(\d+)/);
  if (!m) return 0;
  const w = Number(m[1]), l = Number(m[2]);
  return w + l > 0 ? w / (w + l) : 0;
}

/** Build a set from a SPECIFIC featured set (one real player's build for that mon)
 *  + the mon's aggregate spread — used to reconstruct that player's actual team. */
function setFromFeatured(pika: PikaData, name: string, feat: { item: string; ability: string; moves: string[] }, usedItems: Set<string>): PokemonSet | null {
  const d = pika.pokemon[name];
  if (!d) return null;
  const format = loadFormat();
  const species = baseSpeciesFor(name);
  if (!isLegalSpecies(toId(species), format)) return null;
  const ITEMLESS = new Set(['noitem', 'nothing', 'none', '']);
  const item = ITEMLESS.has(toId(feat.item ?? '')) ? '' : (feat.item ?? '');
  if (item && usedItems.has(toId(item))) return null; // real teams rarely clash; skip the dupe
  const moves = feat.moves.slice(0, 4);
  if (moves.length < 4) return null;
  const sp = d.topSpread?.sp ?? [0, 0, 0, 0, 0, 0];
  const evs = { hp: evFromSp(sp[0] ?? 0), atk: evFromSp(sp[1] ?? 0), def: evFromSp(sp[2] ?? 0), spa: evFromSp(sp[3] ?? 0), spd: evFromSp(sp[4] ?? 0), spe: evFromSp(sp[5] ?? 0) };
  if (item) usedItems.add(toId(item));
  return { species, level: format.level, nature: d.topSpread?.nature ?? 'Hardy', ability: feat.ability || d.abilities[0]?.name || '', item: item || undefined, evs, ivs: { ...MAX_IVS }, moves };
}

export interface GroundedTeam { anchor: string; sets: PokemonSet[]; record: string; winRate: number; core: number }

/** REAL teams reconstructed from Pikalytics featured-team fragments (grouped by
 *  player+record), gaps filled by actual co-occurrence — NOT usage-rank stacking.
 *  `minCore` = how many real captured mons a team must have to qualify. Deduped by
 *  species set, sorted by record (best first). Grounds the gauntlet in what top
 *  players actually brought, instead of composeTeam's (empty-correlation) filler. */
export function groundedTeams(pika: PikaData, opts: { minCore?: number; minWinRate?: number; limit?: number } = {}): GroundedTeam[] {
  const minCore = opts.minCore ?? 4;
  const minWinRate = opts.minWinRate ?? 0;
  // 1. fragments: real teams keyed by player+record, each captured mon with its exact set
  const frags = new Map<string, { player: string; record: string; mons: { species: string; feat: { item: string; ability: string; moves: string[] } }[] }>();
  for (const [name, mon] of Object.entries(pika.pokemon)) {
    for (const fs of mon.featuredSets ?? []) {
      const key = `${fs.player}|${fs.record}`;
      if (!frags.has(key)) frags.set(key, { player: fs.player, record: fs.record, mons: [] });
      frags.get(key)!.mons.push({ species: name, feat: fs });
    }
  }
  // 2. co-occurrence across all fragments (base-species ids)
  const cooc = new Map<string, Map<string, number>>();
  const bump = (a: string, b: string) => { if (!cooc.has(a)) cooc.set(a, new Map()); const m = cooc.get(a)!; m.set(b, (m.get(b) ?? 0) + 1); };
  for (const f of frags.values()) {
    const ids = [...new Set(f.mons.map(m => toId(baseSpeciesFor(m.species))))];
    for (const a of ids) for (const b of ids) if (a !== b) bump(a, b);
  }
  const rankOf = new Map(pika.topPokemon.map((n, i) => [toId(baseSpeciesFor(n)), i]));
  // 3. one full team per qualifying fragment
  const teams: GroundedTeam[] = [];
  for (const f of frags.values()) {
    const uniqMons = [...new Map(f.mons.map(m => [toId(baseSpeciesFor(m.species)), m])).values()];
    const wr = parseRecord(f.record);
    if (uniqMons.length < minCore || wr < minWinRate) continue;
    const usedItems = new Set<string>(); const speciesSet = new Set<string>(); let megas = 0;
    const sets: PokemonSet[] = [];
    const push = (set: PokemonSet | null): boolean => {
      if (!set || sets.length >= 6 || speciesSet.has(set.species)) return false;
      const holdsStone = !!(getItem(set.item ?? '') as { megaStone?: unknown } | undefined)?.megaStone;
      if (holdsStone && megas >= 1) return false;
      if (holdsStone) megas++;
      speciesSet.add(set.species); sets.push(set); return true;
    };
    for (const m of uniqMons) { if (sets.length >= 6) break; push(setFromFeatured(pika, m.species, m.feat, usedItems)); }
    const coreCount = sets.length;
    // fill remaining slots via co-occurrence with current members, else usage rank
    const members = sets.map(s => toId(s.species));
    const score = (c: string) => members.reduce((s, mem) => s + (cooc.get(mem)?.get(c) ?? 0), 0);
    const candidates = [...new Set([...cooc.keys(), ...pika.topPokemon.map(n => toId(baseSpeciesFor(n)))])]
      .filter(c => !members.includes(c))
      .sort((a, b) => score(b) - score(a) || (rankOf.get(a) ?? 1e9) - (rankOf.get(b) ?? 1e9));
    for (const c of candidates) {
      if (sets.length >= 6) break;
      const disp = pika.topPokemon.find(n => toId(baseSpeciesFor(n)) === c) ?? c;
      push(buildSet(pika, disp, usedItems));
    }
    if (sets.length !== 6) continue;
    const headline = sets.map(s => s.species).sort((a, b) => (rankOf.get(toId(a)) ?? 1e9) - (rankOf.get(toId(b)) ?? 1e9))[0]!;
    teams.push({ anchor: `${headline} [${f.player} ${f.record}]`, sets, record: f.record, winRate: wr, core: coreCount });
  }
  // dedup by species set, keep the best record for each
  const uniq = new Map<string, GroundedTeam>();
  for (const t of teams.sort((a, b) => b.winRate - a.winRate)) {
    const key = t.sets.map(s => toId(s.species)).sort().join(',');
    if (!uniq.has(key)) uniq.set(key, t);
  }
  const result = [...uniq.values()];
  return opts.limit ? result.slice(0, opts.limit) : result;
}
