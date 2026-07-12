// Harvest sprite refs from a durably-archived opponent team-sheet
// (fixtures/opp-sheets/<ts>__*.png, written on Ctrl+R / auto-read in the opponent screen).
//
// Ground truth is resolved in this order:
//   1. <sheet>.truth.json  — the user's CORRECTED picks (Ctrl+D in the app). Authoritative.
//   2. <sheet>.json        — the raw read; only its type-VERIFIED slots are trusted.
// Each trusted slot's sprite is cropped and upserted as a <id>-live ref in data/sprite-refs.json
// (via the same harvestConfirmedRefs the live confirm uses), so it coexists with the curated refs.
//
//   npm run -w @pokechamps/vision harvest-sheet -- <sheet.png>   # a specific archived sheet
//   npm run -w @pokechamps/vision harvest-sheet                  # newest sheet in fixtures/opp-sheets/
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute, basename } from 'node:path';
import { harvestConfirmedRefs } from '../src/harvestRefs.js';
import { OPP_SHEETS_DIR, loadOppSheetGroundTruth } from '../src/oppTeamRead.js';

function newestSheet(): string | null {
  if (!existsSync(OPP_SHEETS_DIR)) return null;
  const pngs = readdirSync(OPP_SHEETS_DIR).filter(f => f.toLowerCase().endsWith('.png')).map(f => join(OPP_SHEETS_DIR, f));
  if (!pngs.length) return null;
  return pngs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!;
}

/** Resolve the sheet arg tolerantly. npm runs the script with cwd=packages/vision, so a
 *  repo-root-relative path won't match; since every archived sheet lives in OPP_SHEETS_DIR,
 *  fall back to matching by basename there. */
function resolveSheet(arg: string): string | null {
  const candidates = [
    isAbsolute(arg) ? arg : resolve(process.cwd(), arg),
    join(OPP_SHEETS_DIR, basename(arg)),
  ];
  return candidates.find(existsSync) ?? null;
}

async function main() {
  const arg = process.argv[2];
  const sheet = arg ? resolveSheet(arg) : newestSheet();
  if (!sheet || !existsSync(sheet)) {
    console.error(`No sheet to harvest. Pass a path, or capture one first (Ctrl+R on the opponent screen).\nLooked in: ${OPP_SHEETS_DIR}`);
    process.exit(1);
  }

  const gt = loadOppSheetGroundTruth(sheet);
  if (!gt) {
    console.error(`No ground truth beside ${sheet}\n(neither a .truth.json nor a .json sidecar). Confirm the sheet in the app (Ctrl+D) to record it.`);
    process.exit(1);
  }
  if (gt.source === 'read-verified')
    console.warn('⚠ using the RAW read (verified slots only) — no corrections saved for this sheet. Confirm it in the app (Ctrl+D) for authoritative labels.');

  console.log(`Sheet:        ${sheet}`);
  console.log(`Ground truth: (${gt.source}) ${gt.truth.map((n, i) => `${i + 1}:${n ?? '—'}`).join('  ')}`);

  const harvested = await harvestConfirmedRefs(sheet, gt.truth);
  if (!harvested.length) console.log('Nothing harvested — not a preview frame, or no trusted slots to learn from.');
  else console.log(`✓ Harvested ${harvested.length} ref(s): ${harvested.join(', ')}  →  data/sprite-refs.json`);
}

void main();
