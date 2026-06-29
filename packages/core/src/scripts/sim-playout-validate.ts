// STEP 0 — the anti-waste gate. Does playing the matchup OUT rank my brings
// differently (and more credibly) than the static opening-search score we already
// compute? If the win-rate order tracks the static-score order, the expensive
// playouts add nothing → keep the fast static score. If a static-LOW bring wins
// more games, the static score is missing something → build the parallel evaluator.
//   npx tsx packages/core/src/scripts/sim-playout-validate.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { searchIterative, type SearchInput } from '../domain/endgameSearch.js';
import { NEUTRAL_FIELD } from '../domain/types.js';
import { playGame, makeSearchPolicy } from '../domain/simPlayout.js';
import type { PokemonSet } from '../domain/types.js';

const OPPONENTS = 3, GAMES = 12, DEPTH = 2;
const team = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'anti-meta-mb.json'), 'utf8')) as PokemonSet[];
const pika = loadPikaData();
const opponents = metaTeams(pika, OPPONENTS, 3);
console.log(`my team: ${team.map(t => t.species).join(', ')}`);
console.log(`gate: static opening-search rank vs played-out win-rate · ${GAMES} paired-seed games/bring · depth ${DEPTH}\n`);

// all C(6,4)=15 brings
const combos: number[][] = [];
for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) for (let c = b + 1; c < 6; c++) for (let d = c + 1; d < 6; d++) combos.push([a, b, c, d]);
const seeds: [number, number, number, number][] = Array.from({ length: GAMES }, (_, k) => [k + 1, 2 * k + 5, 3 * k + 7, 5 * k + 11]);

const summary: string[] = [];
for (const opp of opponents) {
  const oppEntries = opp.sets.map(entryOf);
  const myEntries = team.map(entryOf);
  const oppBringIdx = scoreBrings(opp.sets, myEntries)[0]!.myIndices;          // opp's heuristic-best bring (fixed reference)
  const oppBring = oppBringIdx.map(i => opp.sets[i]!);

  // STATIC: maximin opening-search score of each of my 15 brings vs opp's bring.
  const staticScored = combos.map(combo => {
    const input: SearchInput = {
      mine: combo.map((idx, k) => ({ set: team[idx]!, hpPercent: 100, active: k < 2 })),
      opp: oppBringIdx.map((j, k) => ({ entry: oppEntries[j]!, hpPercent: 100, active: k < 2 })),
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    };
    return { combo, score: searchIterative(input, DEPTH).score };
  }).sort((a, b) => b.score - a.score);

  // Play out a spread of static ranks: #1, #2, the middle, and the worst.
  const pickRanks = [0, 1, Math.floor(combos.length / 2), combos.length - 1];
  console.log(`=== vs ${opp.anchor} ===  opp brings ${oppBring.map(s => s.species).join('/')}`);
  console.log(`  staticRank  bring                                   score    win-rate`);
  const winByRank: { rank: number; wr: number }[] = [];
  for (const r of pickRanks) {
    const { combo, score } = staticScored[r]!;
    const myBring = combo.map(i => team[i]!);
    const policy = makeSearchPolicy(myBring, oppBring, DEPTH);
    let w = 0, t = 0;
    for (const seed of seeds) {
      const res = await playGame(myBring, oppBring, { seed, policy });
      if ('error' in res) { console.error(res.error); process.exit(1); }
      if (res.winner === 'p1') w++; else if (res.winner === 'tie') t++;
    }
    const wr = Math.round(100 * w / GAMES);
    winByRank.push({ rank: r + 1, wr });
    console.log(`  #${String(r + 1).padEnd(9)} ${myBring.map(s => s.species).join('/').padEnd(38)} ${score.toFixed(0).padStart(6)}   ${wr}% (${w}W/${GAMES - w - t}L/${t}T)`);
  }
  // Gate signal: is the static order monotone with win-rate? (does static #1 win most?)
  const top = winByRank[0]!.wr, best = Math.max(...winByRank.map(x => x.wr));
  const agree = top >= best - 1;
  summary.push(`${opp.anchor}: static#1 ${top}% vs best-played ${best}% → ${agree ? 'AGREE (static fine)' : 'DIVERGE (playout matters)'}`);
  console.log();
}
console.log('=== GATE ===');
for (const s of summary) console.log('  ' + s);
