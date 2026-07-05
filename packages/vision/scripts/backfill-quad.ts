// One-off: compute the 2×2 quadrant (spatial) histogram for every ref that has a saved
// source crop, and write it into data/sprite-refs.json. Gives the matcher its palette-
// collision tie-break (Sneasler↔Kingambit) without re-harvesting. Crops don't record
// which side they came from, so mask BOTH panel colours (opp magenta + player blue) — a
// creature contains neither, so the result is creature-only either way, matching how a
// live query (masking just its own side) reduces to creature-only too.
//   npx tsx packages/vision/scripts/backfill-quad.ts
import { Jimp } from 'jimp';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '@pokechamps/core/domain/data.js';
import { quadrantHistogram, type ColorHistRef } from '../src/colorHist.js';
import { CHAMPIONS_OPP_PANEL_BG, CHAMPIONS_PLAYER_CARD_BG } from '../src/regions.js';

const BINS = 4;
const out = join(dataDirPath(), 'sprite-refs.json');
const json = JSON.parse(readFileSync(out, 'utf8')) as { bins?: number; refs: (ColorHistRef & { quad?: number[] })[] };
const cropDir = join(dataDirPath(), 'sprite-ref-crops');
const opts = { bins: BINS, bgColor: CHAMPIONS_OPP_PANEL_BG, bgColor2: CHAMPIONS_PLAYER_CARD_BG };

let done = 0, missing = 0;
for (const r of json.refs) {
  const p = join(cropDir, `${r.id}.png`);
  if (!existsSync(p)) { missing++; continue; }
  const img = await Jimp.read(p);
  r.quad = quadrantHistogram(new Uint8ClampedArray(img.bitmap.data), img.bitmap.width, img.bitmap.height, opts).map((v) => +v.toFixed(5));
  done++;
}
writeFileSync(out, JSON.stringify(json) + '\n');
console.log(`quad backfilled: ${done} refs · ${missing} without crop (no quad)`);
