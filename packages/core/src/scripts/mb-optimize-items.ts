// Item optimization INCLUDING the new Reg M-B items (the hill-climb/tuner only
// ever saw M-A items via Pikalytics usage). Coordinate descent over per-mon item
// candidate pools, full-gauntlet fitness, item-clause aware.
//
//   NODE_OPTIONS=--max-old-space-size=8192 \
//     npx tsx packages/core/src/scripts/mb-optimize-items.ts [team.json] [--save]
//
// CAVEATS the engine can't fully see (interpret results with these in mind):
//   - Damage items (Life Orb, Expert Belt, Muscle Band, Wise Glasses) ARE valued
//     correctly — they change the damage matrix the search reads.
//   - DURATION items (Damp Rock = +3 rain turns) and TRIGGER items
//     (White Herb→Unburden) are under-valued: the depth-5 horizon rarely reaches
//     the turns where they pay off. Dragonite (mega stone) + Sneasler (White Herb)
//     are held FIXED for this reason; judge Damp Rock on Pelipper manually.
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId, isLegalItem } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { MatchupPool, type MatchupTask } from '../domain/matchupPool.js';
import type { Matchup } from '../domain/teamSim.js';
import type { PokemonSet } from '../domain/types.js';
import { MB_THREATS } from './mbThreats.js';

const SAVE = process.argv.includes('--save');
const argNum = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const DEPTH = argNum('--depth', 5);
const BUDGET = argNum('--budget', 15000);
const teamFile = process.argv.slice(2).find(a => a.endsWith('.json')) ?? 'anti-meta-mb.json';
const teamPath = join(dataDirPath(), 'my-teams', teamFile);

// Per-species item candidate pools. Mixes the new M-B items with the current +
// staple alternatives. Species absent from this map are held FIXED.
const ITEM_POOL: Record<string, string[]> = {
  Pelipper: ['Focus Sash', 'Damp Rock', 'Life Orb', 'Wise Glasses', 'Expert Belt', 'Sitrus Berry', 'Wacan Berry', 'Leftovers'],
  'Rotom-Wash': ['Leftovers', 'Life Orb', 'Expert Belt', 'Wise Glasses', 'Sitrus Berry', 'Wacan Berry'],
  Talonflame: ['', 'Life Orb', 'Muscle Band', 'Expert Belt', 'Sharp Beak', 'Sitrus Berry'],
  Garchomp: ['Choice Scarf', 'Life Orb', 'Expert Belt', 'Muscle Band', 'Assault Vest', 'Dragon Fang'],
  // Dragonite (Dragoninite = mega) and Sneasler (White Herb = Unburden) omitted on purpose.
};

const team: PokemonSet[] = JSON.parse(readFileSync(teamPath, 'utf8'));
const pika = loadPikaData();
const gauntlet = [
  ...metaTeams(pika, argNum('--meta', 8), 3).map(m => ({ anchor: `[M-A] ${m.anchor}`, sets: m.sets })),
  ...MB_THREATS.map(m => ({ anchor: `[M-B] ${m.anchor}`, sets: m.sets })),
];
const G = gauntlet.length;
const pool = new MatchupPool();

interface Fit { floor: number; avg: number; flex: number }
const better = (a: Fit, b: Fit) => a.floor !== b.floor ? a.floor > b.floor : a.avg !== b.avg ? a.avg > b.avg : a.flex > b.flex;
const fitOf = (ms: Matchup[]): Fit => ({ floor: Math.min(...ms.map(m => m.score)), avg: ms.reduce((s, m) => s + m.score, 0) / ms.length, flex: new Set(ms.flatMap(m => m.myBring)).size });
const tasksFor = (t: PokemonSet[]): MatchupTask[] => gauntlet.map(g => ({ mine: t, oppSets: g.sets, oppAnchor: g.anchor, depth: DEPTH, budgetMs: BUDGET }));

console.log(`item optimization on ${teamFile} · ${G} boards · deepen 1→${DEPTH} @ ${BUDGET / 1000}s`);
let cur = team.map(s => ({ ...s }));
let curFit = fitOf(await pool.run(tasksFor(cur)));
console.log(`baseline: floor ${Math.round(curFit.floor)} avg ${Math.round(curFit.avg)} flex ${curFit.flex}\n`);

for (let round = 1; round <= 2; round++) {
  let improved = false;
  console.log(`=== round ${round} ===`);
  for (let slot = 0; slot < cur.length; slot++) {
    const pool0 = ITEM_POOL[cur[slot]!.species];
    if (!pool0) continue;
    const usedByOthers = new Set(cur.filter((_, i) => i !== slot).map(s => toId(s.item ?? '')));
    const cands = pool0.filter(it => (!it || isLegalItem(toId(it))) && (toId(it) === toId(cur[slot]!.item ?? '') || !usedByOthers.has(toId(it))));
    // One parallel batch: every candidate item × every board.
    const flat = cands.flatMap(it => tasksFor(cur.map((s, i) => (i === slot ? { ...s, item: it || undefined } : s))));
    const res = await pool.run(flat);
    const scored = cands.map((it, ci) => ({ it, fit: fitOf(res.slice(ci * G, (ci + 1) * G)) }));
    const bestCand = scored.reduce((b, c) => (better(c.fit, b.fit) ? c : b));
    const curItem = cur[slot]!.item || '(none)';
    if (better(bestCand.fit, curFit) && toId(bestCand.it) !== toId(cur[slot]!.item ?? '')) {
      console.log(`  ${cur[slot]!.species}: ${curItem} → ${bestCand.it || '(none)'}  floor ${Math.round(bestCand.fit.floor)} avg ${Math.round(bestCand.fit.avg)}  [ADOPT]`);
      cur[slot] = { ...cur[slot]!, item: bestCand.it || undefined };
      curFit = bestCand.fit; improved = true;
    } else {
      const top = scored.slice().sort((a, b) => (better(a.fit, b.fit) ? -1 : 1)).slice(0, 3).map(s => `${s.it || 'none'}(${Math.round(s.fit.floor)}/${Math.round(s.fit.avg)})`).join(', ');
      console.log(`  ${cur[slot]!.species}: kept ${curItem}  · tried: ${top}`);
    }
  }
  if (!improved) { console.log('\nno improving item swap — converged.'); break; }
}

console.log('\n=== ITEMS ===');
for (const s of cur) console.log(`  ${s.species.padEnd(12)} @ ${s.item || '(none)'}`);
console.log(`floor ${Math.round(curFit.floor)} · avg ${Math.round(curFit.avg)} · flex ${curFit.flex}`);
if (SAVE) { writeFileSync(teamPath, JSON.stringify(cur, null, 2)); console.log(`\nsaved ${teamPath}`); }
pool.close();
