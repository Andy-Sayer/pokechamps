// Fine-tune the top anti-meta teams: per-mon ITEM and STAT-SPREAD search,
// adoption-gated by deep battle simulation.
//
//   NODE_OPTIONS=--max-old-space-size=8192 npx tsx packages/core/src/scripts/fine-tune-teams.ts [--save]
//
// Contract (user requirement): every DECISION — variant adoption and the
// final ranking — is verified at depth 5 (five full turns of lookahead for
// both sides, mutual best play). Depth-2 scouts only SHORTLIST candidate
// changes; they never adopt anything.
//
// Tuning dimensions per mon:
//   - item: the mon's own Pikalytics item list (top 3) + curated utility
//     items (Focus Sash / Choice Scarf / Leftovers / Sitrus), legal +
//     item-clause checked.
//   - spread: usage topSpread (baseline), fast-offense (4/252/252+speed
//     nature), bulky-offense (252HP/252Atk-or-SpA), max-bulk
//     (252HP/124/124 + defensive nature).
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId, getItem, getSpecies, isLegalItem, loadFormat } from '../domain/data.js';
import { loadPikaData, metaTeams, composeTeam, baseSpeciesFor } from '../domain/metaTeams.js';
import type { PokemonSet } from '../domain/types.js';
import { type Matchup } from '../domain/teamSim.js';
import { MatchupPool } from '../domain/matchupPool.js';

const SAVE = process.argv.includes('--save');
const DEEP = 5;          // the decision depth — "at least 5 turns into the future"
const SCOUT = 2;         // shortlisting only
const META_N = 12;
const MAX_OVERLAP = 3;

const pika = loadPikaData();
const meta = metaTeams(pika, META_N, MAX_OVERLAP);
console.log(`gauntlet: ${meta.length} meta teams · decision depth ${DEEP} · scout depth ${SCOUT}`);

// Worker pool: the 12 gauntlet matchups run in parallel across cores, with
// results identical to sequential. At depth 5 (~16 min/matchup sequential)
// this collapses a team's baseline to roughly one matchup's wall-clock.
const pool = new MatchupPool();

interface Fitness { floor: number; avg: number; matchups: Matchup[] }
async function evaluateTeam(mine: PokemonSet[], depth: number, abortBelow?: number, gauntlet = meta): Promise<Fitness | null> {
  const t0 = Date.now();
  const matchups = await pool.run(gauntlet.map(opp => ({ mine, oppSets: opp.sets, oppAnchor: opp.anchor, depth })));
  const floor = Math.min(...matchups.map(m => m.score));
  if (depth >= DEEP) console.log(`    [d${depth}] ${gauntlet.length} matchups, floor ${Math.round(floor)} (${Math.round((Date.now() - t0) / 1000)}s wall)`);
  if (abortBelow != null && floor < abortBelow) return null;
  return {
    floor,
    avg: matchups.reduce((s, m) => s + m.score, 0) / matchups.length,
    matchups,
  };
}
const better = (a: Fitness, b: Fitness) => (a.floor !== b.floor ? a.floor > b.floor : a.avg > b.avg);

// ---------------------------------------------------------------------------
// Variant generation.
// ---------------------------------------------------------------------------
const UTILITY_ITEMS = ['focussash', 'choicescarf', 'leftovers', 'sitrusberry'];

function itemVariants(set: PokemonSet, teamItems: Set<string>): string[] {
  const d = pika.pokemon[Object.keys(pika.pokemon).find(k => baseSpeciesFor(k) === set.species) ?? set.species];
  const fromUsage = (d?.items ?? []).filter(i => i.name !== 'Other').slice(0, 3).map(i => i.name);
  const all = [...fromUsage, ...UTILITY_ITEMS.map(id => (getItem(id) as { name?: string } | undefined)?.name ?? id)];
  const out: string[] = [];
  for (const item of all) {
    const id = toId(item);
    if (id === toId(set.item ?? '')) continue;
    if (teamItems.has(id)) continue;                      // item clause
    if (!isLegalItem(id, loadFormat())) continue;
    if ((getItem(id) as { megaStone?: unknown } | undefined)?.megaStone) continue; // never touch the mega slot
    if (!out.includes(item)) out.push(item);
  }
  // A mega holder's stone is its identity — no item variants for it.
  if ((getItem(set.item ?? '') as { megaStone?: unknown } | undefined)?.megaStone) return [];
  return out.slice(0, 4);
}

function spreadVariants(set: PokemonSet): { label: string; nature: string; evs: PokemonSet['evs'] }[] {
  const sp = getSpecies(set.species) as { baseStats?: { atk: number; spa: number; def: number; spd: number } } | undefined;
  const physical = (sp?.baseStats?.atk ?? 0) >= (sp?.baseStats?.spa ?? 0);
  const offStat = physical ? 'atk' as const : 'spa' as const;
  const zero = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  const variants = [
    { label: 'fast-offense', nature: physical ? 'Jolly' : 'Timid', evs: { ...zero, [offStat]: 252, spe: 252, hp: 4 } },
    { label: 'bulky-offense', nature: physical ? 'Adamant' : 'Modest', evs: { ...zero, hp: 252, [offStat]: 252, spd: 4 } },
    { label: 'max-bulk', nature: (sp?.baseStats?.def ?? 0) >= (sp?.baseStats?.spd ?? 0) ? 'Careful' : 'Bold', evs: { ...zero, hp: 252, def: 124, spd: 124 } },
  ];
  // Drop any variant identical to the current spread.
  return variants.filter(v => !(v.nature === set.nature && JSON.stringify(v.evs) === JSON.stringify(set.evs)));
}

// ---------------------------------------------------------------------------
// Teams to tune: the landed anti-meta winner + the two runner-up finalists,
// recomposed deterministically.
// ---------------------------------------------------------------------------
const teams: { label: string; sets: PokemonSet[] }[] = [];
const antiMetaPath = join(dataDirPath(), 'my-teams', 'anti-meta.json');
if (existsSync(antiMetaPath)) {
  teams.push({ label: 'anti-meta winner', sets: JSON.parse(readFileSync(antiMetaPath, 'utf8')) as PokemonSet[] });
}
for (const anchor of ['Charizard-Mega-Y', 'Rotom-Wash']) {
  const sets = composeTeam(pika, [anchor]);
  if (sets) teams.push({ label: `${anchor} stack`, sets });
}
{
  const sets = composeTeam(pika, ['Dragonite-Mega', 'Primarina']);
  if (sets) teams.push({ label: 'Underdogs (M-Dragonite+Primarina)', sets });
}
// Dedupe (the winner may BE one of the stacks).
const seen = new Set<string>();
const toTune = teams.filter(t => {
  const key = t.sets.map(s => `${s.species}:${s.item}`).sort().join('|');
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}).slice(0, 3);

// ---------------------------------------------------------------------------
// Coordinate-descent tuning per team.
// ---------------------------------------------------------------------------
const results: { label: string; sets: PokemonSet[]; fit: Fitness; changes: string[] }[] = [];
for (const team of toTune) {
  console.log(`\n=== tuning: ${team.label} ===`);
  let cur = team.sets.map(s => ({ ...s, evs: { ...s.evs } }));
  console.log(`baseline at depth ${DEEP}…`);
  let curFit = (await evaluateTeam(cur, DEEP))!;
  console.log(`  floor ${Math.round(curFit.floor)} avg ${Math.round(curFit.avg)}`);
  const changes: string[] = [];
  // The mons implicated in the worst matchups get tuned first.
  const worstBrings = [...curFit.matchups].sort((a, b) => a.score - b.score).slice(0, 3).flatMap(m => m.myBring);
  const order = [...cur.keys()].sort((a, b) =>
    (worstBrings.includes(cur[b]!.species) ? 1 : 0) - (worstBrings.includes(cur[a]!.species) ? 1 : 0));
  for (const idx of order) {
    const mon = cur[idx]!;
    const teamItems = new Set(cur.filter((_, i) => i !== idx).map(s => toId(s.item ?? '')));
    const candidates: { desc: string; set: PokemonSet }[] = [];
    for (const item of itemVariants(mon, teamItems)) candidates.push({ desc: `${mon.species} item → ${item}`, set: { ...mon, item } });
    for (const v of spreadVariants(mon)) candidates.push({ desc: `${mon.species} spread → ${v.label} (${v.nature})`, set: { ...mon, nature: v.nature, evs: v.evs } });
    const curScout = (await evaluateTeam(cur, SCOUT))!;     // once per mon, not per candidate
    for (const cand of candidates) {
      const trial = cur.map((s, i) => (i === idx ? cand.set : s));
      // Scout shortlist (cheap), then the DEEP adoption gate.
      const scout = await evaluateTeam(trial, SCOUT, undefined);
      if (!scout) continue;
      if (!better(scout, curScout)) continue;
      process.stdout.write(`  deep-checking ${cand.desc}… `);
      const deep = await evaluateTeam(trial, DEEP, curFit.floor);
      if (deep && better(deep, curFit)) {
        console.log(`ADOPTED (floor ${Math.round(deep.floor)} avg ${Math.round(deep.avg)})`);
        cur = trial; curFit = deep; changes.push(cand.desc);
      } else {
        console.log('rejected at depth 5');
      }
    }
  }
  results.push({ label: team.label, sets: cur, fit: curFit, changes });
}

// ---------------------------------------------------------------------------
// Final ranking + report (all numbers are depth-5).
// ---------------------------------------------------------------------------
results.sort((a, b) => (better(a.fit, b.fit) ? -1 : 1));
console.log(`\n=== FINE-TUNED TEAMS (decision depth ${DEEP}) ===`);
results.forEach((r, i) => {
  console.log(`\n#${i + 1} ${r.label} — floor ${Math.round(r.fit.floor)} · avg ${Math.round(r.fit.avg)}`);
  for (const s of r.sets) console.log(`  ${s.species} @ ${s.item} · ${s.ability} · ${s.nature} ${Object.entries(s.evs).filter(([, v]) => v > 0).map(([k, v]) => `${v}${k}`).join('/')} · ${s.moves.join(' / ')}`);
  console.log(r.changes.length ? `  changes: ${r.changes.join('; ')}` : '  changes: none (usage sets already optimal at this depth)');
  for (const m of r.fit.matchups) console.log(`    vs ${m.anchor.padEnd(18)} ${String(Math.round(m.score)).padStart(6)}  ${m.verdict}`);
  if (SAVE) {
    const file = join(dataDirPath(), 'my-teams', `tuned-${i + 1}-${toId(r.sets[0]!.species)}.json`);
    writeFileSync(file, JSON.stringify(r.sets, null, 2));
    console.log(`  saved ${file}`);
  }
});

pool.close();
