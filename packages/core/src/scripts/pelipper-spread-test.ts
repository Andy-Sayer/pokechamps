// Pelipper spread test — the user's speed-creep spread vs the max-SpA default,
// decided by real deep playouts (not judgment). Three variants:
//   default      Modest 252HP/252SpA/0Spe   (Spe 85  — max Weather Ball power)
//   user-modest  Modest 252HP/124SpA/140Spe (Spe 103 — outruns 0-Spe Pelipper/Sinistcha/Incineroar)
//   user-timid   Timid  252HP/124SpA/140Spe (Spe 113 — also outruns uninvested Archaludon)
// Matchups chosen where the tradeoff lives: rain mirrors (speed = whose weather/
// Tailwind fires last/first), Metagross (SpA breakpoint — the win line 2-shots it
// with Weather Ball), Ninetales (Pelipper-centric), Sneasler (guard).
//   npx tsx packages/core/src/scripts/pelipper-spread-test.ts [team.json]
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
const withPel = (nature: string, evs: PokemonSet['evs']): PokemonSet[] =>
  base.map(s => toId(s.species) === 'pelipper' ? { ...s, nature, evs } : s);
const variants = [
  { name: 'default 0Spe', sets: withPel('Modest', { hp: 252, atk: 0, def: 4, spa: 252, spd: 0, spe: 0 }) },
  { name: 'user Modest', sets: withPel('Modest', { hp: 252, atk: 0, def: 0, spa: 124, spd: 0, spe: 140 }) },
  { name: 'user Timid', sets: withPel('Timid', { hp: 252, atk: 0, def: 0, spa: 124, spd: 0, spe: 140 }) },
];

const pika = loadPikaData();
const allOpps = [...MB_THREATS.map(m => ({ anchor: m.anchor, sets: m.sets })), ...metaTeams(pika, 12, 4).map(m => ({ anchor: m.anchor, sets: m.sets }))];
const pick = (s: string) => allOpps.find(o => o.anchor.toLowerCase().includes(s.toLowerCase()))!;
const opps = ['Pelipper', 'Swampert', 'Metagross', 'Ninetales', 'Sneasler'].map(pick);
const GAMES = 8, DEPTH = 14, BUDGET = 20000, SPL = 5;
const pct = (x: number) => `${Math.round(x * 100)}%`;

const pool = new PlayoutPool();
console.log(`pelipper-spread-test · ${TEAM} · ${opps.length} opps × ${GAMES} deep games (b${BUDGET / 1000}s/spl${SPL})\n`);
const table: Record<string, Record<string, number>> = {};
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
    const oppBring = scoreBrings(opp.sets, v.sets.map(entryOf))[0]!.myIndices.map(i => opp.sets[i]!);
    const r = await bringWinRate(pool, myBring, oppBring, GAMES, DEPTH, false, { budgetMs: BUDGET, breadth: { switchPlyLimit: SPL } });
    table[v.name]![opp.anchor] = r.winRate;
    console.log(`  ${v.name.padEnd(13)} vs ${opp.anchor.padEnd(26)} ${pct(r.winRate).padStart(4)} (${r.wins}/${GAMES})`);
  }
}
pool.close();
console.log(`\n=== SUMMARY (per variant: each matchup · average) ===`);
for (const v of variants) {
  const cells = opps.map(o => `${o.anchor.split(' ')[0]!.slice(0, 9)} ${pct(table[v.name]![o.anchor]!)}`);
  const avg = opps.reduce((a, o) => a + table[v.name]![o.anchor]!, 0) / opps.length;
  console.log(`  ${v.name.padEnd(13)} ${cells.join(' · ')}  ·  AVG ${pct(avg)}`);
}
console.log(`\n(read: mirrors reward Speed, Metagross rewards SpA — highest average with no cratered cell wins)`);
process.exit(0);
