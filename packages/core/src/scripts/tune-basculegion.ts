// Tune the Garchomp→Basculegion swap with REAL sets (data-driven from Pikalytics:
// Adaptability, items Choice Scarf / Mystic Water / Focus Sash, moves Last Respects/
// Aqua Jet/Wave Crash/Protect/Flip Turn) and battle-eval each vs the gauntlet
// (piloted opponents, 16 games). Confirms whether a TUNED Basculegion holds the
// floor improvement found with the stock set. Reports floor/avg + the Incineroar
// matchup (the floor it patches).
//   npx tsx packages/core/src/scripts/tune-basculegion.ts [games]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams, buildSet } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { PlayoutPool, bringWinRate } from '../domain/playoutPool.js';
import { ZERO_EVS, MAX_IVS, type PokemonSet, type Stats } from '../domain/types.js';

const GAMES = parseInt(process.argv[2] ?? '16', 10);
const team = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'anti-meta-mb.json'), 'utf8')) as PokemonSet[];
const gauntlet = metaTeams(loadPikaData(), 10, 4);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const E = (o: Partial<Stats>): Stats => ({ ...ZERO_EVS, ...o });

const basc = (label: string, item: string, nature: string, evs: Stats, moves: string[]): { label: string; set: PokemonSet } => ({
  label, set: { species: 'Basculegion', ability: 'Adaptability', item, nature, level: 50, evs, ivs: { ...MAX_IVS }, moves },
});

const ATKMVS = ['Last Respects', 'Wave Crash', 'Aqua Jet', 'Flip Turn'];   // Scarf wants 4 attacks
const PROTMVS = ['Last Respects', 'Wave Crash', 'Aqua Jet', 'Protect'];     // non-locked → Protect
const candidates = [
  basc('stock (Pikalytics buildSet)', '', '', E({}), []), // placeholder → replaced below
  basc('Scarf Adamant', 'Choice Scarf', 'Adamant', E({ atk: 252, spe: 252, hp: 4 }), ATKMVS),
  basc('Scarf Jolly', 'Choice Scarf', 'Jolly', E({ atk: 252, spe: 252, hp: 4 }), ATKMVS),
  basc('Mystic Water Adamant', 'Mystic Water', 'Adamant', E({ atk: 252, spe: 252, hp: 4 }), PROTMVS),
  basc('Focus Sash Jolly', 'Focus Sash', 'Jolly', E({ atk: 252, spe: 252, hp: 4 }), PROTMVS),
];
candidates[0]!.set = buildSet(loadPikaData(), 'Basculegion', new Set(team.filter(t => t.species !== 'Garchomp').map(t => t.item).filter(Boolean) as string[]))!;

const teamWith = (b: PokemonSet) => team.map(t => (t.species === 'Garchomp' ? b : t));

const pool = new PlayoutPool();
async function gauntletWR(myTeam: PokemonSet[]) {
  const per: { opp: string; wr: number }[] = [];
  for (const g of gauntlet) {
    const myBring = scoreBrings(myTeam, g.sets.map(entryOf))[0]!.myIndices.map(i => myTeam[i]!);
    const oppBring = scoreBrings(g.sets, myTeam.map(entryOf))[0]!.myIndices.map(i => g.sets[i]!);
    const r = await bringWinRate(pool, myBring, oppBring, GAMES, 2, true);
    per.push({ opp: g.anchor, wr: r.winRate });
  }
  const inc = per.find(p => p.opp === 'Incineroar')?.wr ?? NaN;
  return { avg: per.reduce((a, c) => a + c.wr, 0) / per.length, floor: Math.min(...per.map(p => p.wr)), inc, per };
}

console.log(`tuning Garchomp→Basculegion · ${GAMES} games/matchup · piloted\n`);
const base = await gauntletWR(team);
console.log(`current team (no swap)        avg ${pct(base.avg)}  floor ${pct(base.floor)}  · Incineroar ${pct(base.inc)}`);
const results: { label: string; avg: number; floor: number; inc: number; set: PokemonSet }[] = [];
for (const c of candidates) {
  const r = await gauntletWR(teamWith(c.set));
  results.push({ label: c.label, ...r, set: c.set });
  console.log(`${c.label.padEnd(28)} avg ${pct(r.avg)}  floor ${pct(r.floor)}  · Incineroar ${pct(r.inc)}`);
}
pool.close();

const best = results.slice().sort((a, b) => (b.floor + b.avg) - (a.floor + a.avg))[0]!;
console.log(`\nBEST tuned set: ${best.label} — avg ${pct(best.avg)} / floor ${pct(best.floor)} / Incineroar ${pct(best.inc)}`);
console.log(`  ${best.set.nature} @ ${best.set.item} · ${best.set.moves.join('/')}`);
console.log(`  (vs current team avg ${pct(base.avg)} / floor ${pct(base.floor)})`);
