// Engine-driven team suggestions — NO LLM judgement anywhere. Teams are
// composed from three data sources and scored by the same machinery that
// runs in-app:
//   - Pikalytics usage data (real sets: tournament featuredSets > top-usage
//     moves/ability/item + topSpread)
//   - the tactics catalog (combo cores the format supports)
//   - scoreBrings vs representative meta opponent sixes (type matchups,
//     damage, speed, roles, tactic synergy/threat counters)
//
//   npx tsx packages/core/src/scripts/suggest-teams.ts [--save]
//
// --save writes the top teams to data/my-teams/suggested-<n>-<slug>.json so
// they're pickable in the TUI immediately.
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSpecies, getItem, toId, dataDirPath, loadFormat, isLegalSpecies } from '../domain/data.js';
import { evFromSp } from '../domain/pikalytics.js';
import { detectTactics, profileFromSet } from '../domain/tactics.js';
import { scoreBrings } from '../domain/bring.js';
import type { PokemonSet, OpponentEntry } from '../domain/types.js';
import { MAX_IVS } from '../domain/types.js';

interface PikaMon {
  rank: number; usage: number;
  moves: { name: string; pct: number }[];
  abilities: { name: string; pct: number }[];
  items: { name: string; pct: number }[];
  teammates: { name: string; pct: number }[];
  topSpread?: { nature: string; sp: number[]; pct: number };
  featuredSets?: { player: string; record: string; item: string; ability: string; moves: string[] }[];
}

// Format id matches data/pikalytics.<format>.json — update on regulation
// change (see docs/notes/regulation-m-b.md runbook).
const PIKA_FORMAT = 'gen9championsvgc2026regma';
const pika = JSON.parse(
  readFileSync(join(dataDirPath(), `pikalytics.${PIKA_FORMAT}.json`), 'utf8'),
) as { topPokemon: string[]; pokemon: Record<string, PikaMon> };
if (!pika?.pokemon) { console.error('no pikalytics data — run a fetch first'); process.exit(1); }
const detail = pika.pokemon;
const format = loadFormat();

/** Pikalytics names mega FORMES ('Floette-Mega'); our sets store the BASE
 *  species + stone (the gimmick resolves the forme). */
function baseSpeciesFor(name: string): string {
  const sp = getSpecies(name) as { name?: string; baseSpecies?: string; forme?: string } | undefined;
  if (sp?.baseSpecies && sp.forme?.startsWith('Mega')) return sp.baseSpecies;
  // Champions customs use forme names like 'Floette-Eternal' for the base.
  if (sp?.baseSpecies && sp.forme?.includes('Mega')) return sp.baseSpecies;
  return sp?.name ?? name;
}
function isMegaEntry(name: string): boolean {
  return baseSpeciesFor(name) !== ((getSpecies(name) as { name?: string } | undefined)?.name ?? name);
}

/** Build a real set for a Pikalytics entry: tournament featured set first,
 *  else top-usage moves/ability/item + the most common spread. `usedItems`
 *  enforces the item clause — clashes fall through to the next item choice. */
function buildSet(name: string, usedItems: Set<string>): PokemonSet | null {
  const d = detail[name];
  if (!d) return null;
  const species = baseSpeciesFor(name);
  if (!isLegalSpecies(toId(species), format)) return null;
  const feat = d.featuredSets?.[0];
  let item = feat?.item ?? d.items.find(i => i.name !== 'Other')?.name ?? '';
  if (usedItems.has(toId(item))) {
    const alt = d.items.find(i => i.name !== 'Other' && !usedItems.has(toId(i.name)))?.name;
    if (!alt) return null;                       // nothing left → caller skips this mon
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

/** Greedy fill from an anchor: follow teammate correlations, respecting item
 *  clause, species clause, and at most one mega stone per team. */
function composeTeam(anchors: string[]): { name: string; sets: PokemonSet[] } | null {
  const used = new Set<string>();
  const species = new Set<string>();
  const sets: PokemonSet[] = [];
  let megas = 0;
  const tryAdd = (name: string): boolean => {
    if (sets.length >= 6) return false;
    const base = baseSpeciesFor(name);
    if (species.has(base)) return false;
    const mega = isMegaEntry(name) || toId((detail[name]?.items[0]?.name) ?? '').endsWith('ite');
    const set = buildSet(name, used);
    if (!set) return false;
    const holdsStone = !!(getItem(set.item ?? '') as { megaStone?: unknown } | undefined)?.megaStone;
    if (holdsStone && megas >= 1) { used.delete(toId(set.item!)); return false; }
    if (holdsStone) megas++;
    void mega;
    species.add(base);
    sets.push(set);
    return true;
  };
  for (const a of anchors) tryAdd(a);
  if (!sets.length) return null;
  // Fill from the FIRST anchor's teammate correlations, then global usage.
  const pool = [
    ...(detail[anchors[0]!]?.teammates ?? []).map(t => t.name),
    ...pika.topPokemon,
  ];
  for (const name of pool) {
    if (sets.length >= 6) break;
    tryAdd(name);
  }
  return sets.length === 6 ? { name: anchors.join('+'), sets } : null;
}

// ---------------------------------------------------------------------------
// Candidate teams.
// ---------------------------------------------------------------------------
const candidates: { label: string; origin: string; sets: PokemonSet[] }[] = [];
const seen = new Set<string>();
const push = (label: string, origin: string, team: { sets: PokemonSet[] } | null) => {
  if (!team) return;
  const key = team.sets.map(s => s.species).sort().join('|');
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push({ label, origin, sets: team.sets });
};

// (a) Meta stacks: each of the top 8 usage mons as anchor.
for (const anchor of pika.topPokemon.slice(0, 8)) {
  push(`${anchor} core`, 'meta usage + teammate correlations', composeTeam([anchor]));
}
// (b) Tactic cores: strongest pair combos where BOTH pieces have usage data.
{
  const catalog = JSON.parse(
    readFileSync(join(dataDirPath(), 'tactics.champions.json'), 'utf8'),
  ) as { patterns: Record<string, { instances: { pieces: { species: string }[]; name: string; score: number }[] }> };
  for (const pattern of ['perish-trap', 'weather', 'terrain', 'trick-room', 'redirection']) {
    const inst = catalog.patterns[pattern]?.instances.find(t =>
      t.pieces.length === 2 && t.pieces.every(p => {
        // catalog uses forme names; map to the pikalytics key when present
        const key = Object.keys(detail).find(k => baseSpeciesFor(k) === baseSpeciesFor(p.species) || k === p.species);
        return !!key;
      }));
    if (!inst) continue;
    const anchors = inst.pieces.map(p =>
      Object.keys(detail).find(k => baseSpeciesFor(k) === baseSpeciesFor(p.species) || k === p.species)!);
    const team = composeTeam(anchors);
    // The core must actually SURVIVE composition (a second mega piece can be
    // rejected by the one-stone cap; item clashes can drop a piece). A team
    // labelled with a combo it doesn't contain would be a lie.
    const intact = team && anchors.every(a =>
      team.sets.some(s => baseSpeciesFor(s.species) === baseSpeciesFor(a)));
    if (intact) push(`${inst.name}: ${anchors.join(' + ')}`, `tactics catalog (${pattern})`, team);
  }
}

// ---------------------------------------------------------------------------
// Score each candidate vs representative meta opponent sixes.
// ---------------------------------------------------------------------------
// Opponent sixes: top-usage clusters (anchor + its top 5 teammates).
const oppSixes: OpponentEntry[][] = [];
for (const anchor of pika.topPokemon.slice(0, 4)) {
  const mates = (detail[anchor]?.teammates ?? []).map(t => t.name).filter(n => detail[n]);
  const six = [anchor, ...mates].slice(0, 6);
  if (six.length === 6) oppSixes.push(six.map(n => ({ species: baseSpeciesFor(n), knownMoves: [] })));
}

const results = candidates.map(c => {
  let total = 0;
  for (const opp of oppSixes) {
    const brings = scoreBrings(c.sets, opp);
    total += brings[0]?.total ?? 0;
  }
  const avg = total / Math.max(1, oppSixes.length);
  const combos = detectTactics(c.sets.map(profileFromSet));
  const comboTop = combos.slice(0, 3).map(t => t.name);
  return { ...c, avg: Math.round(avg), combos: comboTop };
}).sort((a, b) => b.avg - a.avg);

console.log(`\n=== Engine team suggestions (vs ${oppSixes.length} meta opponent sixes) ===\n`);
for (const r of results) {
  console.log(`[${r.avg}] ${r.label}   (${r.origin})`);
  for (const s of r.sets) console.log(`    ${s.species} @ ${s.item} · ${s.ability} · ${s.nature} · ${s.moves.join(' / ')}`);
  if (r.combos.length) console.log(`    combos: ${r.combos.join(' · ')}`);
  console.log('');
}

if (process.argv.includes('--save')) {
  const dir = join(dataDirPath(), 'my-teams');
  results.slice(0, 4).forEach((r, i) => {
    const slug = r.sets.slice(0, 2).map(s => toId(s.species)).join('-');
    const file = join(dir, `suggested-${i + 1}-${slug}.json`);
    writeFileSync(file, JSON.stringify(r.sets, null, 2));
    console.log(`saved ${file}`);
  });
}
