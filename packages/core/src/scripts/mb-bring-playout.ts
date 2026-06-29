// Step 1 — rank ALL 15 of my brings vs an opponent by PLAYED-OUT win-rate, in
// parallel across cores (PlayoutPool). Shows the win-rate ranking next to the
// static opening-search rank (so the mid-range miscalibration Step-0 found is
// visible), and appends every game as a known-spread training row to
// data/training/playout-games.jsonl — the ML data engine.
//   npx tsx packages/core/src/scripts/mb-bring-playout.ts [oppAnchor|index] [games]
import { readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { searchIterative, type SearchInput } from '../domain/endgameSearch.js';
import { NEUTRAL_FIELD } from '../domain/types.js';
import { PlayoutPool, type PlayoutTask } from '../domain/playoutPool.js';
import type { PokemonSet } from '../domain/types.js';

const oppArg = process.argv[2] ?? '2';
const GAMES = parseInt(process.argv[3] ?? '16', 10);
const DEPTH = 2;

const team = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'anti-meta-mb.json'), 'utf8')) as PokemonSet[];
const opps = metaTeams(loadPikaData(), 4, 3);
const opp = opps.find(o => o.anchor.toLowerCase() === oppArg.toLowerCase()) ?? opps[parseInt(oppArg, 10)] ?? opps[2]!;

const oppEntries = opp.sets.map(entryOf);
const myEntries = team.map(entryOf);
const oppBringIdx = scoreBrings(opp.sets, myEntries)[0]!.myIndices;
const oppBring = oppBringIdx.map(i => opp.sets[i]!);

const combos: number[][] = [];
for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) for (let c = b + 1; c < 6; c++) for (let d = c + 1; d < 6; d++) combos.push([a, b, c, d]);

// Static opening-search score per bring (the baseline ranking we're testing).
const staticScore = combos.map(combo => {
  const input: SearchInput = {
    mine: combo.map((idx, k) => ({ set: team[idx]!, hpPercent: 100, active: k < 2 })),
    opp: oppBringIdx.map((j, k) => ({ entry: oppEntries[j]!, hpPercent: 100, active: k < 2 })),
    field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
  };
  return searchIterative(input, DEPTH).score;
});
const staticRank = combos.map((_, i) => i).sort((a, b) => staticScore[b]! - staticScore[a]!);
const staticRankOf = new Map<number, number>(staticRank.map((bi, r) => [bi, r + 1]));

console.log(`my team: ${team.map(t => t.species).join(', ')}`);
console.log(`opponent (${opp.anchor}): brings ${oppBring.map(s => s.species).join('/')}`);
console.log(`ranking all ${combos.length} brings · ${GAMES} games each · ${combos.length * GAMES} games total, parallel\n`);

const tasks: PlayoutTask[] = [];
const taskBring: number[] = [];
combos.forEach((combo, bi) => {
  const myBring = combo.map(i => team[i]!);
  for (let k = 0; k < GAMES; k++) { tasks.push({ p1: myBring, p2: oppBring, seed: [k + 1, 2 * k + 5, 3 * k + 7, 5 * k + 11], depth: DEPTH }); taskBring.push(bi); }
});

const t0 = Date.now();
const pool = new PlayoutPool();
const results = await pool.run(tasks);
pool.close();

const tally = combos.map(() => ({ w: 0, l: 0, t: 0 }));
results.forEach((r, idx) => { const c = tally[taskBring[idx]!]!; if (r.winner === 'p1') c.w++; else if (r.winner === 'tie') c.t++; else c.l++; });

// Append known-spread training rows (the ML data engine).
const outDir = join(dataDirPath(), 'training'); mkdirSync(outDir, { recursive: true });
const rows = results.map((r, idx) => JSON.stringify({
  oppAnchor: opp.anchor, myBring: combos[taskBring[idx]!]!.map(i => team[i]!.species), oppBring: oppBring.map(s => s.species),
  winner: r.winner, resolution: r.resolution, turns: r.turns,
}));
appendFileSync(join(outDir, 'playout-games.jsonl'), rows.join('\n') + '\n');

// Rank by win-rate, show static rank alongside.
const ranked = combos.map((combo, bi) => ({ bi, combo, wr: tally[bi]!.w / GAMES, c: tally[bi]! })).sort((a, b) => b.wr - a.wr);
console.log(`played-out rank  bring                                   win-rate     staticRank`);
ranked.forEach((row, r) => {
  const label = row.combo.map(i => team[i]!.species).join('/');
  console.log(`  #${String(r + 1).padEnd(2)}  ${label.padEnd(40)} ${String(Math.round(row.wr * 100) + '%').padStart(4)} (${row.c.w}/${row.c.l}/${row.c.t})   static #${staticRankOf.get(row.bi)}`);
});
const best = ranked[0]!, staticTop = combos[staticRank[0]!]!;
console.log(`\nplayed-out BEST: ${best.combo.map(i => team[i]!.species).join('/')} (${Math.round(best.wr * 100)}%)`);
console.log(`static-score BEST: ${staticTop.map(i => team[i]!.species).join('/')} (played ${Math.round(tally[staticRank[0]!]!.w / GAMES * 100)}%)`);
console.log(`\n${combos.length * GAMES} games in ${((Date.now() - t0) / 1000).toFixed(0)}s · rows → data/training/playout-games.jsonl`);
