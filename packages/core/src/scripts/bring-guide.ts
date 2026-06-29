// Cemented bring guide for the team. Reads the playout ground truth
// (data/bring-truth.<fmt>.json from `bring-search ... --save`) and, per opponent,
// reports the SIM-best 4-of-6 to bring + its maximin win-rate, the runner-up
// (confidence margin), and flags: CLOSE (margin within sampling noise → cement
// with more games) or HARD (best wr < 50% → genuine coin-flip no bring fixes).
// Zero new compute. This is the in-game preview cheat-sheet.
//   npx tsx packages/core/src/scripts/bring-guide.ts [truth.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, CHAMPIONS_PIKA_FORMAT } from '../domain/data.js';

const TRUTH = process.argv[2] ?? `bring-truth.${CHAMPIONS_PIKA_FORMAT}.json`;
type Truth = { anchor: string; brings: { species: string[]; maximinWr: number }[] }[];
const truth = JSON.parse(readFileSync(join(dataDirPath(), TRUTH), 'utf8')) as Truth;

const pct = (x: number) => `${Math.round(x * 100)}%`;
// At 6 games/cell a 1-game swing is ~17%, so margins under ~0.17 aren't resolved.
const NOISE = 0.17;

const lines: string[] = [];
let confident = 0, close = 0, hard = 0;
for (const t of truth) {
  const sorted = t.brings.slice().sort((a, b) => b.maximinWr - a.maximinWr);
  const best = sorted[0]!;
  const runner = sorted.find(b => b.species.join() !== best.species.join());
  const margin = runner ? best.maximinWr - runner.maximinWr : 1;
  const flags: string[] = [];
  if (best.maximinWr < 0.5) { flags.push('HARD (coin-flip — no bring fixes it)'); hard++; }
  if (margin < NOISE) { flags.push(`CLOSE (margin ${pct(margin)} — cement w/ more games)`); close++; }
  if (!flags.length) confident++;
  lines.push(
    `vs ${t.anchor.padEnd(30)} BRING ${best.species.join('/').padEnd(46)} ${pct(best.maximinWr).padStart(4)}` +
    (runner ? `   (2nd: ${runner.species.join('/')} ${pct(runner.maximinWr)})` : '') +
    (flags.length ? `   ⚠ ${flags.join('; ')}` : '   ✓'),
  );
}

const header = `# Cemented bring guide — team anti-meta-mb (from ${TRUTH})\n` +
  `# ${truth.length} opponents · ${confident} confident · ${close} close (need more games) · ${hard} genuinely hard\n`;
console.log(header);
console.log(lines.join('\n'));
const outPath = join(dataDirPath(), `bring-guide.${CHAMPIONS_PIKA_FORMAT}.md`);
writeFileSync(outPath, header + '\n' + lines.join('\n') + '\n', 'utf8');
console.log(`\nsaved → data/bring-guide.${CHAMPIONS_PIKA_FORMAT}.md`);
