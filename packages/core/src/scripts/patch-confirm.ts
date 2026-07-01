// Corrected patch pass: the patch-hunt's Ninetales column was confounded by
// scoreBrings picking the Garchomp bring (the 4x-Ice liability = auto-loss). Here
// we FORCE a sensible rain bring for each team — Pelipper + Dragonite + the two
// non-(Garchomp/Talonflame) mons — so Garchomp is excluded BY CONSTRUCTION, and
// deep-validate vs Ninetales. Pooled + deep. Only the Sneasler-safe candidates
// (Meowscarada swaps + Sableye) + baseline; compares real best-bring Ninetales.
//   npx tsx packages/core/src/scripts/patch-confirm.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { MB_THREATS } from './mbThreats.js';
import { PlayoutPool, bringWinRate } from '../domain/playoutPool.js';
import type { PokemonSet } from '../domain/types.js';

const load = (f: string) => JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', f), 'utf8')) as PokemonSet[];
const files = ['rain-mb.json', 'patch-meowscarada-archaludon.json', 'patch-meowscarada-gholdengo.json', 'patch-meowscarada-metagross.json', 'patch-meowscarada-sableye.json', 'patch-kingambit-sableye.json'];
const teams = files.map(f => ({ name: f.replace('.json', ''), sets: load(f) }));
const pika = loadPikaData();
const allOpps = [...MB_THREATS.map(m => ({ anchor: m.anchor, sets: m.sets })), ...metaTeams(pika, 12, 4).map(m => ({ anchor: m.anchor, sets: m.sets }))];
const nine = allOpps.find(o => o.anchor.toLowerCase().includes('ninetales'))!;
const oppBring = scoreBrings(nine.sets, teams[0]!.sets.map(entryOf))[0]!.myIndices.map(i => nine.sets[i]!);
const GAMES = 6, DEPTH = 14, BUDGET = 20000, SPL = 5;
const pct = (x: number) => `${Math.round(x * 100)}%`;

// Forced Ninetales bring = everything EXCEPT Garchomp/Talonflame (leaves Pelipper +
// Dragonite + the two others = 4). Rain lead, no 4x-Ice liability.
const ninetalesBring = (sets: PokemonSet[]) => sets.filter(s => !['garchomp', 'talonflame'].includes(toId(s.species)));

const pool = new PlayoutPool();
console.log(`patch-confirm · Ninetales @ FORCED no-Garchomp rain bring · ${GAMES} deep games (b${BUDGET / 1000}s/spl${SPL})`);
console.log(`opp: ${oppBring.map(s => s.species).join('/')}\n`);
for (const t of teams) {
  const mb = ninetalesBring(t.sets);
  if (mb.length !== 4) { console.log(`  ${t.name}: bring has ${mb.length} mons (skip)`); continue; }
  const r = await bringWinRate(pool, mb, oppBring, GAMES, DEPTH, false, { budgetMs: BUDGET, breadth: { switchPlyLimit: SPL } });
  console.log(`  ${t.name.padEnd(28)} Ninetales ${pct(r.winRate).padStart(4)}  (${r.wins}/${GAMES})  bring: ${mb.map(s => s.species).join('/')}`);
}
pool.close();
console.log(`\n(baseline rain-mb's forced bring = Pelipper/Kingambit/Dragonite/Meowscarada, the 2/4 line; a patch must clearly beat it)`);
process.exit(0);
