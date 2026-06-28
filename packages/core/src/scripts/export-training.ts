// Task-A dataset exporter: walk the cached replay corpus → bring/outcome rows →
// JSONL under data/training/. Reports the USABLE count (full team + known
// outcome), which is what bring-selection training actually needs. The first
// build increment of training-data-plan.md (types → EXPORTER → model+eval → wiring).
//   npx tsx packages/core/src/scripts/export-training.ts
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReplayLog } from '../domain/showdownReplay.js';
import { bringOutcomeRows, type BringOutcomeRow } from '../domain/trainingData.js';
import { dataDirPath } from '../domain/data.js';

const here = dirname(fileURLToPath(import.meta.url));
const replayDir = join(here, '..', '..', 'tests', 'replays');
const outDir = join(dataDirPath(), 'training');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'bring-outcomes.jsonl');

const rows: BringOutcomeRow[] = [];
let games = 0;
for (const f of readdirSync(replayDir).filter(n => n.endsWith('.log'))) {
  try {
    rows.push(...bringOutcomeRows(parseReplayLog(readFileSync(join(replayDir, f), 'utf8')), f.replace('.log', '')));
    games++;
  } catch (e) { console.error(`  skip ${f}: ${(e as Error).message}`); }
}
writeFileSync(outPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

const full6 = rows.filter(r => r.fullTeam).length;
const outcome = rows.filter(r => r.won != null).length;
const usable = rows.filter(r => r.fullTeam && r.bring.length === 4 && r.won != null);
const byFmt = new Map<string, number>();
for (const r of rows) byFmt.set(r.format ?? '?', (byFmt.get(r.format ?? '?') ?? 0) + 1);

console.log(`${games} games → ${rows.length} rows → ${outPath}`);
console.log(`  full 6-mon team (OTS): ${full6}/${rows.length}  ·  known outcome: ${outcome}/${rows.length}`);
console.log(`  USABLE for bring-selection (full 6 + bring of 4 + outcome): ${usable.length}`);
console.log(`by format: ${[...byFmt].map(([k, v]) => `${k}:${v}`).join('  ')}`);
console.log(`bring sizes seen: ${[...new Set(rows.map(r => r.bring.length))].sort((a, b) => a - b).join(',')}  ·  team sizes: ${[...new Set(rows.map(r => r.team.length))].sort((a, b) => a - b).join(',')}`);
