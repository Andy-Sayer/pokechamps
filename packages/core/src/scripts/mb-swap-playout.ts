// Targeted TEAM-improvement test (propose→dispose at the team level). The bring is
// near-maxed on this team; the ceiling is team composition (83% floors vs Pelipper/
// Sneasler/Sylveon). So: enumerate data-driven single-slot swaps (top meta mons not
// on the team — no hand-picking), static-pre-score them (fast proposer), then
// PLAYOUT-validate the finalists across the full gauntlet (the trustworthy metric)
// and compare avg + floor win-rate to the current team. A real improvement = a swap
// that lifts the floor/avg without sinking the rest.
//   npx tsx packages/core/src/scripts/mb-swap-playout.ts [games] [candidates] [finalists]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams, buildSet, baseSpeciesFor } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf, evaluateMatchup } from '../domain/teamSim.js';
import { PlayoutPool, bringWinRate } from '../domain/playoutPool.js';
import type { PokemonSet } from '../domain/types.js';

const GAMES = parseInt(process.argv[2] ?? '8', 10);
const N_CAND = parseInt(process.argv[3] ?? '4', 10);
const N_FINAL = parseInt(process.argv[4] ?? '4', 10);

const team = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'anti-meta-mb.json'), 'utf8')) as PokemonSet[];
const pika = loadPikaData();
const gauntlet = metaTeams(pika, 10, 4);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const sign = (d: number) => `${d >= 0 ? '+' : ''}${Math.round(d * 100)}%`;

// Data-driven candidate pool: top meta mons not already on the team.
const onTeam = new Set(team.map(t => t.species));
const candNames = pika.topPokemon.filter(n => !onTeam.has(n) && !onTeam.has(baseSpeciesFor(n))).slice(0, N_CAND);
console.log(`team: ${team.map(t => t.species).join(', ')}`);
console.log(`candidate swaps from meta: ${candNames.join(', ')}\n`);

function swapTeam(s: number, cand: string): PokemonSet[] | null {
  const used = new Set(team.filter((_, i) => i !== s).map(t => t.item).filter(Boolean) as string[]);
  const mon = buildSet(pika, cand, used);
  if (!mon) return null;
  const t = team.slice(); t[s] = mon; return t;
}
const staticScore = (myTeam: PokemonSet[]) => gauntlet.reduce((a, g) => a + evaluateMatchup(myTeam, g.sets, g.anchor, 2).score, 0) / gauntlet.length;

// PROPOSE: static pre-score every slot×candidate swap; keep the top finalists.
const baseStatic = staticScore(team);
const swaps: { s: number; cand: string; team: PokemonSet[]; stat: number }[] = [];
for (let s = 0; s < 6; s++) for (const cand of candNames) { const t = swapTeam(s, cand); if (t) swaps.push({ s, cand, team: t, stat: staticScore(t) }); }
swaps.sort((a, b) => b.stat - a.stat);
const finalists = swaps.slice(0, N_FINAL);
console.log(`① static pre-score (proposer): ${swaps.length} swaps · finalists:`);
for (const sw of finalists) console.log(`   slot ${sw.s} ${team[sw.s]!.species}→${sw.cand}  static ${sw.stat.toFixed(0)} (${sign((sw.stat - baseStatic) / 1000)})`);

// DISPOSE: playout the baseline + finalists across the full gauntlet.
async function gauntletWR(pool: PlayoutPool, myTeam: PokemonSet[]) {
  const per: { opp: string; wr: number }[] = [];
  for (const g of gauntlet) {
    const myBring = scoreBrings(myTeam, g.sets.map(entryOf))[0]!.myIndices.map(i => myTeam[i]!);
    const oppBring = scoreBrings(g.sets, myTeam.map(entryOf))[0]!.myIndices.map(i => g.sets[i]!);
    const r = await bringWinRate(pool, myBring, oppBring, GAMES, 2, true); // opponent piloted to its plan
    per.push({ opp: g.anchor, wr: r.winRate });
  }
  return { avg: per.reduce((a, c) => a + c.wr, 0) / per.length, floor: Math.min(...per.map(p => p.wr)), per };
}

console.log(`\n② playout-validate (${GAMES} games/matchup, full gauntlet):`);
const t0 = Date.now();
const pool = new PlayoutPool();
const base = await gauntletWR(pool, team);
console.log(`   BASELINE current team       avg ${pct(base.avg)}  floor ${pct(base.floor)}`);
const results: { label: string; avg: number; floor: number; per: { opp: string; wr: number }[] }[] = [];
for (const sw of finalists) {
  const r = await gauntletWR(pool, sw.team);
  results.push({ label: `${team[sw.s]!.species}→${sw.cand}`, ...r });
  console.log(`   ${`${team[sw.s]!.species}→${sw.cand}`.padEnd(26)} avg ${pct(r.avg)} (${sign(r.avg - base.avg)})  floor ${pct(r.floor)} (${sign(r.floor - base.floor)})`);
}
pool.close();

const best = results.slice().sort((a, b) => (b.avg + b.floor) - (a.avg + a.floor))[0];
const improved = best && (best.avg > base.avg + 0.03 || best.floor > base.floor + 0.05);
console.log(`\n③ ${improved ? `IMPROVEMENT: ${best!.label} (avg ${sign(best!.avg - base.avg)}, floor ${sign(best!.floor - base.floor)}) — worth a closer look` : 'no STATIC-PROPOSED swap beats the current team'}`);
// IMPORTANT honesty note: finalists were picked by the static pre-score, which the
// playout numbers above often show to be unreliable (it can rate team-wrecking
// swaps highest). So "no improvement" is NOT proven — a sound search must playout
// ALL swaps unpruned (--full, ~30 min). The trustworthy result here is the BASELINE.
console.log(`   ⚠ finalists chosen by the static score (shown unreliable) — run unpruned for a sound search`);
console.log(`   floors vs ${gauntlet.map(g => g.anchor).join('/')}`);
console.log(`   ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
