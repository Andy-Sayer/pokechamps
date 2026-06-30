// Cemented bring guide for the team — the in-game preview cheat-sheet. Reads a
// playout ground-truth file (from `bring-search ... --save`) and, per opponent,
// gives the worst-case-robust best 4-of-6 to bring + its win-rate, the runner-up
// margin, and flags: HARD (sub-50% — a genuine bad matchup no bring fixes) and
// CLOSE (top-2 within sampling noise). Sorted hardest-first (what to prepare for).
// Auto-finds the newest data/bring-truth*.json unless a file is given.
//   npx tsx packages/core/src/scripts/bring-guide.ts [truth.json]
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, CHAMPIONS_PIKA_FORMAT } from '../domain/data.js';

const dir = dataDirPath();
function resolveTruth(): string {
  const arg = process.argv[2];
  if (arg) return arg.includes('/') || arg.includes('\\') ? arg : join(dir, arg);
  // newest bring-truth*.json by mtime
  const cands = readdirSync(dir).filter(f => /^bring-truth.*\.json$/.test(f))
    .map(f => ({ f, m: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
  if (!cands.length) throw new Error('no data/bring-truth*.json found — run bring-search ... --save first');
  return join(dir, cands[0]!.f);
}
const truthPath = resolveTruth();
type Truth = { anchor: string; brings: { species: string[]; maximinWr: number }[] }[];
const truth = JSON.parse(readFileSync(truthPath, 'utf8')) as Truth;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const NOISE = 0.17; // ~1 game at 6 games/cell

interface Row { anchor: string; bring: string; wr: number; margin: number; flag: string }
const rows: Row[] = truth.map(t => {
  const sorted = t.brings.slice().sort((a, b) => b.maximinWr - a.maximinWr);
  const best = sorted[0]!;
  const runner = sorted.find(b => b.species.join() !== best.species.join());
  const margin = runner ? best.maximinWr - runner.maximinWr : 1;
  const flag = best.maximinWr < 0.5 ? 'HARD — no bring fixes it'
    : margin < NOISE ? 'close (margin within noise)' : 'confident';
  return { anchor: t.anchor, bring: best.species.join(' / '), wr: best.maximinWr, margin, flag };
}).sort((a, b) => a.wr - b.wr); // hardest first

const confident = rows.filter(r => r.flag === 'confident').length;
const hard = rows.filter(r => r.flag.startsWith('HARD')).length;
const md = [
  `# Bring guide — team anti-meta-mb`,
  `*Source: ${truthPath.split(/[\\/]/).pop()} · ${rows.length} opponents · ${confident} confident · ${hard} hard. Sorted hardest-first.*`,
  ``,
  `| Win% | vs Opponent | Bring (4 of 6) | Note |`,
  `|---:|---|---|---|`,
  ...rows.map(r => `| ${pct(r.wr)} | ${r.anchor} | ${r.bring} | ${r.flag} |`),
].join('\n');

console.log(md);
const outPath = join(dir, `bring-guide.${CHAMPIONS_PIKA_FORMAT}.md`);
writeFileSync(outPath, md + '\n', 'utf8');
console.log(`\nsaved → data/bring-guide.${CHAMPIONS_PIKA_FORMAT}.md`);
