// Harvest sprite refs from EVERY archived opponent sheet that has ground truth,
// chronologically (newer captures win the per-species upsert), skipping dim frames
// (their darkened sprites would poison the colour-hist refs). Idempotent and cheap —
// run it routinely after play sessions so every manually-keyed opponent becomes a
// ref the reader recognizes next time:
//   npm run -w @pokechamps/vision harvest-all-sheets
// (Live confirms also harvest one-shot via Ctrl+D; this is the batch safety net.)
import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFrame } from '../src/decode.js';
import { harvestConfirmedRefs } from '../src/harvestRefs.js';
import { OPP_SHEETS_DIR, loadOppSheetGroundTruth, detectPanel, panelBrightnessRatio } from '../src/oppTeamRead.js';

// A `.harvested.json` marker beside each processed sheet keeps repeated runs (the
// TUI runs this at startup) near-instant as the archive grows. --force reprocesses.
const force = process.argv.includes('--force');
const sheets = readdirSync(OPP_SHEETS_DIR).filter(f => f.endsWith('.png')).sort();  // timestamped names → chronological
let total = 0;
for (const f of sheets) {
  const path = join(OPP_SHEETS_DIR, f);
  const marker = path.replace(/\.png$/, '.harvested.json');
  if (!force && existsSync(marker)) continue;
  const gt = loadOppSheetGroundTruth(path);
  if (!gt) { console.log(`—  ${f}: no ground truth — skipped`); continue; }   // no marker: truth may arrive later
  const frame = await loadFrame(path);
  const panel = detectPanel(frame);
  if (!panel.present) {
    console.log(`—  ${f}: no preview panel — skipped`);
    writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), skipped: 'no-panel' }));
    continue;
  }
  const ratio = panelBrightnessRatio(frame, panel.ins);
  if (ratio < 0.85) {
    console.log(`—  ${f}: DIM (ratio ${ratio.toFixed(2)}) — skipped, sprites would poison refs`);
    writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), skipped: 'dim', ratio }));
    continue;
  }
  const harvested = await harvestConfirmedRefs(path, gt.truth);
  total += harvested.length;
  writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), refs: harvested }));
  console.log(`✓  ${f} (${gt.source}): ${harvested.length ? harvested.join(', ') : 'nothing new'}`);
}
console.log(`\nTotal refs upserted: ${total}`);
