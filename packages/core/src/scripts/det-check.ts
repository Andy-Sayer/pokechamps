// Pooled DETERMINISTIC validator — the honest, reproducible, all-cores replacement
// for the sequential deep-validate. Both sides play at the same node budget
// (SYMMETRIC = fair fight, not us-deep/opp-shallow), reproducible (node cut, no
// wall-clock), parallel across the pool. Two modes:
//   validate: --team T --opps a,b,c --nodes N --games G   (win-rate per opponent)
//   sweep:    --sweep --team T --opp X --budgets 0.5,1,2,4 (depth-sensitivity of one cell)
//   npx tsx packages/core/src/scripts/det-check.ts --team rain-mb-final --opps Metagross,Sneasler --nodes 2000000 --games 6
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { MB_THREATS } from './mbThreats.js';
import { PlayoutPool, bringWinRate } from '../domain/playoutPool.js';
import type { PokemonSet } from '../domain/types.js';

const argStr = (f: string, d: string) => { const i = process.argv.indexOf(f); return i >= 0 ? String(process.argv[i + 1]) : d; };
const argNum = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const load = (f: string) => JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', f), 'utf8')) as PokemonSet[];
const team = load(`${argStr('--team', 'rain-mb-final')}.json`);
const pika = loadPikaData();
const allOpps = [...MB_THREATS.map(m => ({ anchor: m.anchor, sets: m.sets })), ...metaTeams(pika, 12, 4).map(m => ({ anchor: m.anchor, sets: m.sets }))];
const pick = (s: string) => allOpps.find(o => o.anchor.toLowerCase().includes(s.toLowerCase()))!;
const GAMES = argNum('--games', 6), SPL = argNum('--spl', 2), DEPTH = 14;
const pct = (x: number) => `${Math.round(x * 100)}%`;
// Ninetales needs the no-Garchomp bring (scoreBrings mis-picks the 4x-Ice liability).
const bringFor = (opp: { anchor: string; sets: PokemonSet[] }): PokemonSet[] =>
  opp.anchor.toLowerCase().includes('ninetales')
    ? team.filter(s => !['garchomp', 'talonflame'].includes(toId(s.species)))
    : scoreBrings(team, opp.sets.map(entryOf))[0]!.myIndices.map(i => team[i]!);

const pool = new PlayoutPool();
if (process.argv.includes('--sweep')) {
  const opp = pick(argStr('--opp', 'Metagross'));
  const budgets = argStr('--budgets', '0.5,1,2,4').split(',').map(x => Number(x) * 1e6);
  const myB = bringFor(opp), oppB = scoreBrings(opp.sets, team.map(entryOf))[0]!.myIndices.map(i => opp.sets[i]!);
  console.log(`SWEEP · ${argStr('--team', 'rain-mb-final')} vs ${opp.anchor} · symmetric node budgets · ${GAMES} games · spl${SPL}\n`);
  for (const nb of budgets) {
    const r = await bringWinRate(pool, myB, oppB, GAMES, DEPTH, false, { nodeBudget: nb, breadth: { switchPlyLimit: SPL } });
    console.log(`  ${(nb / 1e6).toFixed(1)}M nodes: ${pct(r.winRate)} (${r.wins}/${GAMES})`);
  }
} else {
  const nb = argNum('--nodes', 2000000);
  const opps = argStr('--opps', 'Sneasler,Metagross,Raichu,Swampert,Ninetales,Blaziken').split(',').map(s => s.trim()).map(pick);
  console.log(`DET-CHECK · ${argStr('--team', 'rain-mb-final')} · ${(nb / 1e6).toFixed(1)}M nodes(symmetric,det) · spl${SPL} · ${GAMES} games\n`);
  for (const opp of opps) {
    const myB = bringFor(opp), oppB = scoreBrings(opp.sets, team.map(entryOf))[0]!.myIndices.map(i => opp.sets[i]!);
    const r = await bringWinRate(pool, myB, oppB, GAMES, DEPTH, false, { nodeBudget: nb, breadth: { switchPlyLimit: SPL } });
    console.log(`  vs ${opp.anchor.padEnd(26)} ${pct(r.winRate).padStart(4)} (${r.wins}/${GAMES})`);
  }
}
pool.close();
process.exit(0);
