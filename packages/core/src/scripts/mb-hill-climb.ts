// Adapt the validated baseline to Reg M-B by ENGINE hill-climb (no LLM judgement)
// against the M-A meta gauntlet + the hand-built M-B threat teams. Optimises the
// FULL-gauntlet floor, so a swap is adopted only if it raises the worst matchup
// WITHOUT opening a worse one — which is exactly what manual single-swaps failed
// to guarantee (they traded Metagross for Mawile/Tyranitar).
//
//   NODE_OPTIONS=--max-old-space-size=8192 \
//     npx tsx packages/core/src/scripts/mb-hill-climb.ts [--save] [--rounds N] [--pool N]
//
// Two-stage per round (mirrors optimize-spreads' parallel batching):
//   1. SCOUT every (slot × candidate) swap against ONLY the current worst board
//      in one parallel batch — cheap, prunes to swaps that actually fix it.
//   2. VERIFY the top survivors on the FULL gauntlet; adopt the best that beats
//      the incumbent's (floor, avg, flex).
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId, getItem } from '../domain/data.js';
import { loadPikaData, metaTeams, buildSet, baseSpeciesFor } from '../domain/metaTeams.js';
import { MatchupPool, type MatchupTask } from '../domain/matchupPool.js';
import { detectTactics, profileFromSet, tacticLabel } from '../domain/tactics.js';
import type { Matchup } from '../domain/teamSim.js';
import type { PokemonSet } from '../domain/types.js';
import { MB_THREATS } from './mbThreats.js';

const argNum = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const SAVE = process.argv.includes('--save');
const ROUNDS = argNum('--rounds', 2);
const POOL_N = argNum('--pool', 16);
const META_N = argNum('--meta', 8);
const DEPTH = argNum('--depth', 5);
const BUDGET_SCOUT = argNum('--scout', 8000);
const BUDGET_VERIFY = argNum('--verify', 15000);
const VERIFY_TOP = 6;

const pika = loadPikaData();
const gauntlet = [
  ...metaTeams(pika, META_N, 3).map(m => ({ anchor: `[M-A] ${m.anchor}`, sets: m.sets })),
  ...MB_THREATS.map(m => ({ anchor: `[M-B] ${m.anchor}`, sets: m.sets })),
];
const swapPool = pika.topPokemon.slice(0, POOL_N);
const pool = new MatchupPool();

const megaCount = (t: PokemonSet[]) => t.filter(s => !!(getItem(s.item ?? '') as { megaStone?: unknown } | undefined)?.megaStone).length;
interface Fit { floor: number; avg: number; flex: number; matchups: Matchup[] }
const better = (a: Fit, b: Fit) => a.floor !== b.floor ? a.floor > b.floor : a.avg !== b.avg ? a.avg > b.avg : a.flex > b.flex;

async function fullFit(team: PokemonSet[], budget: number): Promise<Fit> {
  const ms = await pool.run(gauntlet.map(g => ({ mine: team, oppSets: g.sets, oppAnchor: g.anchor, depth: DEPTH, budgetMs: budget })));
  const floor = Math.min(...ms.map(m => m.score));
  const avg = ms.reduce((s, m) => s + m.score, 0) / ms.length;
  const flex = new Set(ms.flatMap(m => m.myBring)).size;
  return { floor, avg, flex, matchups: ms };
}
const fmt = (t: PokemonSet[]) => t.map(s => s.species).join(', ');

const baseline: PokemonSet[] = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'anti-meta.json'), 'utf8'));
console.log(`gauntlet: ${gauntlet.length} boards · swap pool ${swapPool.length} · deepen 1→${DEPTH} · scout ${BUDGET_SCOUT / 1000}s / verify ${BUDGET_VERIFY / 1000}s`);
console.log(`baseline: ${fmt(baseline)}`);
let best = { label: 'baseline', team: baseline, fit: await fullFit(baseline, BUDGET_VERIFY) };
console.log(`  floor ${Math.round(best.fit.floor)} avg ${Math.round(best.fit.avg)} flex ${best.fit.flex}\n`);

for (let round = 1; round <= ROUNDS; round++) {
  // Worst board = the one setting the floor.
  const worstIdx = best.fit.matchups.reduce((wi, m, i, a) => (m.score < a[wi]!.score ? i : wi), 0);
  const worst = gauntlet[worstIdx]!;
  const worstScore = best.fit.matchups[worstIdx]!.score;
  console.log(`round ${round}: worst board ${worst.anchor} (${Math.round(worstScore)}) — scouting swaps…`);

  // Build all valid (slot × candidate) trials.
  const trials: { label: string; team: PokemonSet[] }[] = [];
  for (let slot = 0; slot < best.team.length; slot++) {
    for (const cand of swapPool) {
      if (best.team.some((s, i) => i !== slot && baseSpeciesFor(s.species) === baseSpeciesFor(cand))) continue;
      if (baseSpeciesFor(best.team[slot]!.species) === baseSpeciesFor(cand)) continue;
      const used = new Set(best.team.filter((_, i) => i !== slot).map(s => toId(s.item ?? '')));
      const candSet = buildSet(pika, cand, used);
      if (!candSet) continue;
      const team = best.team.map((s, i) => (i === slot ? candSet : s));
      if (megaCount(team) > 1) continue;
      trials.push({ label: `${best.team[slot]!.species}→${candSet.species}`, team });
    }
  }
  // SCOUT: every trial vs the worst board only, one parallel batch.
  const scoutTasks: MatchupTask[] = trials.map(t => ({ mine: t.team, oppSets: worst.sets, oppAnchor: worst.anchor, depth: DEPTH, budgetMs: BUDGET_SCOUT }));
  const scout = await pool.run(scoutTasks);
  const survivors = trials
    .map((t, i) => ({ ...t, w: scout[i]!.score }))
    .filter(s => s.w > worstScore)
    .sort((a, b) => b.w - a.w)
    .slice(0, VERIFY_TOP);
  console.log(`  ${trials.length} trials → ${survivors.length} fix the worst board; verifying top ${survivors.length} on full gauntlet…`);

  // VERIFY survivors on the full gauntlet; adopt the best improvement.
  let improved = false;
  for (const s of survivors) {
    const fit = await fullFit(s.team, BUDGET_VERIFY);
    const tag = better(fit, best.fit) ? 'ADOPT' : 'no';
    console.log(`    ${s.label.padEnd(26)} floor ${Math.round(fit.floor)} avg ${Math.round(fit.avg)} flex ${fit.flex}  [${tag}]`);
    if (better(fit, best.fit)) { best = { label: s.label, team: s.team, fit }; improved = true; }
  }
  console.log(`  → best after round ${round}: ${best.label} floor ${Math.round(best.fit.floor)} avg ${Math.round(best.fit.avg)}\n`);
  if (!improved) { console.log('no improving swap — converged.'); break; }
}

console.log('=== M-B TEAM ===');
for (const s of best.team) console.log(`  ${s.species} @ ${s.item ?? '(none)'} · ${s.ability} · ${s.nature} · ${s.moves.join(' / ')}`);
console.log('\nper-board (maximin; + favors us):');
for (const m of [...best.fit.matchups].sort((a, b) => a.score - b.score)) {
  console.log(`  ${m.anchor.padEnd(28)} ${String(Math.round(m.score)).padStart(6)}  ${m.verdict}`);
}
console.log(`floor ${Math.round(best.fit.floor)} · avg ${Math.round(best.fit.avg)} · flex ${best.fit.flex}/6`);
const combos = detectTactics(best.team.map(profileFromSet)).slice(0, 4);
if (combos.length) console.log('combos: ' + combos.map(t => `${t.name} (${tacticLabel(t)})`).join(' · '));

if (SAVE && best.label !== 'baseline') {
  const file = join(dataDirPath(), 'my-teams', 'anti-meta-mb.json');
  writeFileSync(file, JSON.stringify(best.team, null, 2));
  console.log(`\nsaved ${file}`);
} else if (best.label === 'baseline') {
  console.log('\nno swap beat the baseline — nothing saved.');
}
pool.close();
