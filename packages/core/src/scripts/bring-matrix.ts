// 4v4 win-rate matrix generator + Nash bring solver. For one team-matchup, fills
// M[i][j] = MY win-rate when I bring i and they bring j, each cell a 4v4 played
// under MUTUAL MINIMAX (both sides use the search policy — pilotP2=false). This is
// the reusable "what works against what" data, decoupled from the bring choice.
// Then it solves the bring as a zero-sum matrix game:
//   - maximin = robust pure bring (PESSIMISTIC: assumes they perfectly counter you)
//   - Nash    = the TRUE value + optimal mix (neither sees the other's bring)
// The Nash sits between the optimistic (their likely bring) and pessimistic
// (maximin) bounds — the honest number. Saves M as the training corpus.
//   npx tsx packages/core/src/scripts/bring-matrix.ts [team.json] [opp] [--games N] [--save file]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId } from '../domain/data.js';
import { loadPikaData, metaTeams, buildSet } from '../domain/metaTeams.js';
import { PlayoutPool, bringWinRate } from '../domain/playoutPool.js';
import { maximin, solveMatrixGame } from '../domain/bringMatrixGame.js';
import { MB_THREATS } from './mbThreats.js';
import type { PokemonSet } from '../domain/types.js';

const argNum = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const argStr = (f: string, d: string) => { const i = process.argv.indexOf(f); return i >= 0 ? String(process.argv[i + 1]) : d; };
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const TEAM = positional[0]?.endsWith('.json') ? positional[0]! : 'anti-meta-mb.json';
const OPP = positional.find(a => !a.endsWith('.json')) ?? 'Blaziken';
const GAMES = argNum('--games', 6);
const SAVE = argStr('--save', '');
// Opponent model per 4v4 cell: 'minimax' (both search — too shallow vs setup teams,
// over-optimistic), 'pilot' (opponent forced to its game plan), or 'worst' (the
// opponent plays its BETTER mode = min win-rate for us — the realistic, conservative
// choice). Default 'worst'.
const OPP_MODE = argStr('--opp', 'worst');

const myTeam = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', TEAM), 'utf8')) as PokemonSet[];
const pika = loadPikaData();
// Resolve the opponent's 6 (anchor substring in hand/meta, or comma-separated species).
const all = [...MB_THREATS.map(m => ({ anchor: m.anchor, sets: m.sets })), ...metaTeams(pika, 12, 4).map(m => ({ anchor: m.anchor, sets: m.sets }))];
let opp = all.find(g => g.anchor.toLowerCase().includes(OPP.toLowerCase()));
if (!opp && OPP.includes(',')) {
  const used = new Set<string>(); const sets: PokemonSet[] = [];
  for (const sp of OPP.split(',').map(s => s.trim())) { const s = buildSet(pika, sp, used); if (s) { sets.push(s); if (s.item) used.add(toId(s.item)); } }
  if (sets.length >= 4) opp = { anchor: `custom (${OPP})`, sets };
}
if (!opp) { console.error(`no opponent matching "${OPP}"`); process.exit(1); }

const combos4 = (n: number): number[][] => { const o: number[][] = []; for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) o.push([a, b, c, d]); return o; };
const myBrings = combos4(myTeam.length).map(c => c.map(i => myTeam[i]!));
const theirBrings = combos4(opp.sets.length).map(c => c.map(i => opp!.sets[i]!));
const label = (b: PokemonSet[]) => b.map(s => s.species).join('/');
const pct = (x: number) => `${Math.round(x * 100)}%`;

const pool = new PlayoutPool();
console.log(`4v4 matrix · ${TEAM} vs [${opp.anchor}] · ${myBrings.length} my-brings × ${theirBrings.length} their-brings · ${GAMES} games/cell · opp=${OPP_MODE}\n`);
const cellWr = async (mb: PokemonSet[], tb: PokemonSet[]): Promise<number> => {
  if (OPP_MODE === 'minimax') return (await bringWinRate(pool, mb, tb, GAMES, 2, false)).winRate;
  if (OPP_MODE === 'pilot') return (await bringWinRate(pool, mb, tb, GAMES, 2, true)).winRate;
  // 'worst': opponent plays its better mode → take the lower of our win-rates.
  const [a, b] = await Promise.all([bringWinRate(pool, mb, tb, GAMES, 2, true), bringWinRate(pool, mb, tb, GAMES, 2, false)]);
  return Math.min(a.winRate, b.winRate);
};
const cells = await Promise.all(
  myBrings.flatMap((mb, i) => theirBrings.map(async (tb, j) => ({ i, j, wr: await cellWr(mb, tb) }))),
);
pool.close();
const M = myBrings.map(() => new Array(theirBrings.length).fill(0) as number[]);
for (const c of cells) M[c.i]![c.j] = c.wr;

const sol = solveMatrixGame(M);
// Optimistic bound: my best bring's win-rate vs their FIRST (most-likely-ordered) bring.
const optimistic = Math.max(...M.map(row => row[0]!));
console.log(`OPTIMISTIC (their default bring)      ${pct(optimistic)}`);
console.log(`PESSIMISTIC (maximin — they counter)  ${pct(sol.maximinValue)}   pure bring: ${label(myBrings[sol.maximinRow]!)}`);
console.log(`TRUE / NASH (neither sees the other)  ${pct(sol.value)}`);
console.log(`\nNash bring mix (bring these, weighted):`);
sol.nashRow.map((p, i) => ({ p, i })).filter(x => x.p > 0.03).sort((a, b) => b.p - a.p)
  .forEach(x => console.log(`  ${pct(x.p).padStart(4)}  ${label(myBrings[x.i]!)}`));
if (SAVE) {
  writeFileSync(join(dataDirPath(), SAVE), JSON.stringify({ anchor: opp.anchor, myBrings: myBrings.map(label), theirBrings: theirBrings.map(label), M }, null, 2) + '\n', 'utf8');
  console.log(`\nsaved matrix → data/${SAVE}`);
}
