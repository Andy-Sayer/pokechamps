// Confirm the overnight swap-search standout (Garchomp→Basculegion) with MORE games
// + per-opponent detail, to de-noise the floor jump and NAME the matchup it patches.
//   npx tsx packages/core/src/scripts/confirm-swap.ts [games]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams, buildSet } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { PlayoutPool, bringWinRate } from '../domain/playoutPool.js';
import type { PokemonSet } from '../domain/types.js';

const GAMES = parseInt(process.argv[2] ?? '16', 10);
const team = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'anti-meta-mb.json'), 'utf8')) as PokemonSet[];
const gauntlet = metaTeams(loadPikaData(), 10, 4);
const pct = (x: number) => `${Math.round(x * 100)}%`;

// Build the Garchomp→Basculegion variant (stock Basculegion set, item-clause-safe).
function swap(slotSpecies: string, cand: string): PokemonSet[] {
  const used = new Set(team.filter(t => t.species !== slotSpecies).map(t => t.item).filter(Boolean) as string[]);
  const mon = buildSet(loadPikaData(), cand, used)!;
  return team.map(t => (t.species === slotSpecies ? mon : t));
}
const swapped = swap('Garchomp', 'Basculegion');

const pool = new PlayoutPool();
async function gauntletWR(myTeam: PokemonSet[]) {
  const per: { opp: string; wr: number }[] = [];
  for (const g of gauntlet) {
    const myBring = scoreBrings(myTeam, g.sets.map(entryOf))[0]!.myIndices.map(i => myTeam[i]!);
    const oppBring = scoreBrings(g.sets, myTeam.map(entryOf))[0]!.myIndices.map(i => g.sets[i]!);
    const r = await bringWinRate(pool, myBring, oppBring, GAMES, 2, true); // piloted opponent
    per.push({ opp: g.anchor, wr: r.winRate });
  }
  const avg = per.reduce((a, c) => a + c.wr, 0) / per.length;
  return { per, avg, floor: Math.min(...per.map(p => p.wr)) };
}

console.log(`confirm Garchomp→Basculegion · ${GAMES} games/matchup · piloted opponents\n`);
const base = await gauntletWR(team);
const cand = await gauntletWR(swapped);
pool.close();

console.log(`opponent      baseline   +Basculegion`);
for (let i = 0; i < gauntlet.length; i++) {
  const b = base.per[i]!, c = cand.per[i]!;
  const mark = c.wr > b.wr + 0.05 ? ' ↑' : c.wr < b.wr - 0.05 ? ' ↓' : '';
  console.log(`  ${b.opp.padEnd(12)} ${pct(b.wr).padStart(4)}      ${pct(c.wr).padStart(4)}${mark}`);
}
const floorOpp = (r: typeof base) => r.per.reduce((m, p) => (p.wr < m.wr ? p : m)).opp;
console.log(`\nBASELINE        avg ${pct(base.avg)}  floor ${pct(base.floor)} (vs ${floorOpp(base)})`);
console.log(`+Basculegion    avg ${pct(cand.avg)}  floor ${pct(cand.floor)} (vs ${floorOpp(cand)})`);
