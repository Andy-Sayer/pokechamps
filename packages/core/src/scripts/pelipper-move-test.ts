// Pelipper 4th-move test: Wide Guard vs Protect. Builds two variants of the final
// team differing ONLY in Pelipper's 4th move and plays both through the matchups
// where the choice should matter most (spread-move-heavy opponents: Ninetales
// Blizzard, Swampert rain-mirror EQ/Muddy, Metagross EQ, Raichu terrain spreads)
// + the Sneasler guard, deep + pooled.
//
// READING THE RESULT (design caveat): the sim opponent clicks spread moves into
// Wide Guard freely — real humans play around it — so the sim is WIDE GUARD'S
// BEST CASE. If Protect >= Wide Guard here, Protect is strictly right (per the
// user's experience that spread moves don't get clicked at Pelipper anyway).
// If Wide Guard wins big, it's ambiguous and the margin matters.
//   npx tsx packages/core/src/scripts/pelipper-move-test.ts [team.json]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { MB_THREATS } from './mbThreats.js';
import { PlayoutPool, bringWinRate } from '../domain/playoutPool.js';
import type { PokemonSet } from '../domain/types.js';

const TEAM = process.argv[2] ?? 'rain-mb.json';
const base = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', TEAM), 'utf8')) as PokemonSet[];
const withMove = (mv: string): PokemonSet[] => base.map(s => toId(s.species) === 'pelipper'
  ? { ...s, moves: s.moves.map(m => (toId(m) === 'wideguard' || toId(m) === 'protect') ? mv : m) }
  : s);
const variants = [
  { name: 'Wide Guard', sets: withMove('Wide Guard') },
  { name: 'Protect', sets: withMove('Protect') },
];

const pika = loadPikaData();
const allOpps = [...MB_THREATS.map(m => ({ anchor: m.anchor, sets: m.sets })), ...metaTeams(pika, 12, 4).map(m => ({ anchor: m.anchor, sets: m.sets }))];
const pick = (s: string) => allOpps.find(o => o.anchor.toLowerCase().includes(s.toLowerCase()))!;
const argStr = (f: string, d: string) => { const i = process.argv.indexOf(f); return i >= 0 ? String(process.argv[i + 1]) : d; };
const argNum = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const opps = argStr('--opps', 'Ninetales,Swampert,Metagross,Raichu,Sneasler').split(',').map(s => s.trim()).map(pick);
const GAMES = argNum('--games', 8), DEPTH = 14, BUDGET = 20000, SPL = 5;
const pct = (x: number) => `${Math.round(x * 100)}%`;

const pool = new PlayoutPool();
console.log(`pelipper-move-test · ${TEAM} · ${opps.length} opps × ${GAMES} deep games (b${BUDGET / 1000}s/spl${SPL})\n`);
const table: Record<string, Record<string, number>> = {};
for (const v of variants) {
  table[v.name] = {};
  for (const opp of opps) {
    // Bring must INCLUDE Pelipper or the variants are identical — force the
    // no-Garchomp Pelipper bring vs weather, else scoreBrings top Pelipper bring.
    let myBring: PokemonSet[];
    if (opp.anchor.toLowerCase().includes('ninetales')) {
      myBring = v.sets.filter(s => !['garchomp', 'talonflame'].includes(toId(s.species)));
    } else {
      const withPel = scoreBrings(v.sets, opp.sets.map(entryOf)).find(b => b.myIndices.some(i => toId(v.sets[i]!.species) === 'pelipper'))!;
      myBring = withPel.myIndices.map(i => v.sets[i]!);
    }
    const oppBring = scoreBrings(opp.sets, v.sets.map(entryOf))[0]!.myIndices.map(i => opp.sets[i]!);
    const r = await bringWinRate(pool, myBring, oppBring, GAMES, DEPTH, false, { budgetMs: BUDGET, breadth: { switchPlyLimit: SPL } });
    table[v.name]![opp.anchor] = r.winRate;
    console.log(`  ${v.name.padEnd(11)} vs ${opp.anchor.padEnd(26)} ${pct(r.winRate).padStart(4)} (${r.wins}/${GAMES})  bring: ${myBring.map(s => s.species).join('/')}`);
  }
}
pool.close();
console.log(`\n=== SUMMARY (sim = Wide Guard's BEST case; Protect >= WG here means Protect wins outright) ===`);
for (const opp of opps) {
  const wg = table['Wide Guard']![opp.anchor]!, pr = table['Protect']![opp.anchor]!;
  console.log(`  ${opp.anchor.padEnd(26)} WG ${pct(wg).padStart(4)} · Protect ${pct(pr).padStart(4)}  ${pr >= wg ? '→ Protect' : '→ WG by ' + Math.round((wg - pr) * 100) + 'pp'}`);
}
const wgAvg = opps.reduce((a, o) => a + table['Wide Guard']![o.anchor]!, 0) / opps.length;
const prAvg = opps.reduce((a, o) => a + table['Protect']![o.anchor]!, 0) / opps.length;
console.log(`\n  averages: Wide Guard ${pct(wgAvg)} · Protect ${pct(prAvg)}`);
console.log(`VERDICT-INPUT: ${prAvg >= wgAvg ? 'Protect >= WG even in WG-favorable sim → PROTECT.' : `WG leads by ${Math.round((wgAvg - prAvg) * 100)}pp in its best-case sim — weigh vs the user's real-play read.`}`);
process.exit(0);
