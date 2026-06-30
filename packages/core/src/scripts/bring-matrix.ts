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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId, CHAMPIONS_PIKA_FORMAT } from '../domain/data.js';
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
const hand = MB_THREATS.map(m => ({ anchor: m.anchor, sets: m.sets }));
const meta = metaTeams(pika, 12, 4).map(m => ({ anchor: m.anchor, sets: m.sets }));
const allOpps = [...hand, ...meta];
const lower = OPP.toLowerCase();
let opponents: { anchor: string; sets: PokemonSet[] }[] = [];
if (lower === 'all') opponents = allOpps;
else if (lower === 'hand') opponents = hand;
else if (lower === 'meta') opponents = meta;
else {
  let o = allOpps.find(g => g.anchor.toLowerCase().includes(lower));
  if (!o && OPP.includes(',')) {
    const used = new Set<string>(); const sets: PokemonSet[] = [];
    for (const sp of OPP.split(',').map(s => s.trim())) { const s = buildSet(pika, sp, used); if (s) { sets.push(s); if (s.item) used.add(toId(s.item)); } }
    if (sets.length >= 4) o = { anchor: `custom (${OPP})`, sets };
  }
  if (!o) { console.error(`no opponent matching "${OPP}"`); process.exit(1); }
  opponents = [o];
}

const combos4 = (n: number): number[][] => { const o: number[][] = []; for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) o.push([a, b, c, d]); return o; };
const myBrings = combos4(myTeam.length).map(c => c.map(i => myTeam[i]!));
const label = (b: PokemonSet[]) => b.map(s => s.species).join('/');
const pct = (x: number) => `${Math.round(x * 100)}%`;
const slug = (s: string) => s.replace(/[^\w]+/g, '_');

const pool = new PlayoutPool();
const cellWr = async (mb: PokemonSet[], tb: PokemonSet[]): Promise<number> => {
  if (OPP_MODE === 'minimax') return (await bringWinRate(pool, mb, tb, GAMES, 2, false)).winRate;
  if (OPP_MODE === 'pilot') return (await bringWinRate(pool, mb, tb, GAMES, 2, true)).winRate;
  // 'worst': opponent plays its better mode → take the lower of our win-rates.
  const [a, b] = await Promise.all([bringWinRate(pool, mb, tb, GAMES, 2, true), bringWinRate(pool, mb, tb, GAMES, 2, false)]);
  return Math.min(a.winRate, b.winRate);
};

const matricesDir = join(dataDirPath(), 'matrices');
mkdirSync(matricesDir, { recursive: true });
const sheetPath = join(dataDirPath(), `bring-sheet-nash.${CHAMPIONS_PIKA_FORMAT}.md`);
interface Res { anchor: string; nash: number; maximin: number; maximinBring: string; optimistic: number; mix: { bring: string; p: number }[] }
const sheet: Res[] = [];
const single = opponents.length === 1;
const writeSheet = () => {
  const rows = sheet.slice().sort((a, b) => a.nash - b.nash); // hardest first
  const md = [
    `# Nash bring sheet — team ${TEAM} · opp model: ${OPP_MODE} · ${GAMES} games/cell`,
    `*Nash = true win-rate when neither side sees the other's bring. Sorted hardest-first. Bring the listed mix (vary across games).*`,
    ``, `| Nash | maximin | vs Opponent | Bring (Nash mix) |`, `|---:|---:|---|---|`,
    ...rows.map(r => `| ${pct(r.nash)} | ${pct(r.maximin)} | ${r.anchor} | ${r.mix.map(m => `${pct(m.p)} ${m.bring}`).join(' · ')} |`),
  ].join('\n');
  writeFileSync(sheetPath, md + '\n', 'utf8');
};

console.log(`4v4 Nash matrix · ${TEAM} · ${opponents.length} opponent(s) · ${myBrings.length} my-brings · ${GAMES} games/cell · opp=${OPP_MODE}\n`);
for (const opp of opponents) {
  const theirBrings = combos4(opp.sets.length).map(c => c.map(i => opp.sets[i]!));
  const cells = await Promise.all(myBrings.flatMap((mb, i) => theirBrings.map(async (tb, j) => ({ i, j, wr: await cellWr(mb, tb) }))));
  const M = myBrings.map(() => new Array(theirBrings.length).fill(0) as number[]);
  for (const c of cells) M[c.i]![c.j] = c.wr;
  const sol = solveMatrixGame(M);
  const optimistic = Math.max(...M.map(r => r[0]!));
  const mix = sol.nashRow.map((p, i) => ({ bring: label(myBrings[i]!), p })).filter(x => x.p > 0.03).sort((a, b) => b.p - a.p);
  sheet.push({ anchor: opp.anchor, nash: sol.value, maximin: sol.maximinValue, maximinBring: label(myBrings[sol.maximinRow]!), optimistic, mix });
  console.log(`${opp.anchor.padEnd(30)} Nash ${pct(sol.value).padStart(4)}  (maximin ${pct(sol.maximinValue)} ${label(myBrings[sol.maximinRow]!)}, opt ${pct(optimistic)})`);
  if (single) { console.log('Nash bring mix:'); mix.forEach(x => console.log(`  ${pct(x.p).padStart(4)}  ${x.bring}`)); }
  // Incremental: save the matrix (corpus) + the running sheet so a long run stays harvestable.
  writeFileSync(join(matricesDir, `${slug(opp.anchor)}.json`), JSON.stringify({ anchor: opp.anchor, myBrings: myBrings.map(label), theirBrings: theirBrings.map(label), M }) + '\n', 'utf8');
  writeSheet();
}
pool.close();
console.log(`\nsaved ${sheet.length} matrices → data/matrices/ · sheet → data/bring-sheet-nash.${CHAMPIONS_PIKA_FORMAT}.md`);
void SAVE;
