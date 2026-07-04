// Scan a dir of VOD frames and flag the TEAM-PREVIEW ones by OCR'ing the centre
// "Select 4 Pokémon to send into battle." text (present ONLY on that screen). Copies
// the hits to <dir>/previews/ so bootstrap-refs can harvest them — removes the
// needle-in-haystack of finding previews by timestamp.
//   npx tsx packages/vision/scripts/find-previews.ts <frames-dir>
import { createWorker } from 'tesseract.js';
import { Jimp } from 'jimp';
import { readdirSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TEAM_PREVIEW_TEXT, toPixels } from '../src/regions.js';

const dir = process.argv[2];
if (!dir) { console.error('usage: find-previews <frames-dir>'); process.exit(1); }
const files = readdirSync(dir).filter(f => /\.png$/.test(f) && !f.startsWith('_')).sort();
const worker = existsSync(`${process.cwd()}/eng.traineddata`)
  ? await createWorker('eng', 1, { langPath: process.cwd(), cachePath: process.cwd(), gzip: false })
  : await createWorker('eng', 1, { cachePath: process.cwd() });
const outDir = join(dir, 'previews'); mkdirSync(outDir, { recursive: true });
const tmp = join(dir, '_pv.png');
// tolerant to OCR jitter (0/o, missing spaces)
const isPreview = (t: string) => /select\s*4|send\s*int[o0]\s*battle|t[o0]\s*send/i.test(t.replace(/\s+/g, ' '));

let hits = 0;
console.log(`scanning ${files.length} frames…`);
for (const f of files) {
  const img = await Jimp.read(join(dir, f));
  const r = toPixels(TEAM_PREVIEW_TEXT, img.bitmap.width, img.bitmap.height);
  const c = img.clone().crop(r);
  c.scan(0, 0, c.bitmap.width, c.bitmap.height, function (x, y, idx) {
    const mn = Math.min(this.bitmap.data[idx]!, this.bitmap.data[idx + 1]!, this.bitmap.data[idx + 2]!);
    const mx = Math.max(this.bitmap.data[idx]!, this.bitmap.data[idx + 1]!, this.bitmap.data[idx + 2]!);
    const o = mn > 170 && mx - mn < 50 ? 0 : 255;   // white text → black on white
    this.bitmap.data[idx] = this.bitmap.data[idx + 1] = this.bitmap.data[idx + 2] = o;
  });
  c.scale(2);
  await c.write(tmp as `${string}.png`);
  const { data } = await worker.recognize(tmp);
  const text = data.text.trim().replace(/\s+/g, ' ');
  if (isPreview(text)) { hits++; copyFileSync(join(dir, f), join(outDir, f)); console.log(`  ✓ ${f}  "${text.slice(0, 45)}"`); }
}
await worker.terminate();
console.log(`${hits} preview frame(s) → ${outDir}`);
process.exit(0);
