// De-risk the full-game self-play loop: play a real Champions bring to a winner
// a few times with different seeds and report winner + turn count. Proves the
// sim loop, faint/switch handling, and terminal detection before we layer on the
// search policy + win-rate evaluation.
//   npx tsx packages/core/src/scripts/sim-playout-check.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { playGame, greedyPolicy, makeSearchPolicy } from '../domain/simPlayout.js';
import { dataDirPath } from '../domain/data.js';
import type { PokemonSet } from '../domain/types.js';

const team = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'anti-meta-mb.json'), 'utf8')) as PokemonSet[];
console.log(`team: ${team.map(t => t.species).join(', ')}`);
const p1 = team.slice(0, 4);          // bring of 4
const p2 = team.slice(0, 4);          // mirror (de-risk only)
console.log(`bring: ${p1.map(t => t.species).join(', ')}\n`);

const run = async (label: string, policy: ReturnType<typeof makeSearchPolicy> | typeof greedyPolicy, N: number) => {
  const t0 = Date.now();
  let p1w = 0, p2w = 0, ties = 0, kos = 0;
  for (let k = 0; k < N; k++) {
    const r = await playGame(p1, p2, { seed: [k + 1, 2 * k + 5, 3 * k + 7, 5 * k + 11], policy });
    if ('error' in r) { console.error(r.error); return; }
    if (r.winner === 'p1') p1w++; else if (r.winner === 'p2') p2w++; else ties++;
    if (r.resolution === 'kos') kos++;
  }
  console.log(`${label.padEnd(8)} ${N} games in ${Date.now() - t0}ms · p1 ${p1w} / p2 ${p2w} / tie ${ties} · ${kos}/${N} by KO`);
};

await run('greedy', greedyPolicy, 8);
await run('search', makeSearchPolicy(p1, p2, 2), 8);
