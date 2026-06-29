// ML data engine — generate a labeled matchup dataset by parallel playout. For
// our team × N meta opponents × all 15 brings, play K paired-seed games and emit
// one row per matchup with the FULL sets (self-contained for feature extraction)
// + the played-out win-rate label. One pool, all games submitted at once for max
// parallelism. Output: data/training/playout-matchups.jsonl.
//   npx tsx packages/core/src/scripts/gen-playout-data.ts [opponents] [games]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { PlayoutPool, type PlayoutTask } from '../domain/playoutPool.js';
import type { PokemonSet } from '../domain/types.js';

const N_OPP = parseInt(process.argv[2] ?? '10', 10);
const GAMES = parseInt(process.argv[3] ?? '12', 10);
const DEPTH = 2;

const team = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'anti-meta-mb.json'), 'utf8')) as PokemonSet[];
const opps = metaTeams(loadPikaData(), N_OPP, 4);
const combos: number[][] = [];
for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) for (let c = b + 1; c < 6; c++) for (let d = c + 1; d < 6; d++) combos.push([a, b, c, d]);

interface Cell { oppAnchor: string; myBring: PokemonSet[]; oppBring: PokemonSet[] }
const cells: Cell[] = [];
const tasks: PlayoutTask[] = [];
const taskCell: number[] = [];
for (const opp of opps) {
  const oppBring = scoreBrings(opp.sets, team.map(entryOf))[0]!.myIndices.map(i => opp.sets[i]!);
  for (const combo of combos) {
    const myBring = combo.map(i => team[i]!);
    const ci = cells.length;
    cells.push({ oppAnchor: opp.anchor, myBring, oppBring });
    for (let k = 0; k < GAMES; k++) { tasks.push({ p1: myBring, p2: oppBring, seed: [k + 1, 2 * k + 5, 3 * k + 7, 5 * k + 11], depth: DEPTH, pilotOpp: true }); taskCell.push(ci); }
  }
}
console.log(`${opps.length} opponents × ${combos.length} brings = ${cells.length} matchups · ${GAMES} games each · ${tasks.length} games total`);

const t0 = Date.now();
const pool = new PlayoutPool();
const results = await pool.run(tasks);
pool.close();

const tally = cells.map(() => ({ w: 0, l: 0, t: 0 }));
results.forEach((r, idx) => { const c = tally[taskCell[idx]!]!; if (r.winner === 'p1') c.w++; else if (r.winner === 'tie') c.t++; else c.l++; });

const outDir = join(dataDirPath(), 'training'); mkdirSync(outDir, { recursive: true });
const rows = cells.map((cell, i) => JSON.stringify({
  oppAnchor: cell.oppAnchor,
  myBring: cell.myBring, oppBring: cell.oppBring, // full sets — self-contained for features
  games: GAMES, wins: tally[i]!.w, losses: tally[i]!.l, ties: tally[i]!.t, winRate: tally[i]!.w / GAMES,
}));
writeFileSync(join(outDir, 'playout-matchups.jsonl'), rows.join('\n') + '\n');
console.log(`\n${cells.length} matchup rows → data/training/playout-matchups.jsonl · ${tasks.length} games in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
