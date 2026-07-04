// 4v4 win-rate matrix generator + Nash bring solver. For one team-matchup, fills
// M[i][j] = MY win-rate when I bring i and they bring j, each cell a 4v4 played
// under MUTUAL MINIMAX (both sides use the search policy — pilotP2=false). This is
// the reusable "what works against what" data, decoupled from the bring choice.
// Then it solves the bring as a zero-sum matrix game:
//   - maximin = robust pure bring (PESSIMISTIC: assumes they perfectly counter you)
//   - Nash    = the TRUE value + optimal mix (neither sees the other's bring)
// The Nash sits between the optimistic (their likely bring) and pessimistic
// (maximin) bounds — the honest number. Saves M as the training corpus.
//
//   npm run bring-matrix -- <team.json> <opp> [--games N] [--opp worst|minimax|pilot]
//
// <opp> — WHAT to fight (the gauntlet). One of:
//   all   — hand-built threats (mbThreats.ts) + grounded real teams (groundedTeams)
//   hand  — just the hand-built MB_THREATS archetypes (anti-meta coverage)
//   meta  — real top teams reconstructed from Pikalytics featured teams (records-weighted)
//   <anchor>       — a single opponent by name substring, e.g. "Metagross"
//   Sp1,Sp2,...    — a custom opponent 6, built on the fly from real usage sets
// Each opponent is a full 6; the matrix pits my 15 brings against their 15.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId, CHAMPIONS_PIKA_FORMAT } from '../domain/data.js';
import { loadPikaData, groundedTeams, buildSet } from '../domain/metaTeams.js';
import { PlayoutPool, cachedBringWinRate } from '../domain/playoutPool.js';
import { maximin, solveMatrixGame } from '../domain/bringMatrixGame.js';
import { CellCache } from '../domain/cellCache.js';
import { MB_THREATS } from './mbThreats.js';
import type { PokemonSet } from '../domain/types.js';

const argNum = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const argStr = (f: string, d: string) => { const i = process.argv.indexOf(f); return i >= 0 ? String(process.argv[i + 1]) : d; };
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const TEAM = positional[0]?.endsWith('.json') ? positional[0]! : 'anti-meta-mb.json';
const OPP = positional.find(a => !a.endsWith('.json')) ?? 'Blaziken';
const GAMES = argNum('--games', 6);
const SAVE = argStr('--save', '');
// Search settings per cell (defaults preserve the depth-2, no-budget policy that
// produced the existing sheets/cache). --budget caps each decision (bounded,
// hang-proof unattended runs); --spl widens the switch window; --depth raises the
// max search depth. Non-defaults are folded into the cache key so they don't
// collide with the depth-2 corpus.
const DEPTH = argNum('--depth', 2);
const BUDGET = argNum('--budget', 0);              // 0 = no cap (existing behaviour)
const SPL = argNum('--spl', -1);                   // -1 = default switchPlyLimit
const SEARCH_OPTS = { budgetMs: BUDGET || undefined, breadth: SPL >= 0 ? { switchPlyLimit: SPL } : undefined };
// Opponent model per 4v4 cell: 'minimax' (both search — too shallow vs setup teams,
// over-optimistic), 'pilot' (opponent forced to its game plan), or 'worst' (the
// opponent plays its BETTER mode = min win-rate for us — the realistic, conservative
// choice). Default 'worst'.
const OPP_MODE = argStr('--opp', 'worst');

const myTeam = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', TEAM), 'utf8')) as PokemonSet[];
const pika = loadPikaData();
const hand = MB_THREATS.map(m => ({ anchor: m.anchor, sets: m.sets }));
// GROUNDED: real top teams reconstructed from Pikalytics featured teams (records-
// weighted, coherent), not usage-rank filler. minCore=4 keeps ≥4 real mons per team.
const meta = groundedTeams(pika, { minCore: 4 }).map(m => ({ anchor: m.anchor, sets: m.sets }));
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
// Mon-keyed cell cache (shared with bringEval/bring-search): each piloted/minimax
// 4v4 is cached by the 8 mon sets, so 'worst' reuses both sub-results and evolution
// reuses every bring not touching a changed mon.
const cache = new CellCache(CHAMPIONS_PIKA_FORMAT);
const cellWr = async (mb: PokemonSet[], tb: PokemonSet[]): Promise<number> => {
  if (OPP_MODE === 'minimax') return cachedBringWinRate(cache, pool, mb, tb, GAMES, DEPTH, false, SEARCH_OPTS);
  if (OPP_MODE === 'pilot') return cachedBringWinRate(cache, pool, mb, tb, GAMES, DEPTH, true, SEARCH_OPTS);
  // 'worst': opponent plays its better mode → take the lower of our win-rates.
  const [a, b] = await Promise.all([cachedBringWinRate(cache, pool, mb, tb, GAMES, DEPTH, true, SEARCH_OPTS), cachedBringWinRate(cache, pool, mb, tb, GAMES, DEPTH, false, SEARCH_OPTS)]);
  return Math.min(a, b);
};

// Namespace by MY team — matrices are (my-team × opponent), not opponent-only,
// so different teams vs the same opponent must NOT collide/overwrite. This keeps
// every team's 4v4 corpus distinct for cross-team comparison + the bring solve.
const teamSlug = TEAM.replace(/\.json$/, '');
const matricesDir = join(dataDirPath(), 'matrices', teamSlug);
mkdirSync(matricesDir, { recursive: true });
const sheetPath = join(dataDirPath(), `bring-sheet-nash.${teamSlug}.${CHAMPIONS_PIKA_FORMAT}.md`);
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

console.log(`4v4 Nash matrix · ${TEAM} · ${opponents.length} opponent(s) · ${myBrings.length} my-brings · ${GAMES} games/cell · opp=${OPP_MODE}`);
console.log(`going against: ${opponents.map(o => o.anchor).join(', ')}\n`);
for (const opp of opponents) {
  const theirBrings = combos4(opp.sets.length).map(c => c.map(i => opp.sets[i]!));
  // Heartbeat: an opponent is one big Promise.all over all cells, so without this
  // a healthy run is silent for ~15 min — indistinguishable from a hang. Logging
  // every few cells makes silence itself the stall signal (see the pool deadlock
  // that burned 11h producing nothing).
  const total = myBrings.length * theirBrings.length;
  let done = 0; const t0 = Date.now();
  const cells = await Promise.all(myBrings.flatMap((mb, i) => theirBrings.map(async (tb, j) => {
    const wr = await cellWr(mb, tb);
    if (++done % 15 === 0 || done === total) {
      const rate = done / ((Date.now() - t0) / 1000);
      console.log(`  [${opp.anchor}] ${done}/${total} cells · ${rate.toFixed(2)} cells/s · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    return { i, j, wr };
  })));
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
  cache.save(); // persist the mon-keyed cache incrementally so a long run is harvestable
}
pool.close();
const cs = cache.stats();
console.log(`cell-cache: ${cs.hits} hits / ${cs.misses} misses · ${cs.size} cells stored → data/cell-cache.${CHAMPIONS_PIKA_FORMAT}.json`);
console.log(`\nsaved ${sheet.length} matrices → data/matrices/${teamSlug}/ · sheet → data/bring-sheet-nash.${teamSlug}.${CHAMPIONS_PIKA_FORMAT}.md`);
void SAVE;
