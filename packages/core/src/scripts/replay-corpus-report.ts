/**
 * replay-corpus-report.ts — J.5 pass-rate metric over the cached replay corpus.
 *
 * Runs every fixture under `tests/replays/` through parse → ingest → J.2/J.3
 * and prints per-game + aggregate stats. The CI gate lives in the corpus smoke
 * test (any legality flag or J.3 `out` fails `npm test`); this report is the
 * human-readable trend view — run it after growing the corpus.
 *
 * Run: `npx tsx packages/core/src/scripts/replay-corpus-report.ts [--verbose]`
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReplayLog } from '../domain/showdownReplay.js';
import { ingestTranscript } from '../domain/replayDriver.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'replays');
const verbose = process.argv.includes('--verbose');
const files = readdirSync(dir).filter(f => f.endsWith('.log')).sort();

let games = 0, crashed = 0, turns = 0, flags = 0;
let dIn = 0, dOut = 0, dSkip = 0;
const skipReasons = new Map<string, number>();
const outLines: string[] = [];
const flagLines: string[] = [];

for (const file of files) {
  games += 1;
  let line: string;
  try {
    const t = parseReplayLog(readFileSync(join(dir, file), 'utf8'));
    const r = ingestTranscript(t);
    turns += r.match.turns.length;
    flags += r.flags.length;
    const c = { in: 0, out: 0, skipped: 0 };
    for (const d of r.damage) {
      c[d.verdict] += 1;
      if (d.verdict === 'skipped') skipReasons.set(d.note ?? '?', (skipReasons.get(d.note ?? '?') ?? 0) + 1);
      if (d.verdict === 'out') outLines.push(`${file} t${d.turn}: ${d.attacker} ${d.move} → ${d.defender} obs ${d.observedPct.toFixed(0)}% env ${d.minPct.toFixed(0)}–${d.maxPct.toFixed(0)}%`);
    }
    for (const f of r.flags) flagLines.push(`${file} t${f.turn}: [${f.kind}] ${f.who} — ${f.detail}`);
    dIn += c.in; dOut += c.out; dSkip += c.skipped;
    line = `${r.match.turns.length} turns · flags ${r.flags.length} · dmg ${c.in}/${c.out}/${c.skipped} (in/out/skip)`;
  } catch (e) {
    crashed += 1;
    line = `CRASH: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (verbose || /CRASH/.test(line)) console.log(`${file}: ${line}`);
}

const total = dIn + dOut + dSkip;
console.log('\n=== Replay corpus (J.5) ===');
console.log(`games: ${games} (${crashed} crashed) · turns driven: ${turns}`);
console.log(`legality flags: ${flags}`);
console.log(`damage checks: ${total} — in ${dIn} (${total ? Math.round(dIn / total * 100) : 0}%) · OUT ${dOut} · skipped ${dSkip}`);
if (skipReasons.size) {
  console.log('skip reasons:');
  for (const [why, n] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${why}`);
}
if (flagLines.length) {
  console.log('flags:');
  for (const l of flagLines) console.log(`  ${l}`);
}
if (outLines.length) {
  console.log('OUT events (model gaps — triage these):');
  for (const l of outLines) console.log(`  ${l}`);
}
process.exitCode = crashed || dOut || flags ? 1 : 0;
