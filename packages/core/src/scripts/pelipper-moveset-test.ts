// Pelipper move-set test — answers BOTH the Wide-Guard-vs-Protect question and the
// user's "drop Tailwind, let Talonflame carry it, run both protective moves" idea,
// in one run. Three configs for Pelipper's 4 moves:
//   A  Hurricane/Weather Ball/Tailwind/Wide Guard   (current)
//   B  Hurricane/Weather Ball/Tailwind/Protect
//   C  Hurricane/Weather Ball/Wide Guard/Protect     (NO Tailwind — user's idea)
// A-vs-B = WG vs Protect (both keep Tailwind); C = the no-Tailwind both-moves idea.
//
// THE CRITICAL CELLS: many strong brings are Talonflame-LESS (Ninetales, Metagross,
// Mawile = Pelipper/Kingambit/Dragonite/Meowscarada), so Pelipper is the ONLY
// Tailwind there — config C loses Tailwind entirely in those. Swampert/Raichu often
// bring Talonflame, so C keeps Tailwind via Talonflame. If C holds up on the
// Talonflame-less cells, the idea works (frees a slot). If C craters there,
// Pelipper's Tailwind is load-bearing and stays.
//   npx tsx packages/core/src/scripts/pelipper-moveset-test.ts [team.json] [--games N]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { MB_THREATS } from './mbThreats.js';
import { PlayoutPool, bringWinRate } from '../domain/playoutPool.js';
import type { PokemonSet } from '../domain/types.js';

const TEAM = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) ?? 'rain-mb-final.json';
const argNum = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const base = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', TEAM), 'utf8')) as PokemonSet[];
const withMoves = (moves: string[]): PokemonSet[] => base.map(s => toId(s.species) === 'pelipper' ? { ...s, moves } : s);
const OFF = ['Hurricane', 'Weather Ball'];
const variants = [
  { name: 'A Tailwind+WG', sets: withMoves([...OFF, 'Tailwind', 'Wide Guard']) },
  { name: 'B Tailwind+Protect', sets: withMoves([...OFF, 'Tailwind', 'Protect']) },
  { name: 'C WG+Protect noTW', sets: withMoves([...OFF, 'Wide Guard', 'Protect']) },
];

const pika = loadPikaData();
const allOpps = [...MB_THREATS.map(m => ({ anchor: m.anchor, sets: m.sets })), ...metaTeams(pika, 12, 4).map(m => ({ anchor: m.anchor, sets: m.sets }))];
const pick = (s: string) => allOpps.find(o => o.anchor.toLowerCase().includes(s.toLowerCase()))!;
// Talonflame-less Pelipper brings (Ninetales/Metagross/Mawile) = where dropping
// Pelipper's Tailwind bites; Swampert/Raichu = Talonflame usually present.
const opps = ['Ninetales', 'Metagross', 'Mawile', 'Swampert', 'Raichu'].map(pick);
const GAMES = argNum('--games', 12), DEPTH = 14, BUDGET = 20000, SPL = 5;
const pct = (x: number) => `${Math.round(x * 100)}%`;

const pool = new PlayoutPool();
console.log(`pelipper-moveset-test · ${TEAM} · ${opps.length} opps × ${GAMES} deep games (b${BUDGET / 1000}s/spl${SPL})\n`);
const table: Record<string, Record<string, { wr: number; tf: boolean }>> = {};
for (const v of variants) {
  table[v.name] = {};
  for (const opp of opps) {
    let myBring: PokemonSet[];
    if (opp.anchor.toLowerCase().includes('ninetales')) {
      myBring = v.sets.filter(s => !['garchomp', 'talonflame'].includes(toId(s.species)));
    } else {
      const b = scoreBrings(v.sets, opp.sets.map(entryOf)).find(x => x.myIndices.some(i => toId(v.sets[i]!.species) === 'pelipper'))!;
      myBring = b.myIndices.map(i => v.sets[i]!);
    }
    const hasTalon = myBring.some(s => toId(s.species) === 'talonflame');
    const oppBring = scoreBrings(opp.sets, v.sets.map(entryOf))[0]!.myIndices.map(i => opp.sets[i]!);
    const r = await bringWinRate(pool, myBring, oppBring, GAMES, DEPTH, false, { budgetMs: BUDGET, breadth: { switchPlyLimit: SPL } });
    table[v.name]![opp.anchor] = { wr: r.winRate, tf: hasTalon };
    console.log(`  ${v.name.padEnd(20)} vs ${opp.anchor.padEnd(26)} ${pct(r.winRate).padStart(4)} (${r.wins}/${GAMES})  ${hasTalon ? '[Talon in bring]' : '[NO Talon — Pelipper=only TW]'}`);
  }
}
pool.close();
console.log(`\n=== SUMMARY (★ = Talonflame-less bring: the cells where C loses Tailwind entirely) ===`);
for (const v of variants) {
  const cells = opps.map(o => `${o.anchor.split(' ')[0]!.slice(0, 8)}${table[v.name]![o.anchor]!.tf ? '' : '★'} ${pct(table[v.name]![o.anchor]!.wr)}`);
  const avg = opps.reduce((a, o) => a + table[v.name]![o.anchor]!.wr, 0) / opps.length;
  console.log(`  ${v.name.padEnd(20)} ${cells.join(' · ')}  ·  AVG ${pct(avg)}`);
}
// Focused read: on the Talonflame-less cells, does dropping Tailwind (C) hurt vs keeping it (A/B)?
const tlessOpps = opps.filter(o => !table['C WG+Protect noTW']![o.anchor]!.tf);
const avgOn = (name: string, set: typeof opps) => set.reduce((a, o) => a + table[name]![o.anchor]!.wr, 0) / set.length;
if (tlessOpps.length) {
  console.log(`\nTalonflame-less cells (${tlessOpps.map(o => o.anchor.split(' ')[0]).join(', ')}):`);
  console.log(`  keep-Tailwind best (A/B): ${pct(Math.max(avgOn('A Tailwind+WG', tlessOpps), avgOn('B Tailwind+Protect', tlessOpps)))} · drop-Tailwind (C): ${pct(avgOn('C WG+Protect noTW', tlessOpps))}`);
  console.log(`  → ${avgOn('C WG+Protect noTW', tlessOpps) >= Math.max(avgOn('A Tailwind+WG', tlessOpps), avgOn('B Tailwind+Protect', tlessOpps)) - 0.05 ? 'C holds — Pelipper Tailwind is NOT load-bearing; drop it, run both protective moves.' : 'C drops off — Pelipper Tailwind IS load-bearing in Talon-less brings; keep it.'}`);
}
process.exit(0);
