// The HYBRID bring decision, headless + testable: the value model PROPOSES (ranks
// all 15 brings, fast) → the simulator DISPOSES (plays out only the shortlist,
// mechanically perfect) → pick the best by actual win-rate. This is the live
// architecture (project_sim_playout): the model's blind spots (e.g. Gholdengo)
// don't decide anything — the sim catches them on the shortlist.
//   npx tsx packages/core/src/scripts/recommend-bring.ts [oppAnchor|idx] [topK] [games]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { bringWinProb, bringModelAvailable, bringModelInfo } from '../domain/bringValueModel.js';
import { PlayoutPool, bringWinRate } from '../domain/playoutPool.js';
import type { PokemonSet } from '../domain/types.js';

const oppArg = process.argv[2] ?? '2';
const TOPK = parseInt(process.argv[3] ?? '5', 10);
const GAMES = parseInt(process.argv[4] ?? '16', 10);

const team = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'anti-meta-mb.json'), 'utf8')) as PokemonSet[];
if (!bringModelAvailable()) { console.error('no value model on disk — run `npx tsx packages/core/src/scripts/mb-train-value.ts` first'); process.exit(1); }
const info = bringModelInfo();
const opps = metaTeams(loadPikaData(), 12, 3);
const opp = opps.find(o => o.anchor.toLowerCase() === oppArg.toLowerCase()) ?? opps[parseInt(oppArg, 10)] ?? opps[2]!;
const oppBring = scoreBrings(opp.sets, team.map(entryOf))[0]!.myIndices.map(i => opp.sets[i]!);

const combos: number[][] = [];
for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) for (let c = b + 1; c < 6; c++) for (let d = c + 1; d < 6; d++) combos.push([a, b, c, d]);
const label = (combo: number[]) => combo.map(i => team[i]!.species).join('/');

console.log(`my team: ${team.map(t => t.species).join(', ')}`);
console.log(`opponent (${opp.anchor}): ${oppBring.map(s => s.species).join('/')}`);
console.log(`value model: ${info?.trainedOn} matchups, ${info?.date}\n`);

// ① PROPOSE — model ranks all 15 brings.
const t0 = Date.now();
const proposed = combos.map(combo => ({ combo, p: bringWinProb(combo.map(i => team[i]!), oppBring) ?? 0 })).sort((a, b) => b.p - a.p);
console.log(`① PROPOSE — model ranked 15 brings in ${((Date.now() - t0) / 1000).toFixed(1)}s · top ${TOPK}:`);
proposed.slice(0, TOPK).forEach((r, i) => console.log(`   ${i + 1}. ${label(r.combo).padEnd(40)} model ${Math.round(r.p * 100)}%`));

// ② DISPOSE — simulate the shortlist, rank by actual win-rate.
console.log(`\n② DISPOSE — playing out the top-${TOPK} (${GAMES} games each, parallel):`);
const pool = new PlayoutPool();
const shortlist = proposed.slice(0, TOPK);
const simmed: { combo: number[]; p: number; wr: number; rec: string }[] = [];
for (const { combo, p } of shortlist) {
  const r = await bringWinRate(pool, combo.map(i => team[i]!), oppBring, GAMES, 2, true); // opponent piloted to its plan

  simmed.push({ combo, p, wr: r.winRate, rec: `${r.wins}/${r.losses}/${r.ties}` });
}
pool.close();
simmed.sort((a, b) => b.wr - a.wr);
simmed.forEach((r, i) => console.log(`   ${i + 1}. ${label(r.combo).padEnd(40)} sim ${String(Math.round(r.wr * 100) + '%').padStart(4)} (${r.rec})  · model said ${Math.round(r.p * 100)}%`));

// ③ PICK.
const pick = simmed[0]!;
console.log(`\n③ PICK: ${label(pick.combo)} — ${Math.round(pick.wr * 100)}% simulated`);
console.log(shortlist[0]!.combo.join() === pick.combo.join()
  ? `   model's #1 confirmed by simulation ✓`
  : `   model proposed ${label(shortlist[0]!.combo)}; sim found a better bring in the shortlist (why the sim decides, not the model)`);
console.log(`\ntotal ${((Date.now() - t0) / 1000).toFixed(0)}s`);
