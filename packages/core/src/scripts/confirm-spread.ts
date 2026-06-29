// Playout-confirm the wide spread optimizer's result. optimize-spreads scores on
// the STATIC search metric (fast enough to go wide, but miscalibrated for big
// swings); this is the trust-anchor dispose step: gauntlet win-rate of the
// spread-optimized team vs the original, with PILOTED opponents.
//   npx tsx packages/core/src/scripts/confirm-spread.ts [games] [optFile]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { PlayoutPool, bringWinRate } from '../domain/playoutPool.js';
import type { PokemonSet } from '../domain/types.js';

const GAMES = parseInt(process.argv[2] ?? '16', 10);
const OPT = process.argv[3] ?? 'anti-meta-mb-spreadopt.json';
const load = (f: string) => JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', f), 'utf8')) as PokemonSet[];
const orig = load('anti-meta-mb.json');
const opt = load(OPT);
const gauntlet = metaTeams(loadPikaData(), 10, 4);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const pool = new PlayoutPool();

async function gauntletWR(myTeam: PokemonSet[]) {
  const per: { opp: string; wr: number }[] = [];
  for (const g of gauntlet) {
    const myBring = scoreBrings(myTeam, g.sets.map(entryOf))[0]!.myIndices.map(i => myTeam[i]!);
    const oppBring = scoreBrings(g.sets, myTeam.map(entryOf))[0]!.myIndices.map(i => g.sets[i]!);
    const r = await bringWinRate(pool, myBring, oppBring, GAMES, 2, true);
    per.push({ opp: g.anchor, wr: r.winRate });
  }
  return { avg: per.reduce((a, c) => a + c.wr, 0) / per.length, floor: Math.min(...per.map(p => p.wr)), per };
}

console.log(`spread-opt confirm · ${GAMES} games/matchup · piloted · opt=${OPT}\n`);
const b = await gauntletWR(orig);
const o = await gauntletWR(opt);
pool.close();
console.log(`original     avg ${pct(b.avg)}  floor ${pct(b.floor)}`);
console.log(`spread-opt   avg ${pct(o.avg)}  floor ${pct(o.floor)}`);
const dAvg = o.avg - b.avg, dFloor = o.floor - b.floor;
console.log(`delta        avg ${dAvg >= 0 ? '+' : ''}${Math.round(dAvg * 100)}pp  floor ${dFloor >= 0 ? '+' : ''}${Math.round(dFloor * 100)}pp\n`);
console.log('per-opponent (orig → opt):');
for (let i = 0; i < b.per.length; i++) {
  const d = o.per[i]!.wr - b.per[i]!.wr;
  console.log(`  ${b.per[i]!.opp.padEnd(12)} ${pct(b.per[i]!.wr)} → ${pct(o.per[i]!.wr)}  (${d >= 0 ? '+' : ''}${Math.round(d * 100)}pp)`);
}
