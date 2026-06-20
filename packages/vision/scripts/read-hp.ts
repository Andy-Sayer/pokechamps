// Test harness for the per-slot HP-number OCR (the damage signal the inference solver
// back-solves spreads from). Exercises the real src path: opponent PERCENT via
// hpRead.readOpponentHpPercents (oppHpText boxes), and my ABSOLUTE "cur/max" via the
// myHpText boxes + the same white-digit isolation. Validates the boxes + OCR on real
// footage (e.g. a YouTube VOD) — banner OCR is read-battle.ts; this is the HP half.
//
//   npx tsx packages/vision/scripts/read-hp.ts <framesDir> [--every N]
//
// Prints a per-frame readout, deduped on consecutive-identical lines so stable values
// stand out from HUD-animation jitter (reads aren't settle-gated here — that's live).

import { Jimp } from 'jimp';
import { createWorker } from 'tesseract.js';
import { readdirSync, existsSync } from 'node:fs';
import { CHAMPIONS_DOUBLES_PLACEHOLDER, toPixels } from '../src/regions.js';
import { readOpponentHpPercents, binarizeWhiteDigits, type DigitOcr } from '../src/hpRead.js';
import type { Frame, Rect } from '../src/types.js';

const dir = process.argv[2] ?? 'packages/vision/fixtures/seq';
const everyIdx = process.argv.indexOf('--every');
const every = Math.max(1, everyIdx >= 0 ? Number(process.argv[everyIdx + 1]) : 1);
const files = readdirSync(dir).filter(f => /\.(png|jpg)$/i.test(f)).sort();
if (!files.length) { console.error(`no frames in ${dir}`); process.exit(1); }

const region = CHAMPIONS_DOUBLES_PLACEHOLDER;
const worker = await createWorker('eng', 1, existsSync(`${process.cwd()}/eng.traineddata`)
  ? { langPath: process.cwd(), cachePath: process.cwd(), gzip: false }
  : { cachePath: process.cwd() });
// Whitelist: digits + "%" (opp) and "/" (my cur/max). Keeping "%" in matters — else
// tesseract reads the italic "%" glyph AS a digit (11% -> "100"/"172"). PSM is toggled
// per box type in the loop: opp percents read best as a single WORD (psm 8, the slanted
// "11"); my "cur/max" needs single LINE (psm 7) or the "/" is dropped/misread as a digit.
await worker.setParameters({ tessedit_char_whitelist: '0123456789/%' });
const PSM_WORD = '8' as never, PSM_LINE = '7' as never;

const tmp = `${dir}/_hp.png`;
// Injected OCR: an already-binarized RGBA crop (black digits on white) -> PNG -> text.
// An 8px white border is the key: tesseract mis-segments short digit strings that touch
// the crop edge (the o2 11% -> 100 misread); the quiet-zone fixes it. parseHpNumber then
// strips the "%"/"/".
const ocrDigits: DigitOcr = async (pixels, w, h) => {
  if (!w || !h) return '';
  const m = 8;
  const img = new Jimp({ width: w + 2 * m, height: h + 2 * m, color: 0xffffffff });
  const crop = new Jimp({ width: w, height: h });
  crop.bitmap.data.set(pixels);
  img.composite(crop, m, m);
  img.scale(3);
  await img.write(tmp as `${string}.png`);
  const { data } = await worker.recognize(tmp);
  return data.text.replace(/\s+/g, '');
};

// My-side box: crop -> same white-digit isolation -> OCR the raw string (keep "/").
async function readMyBox(img: InstanceType<typeof Jimp>, r: Rect): Promise<string> {
  const { x, y, w, h } = toPixels(r, img.bitmap.width, img.bitmap.height);
  const c = img.clone().crop({ x, y, w, h });
  const bin = binarizeWhiteDigits(new Uint8ClampedArray(c.bitmap.data), c.bitmap.width, c.bitmap.height);
  return ocrDigits(bin, c.bitmap.width, c.bitmap.height);
}

let last = '', shown = 0;
console.log(`=== HP-NUMBER OCR (${files.length} frames, every ${every}) ===`);
for (let i = 0; i < files.length; i += every) {
  const img = await Jimp.read(`${dir}/${files[i]}`);
  const frame: Frame = { data: new Uint8ClampedArray(img.bitmap.data), width: img.bitmap.width, height: img.bitmap.height };
  await worker.setParameters({ tessedit_pageseg_mode: PSM_WORD });
  const opp = await readOpponentHpPercents(frame, ocrDigits, region);
  await worker.setParameters({ tessedit_pageseg_mode: PSM_LINE });
  const m1 = region.myHpText ? await readMyBox(img, region.myHpText[0]) : '';
  const m2 = region.myHpText ? await readMyBox(img, region.myHpText[1]) : '';
  const line = `o1=${opp.o1 ?? '··'}%  o2=${opp.o2 ?? '··'}%   m1=${m1 || '··'}  m2=${m2 || '··'}`;
  if (line === last) continue;                       // collapse consecutive identical reads
  last = line; shown++;
  console.log(`  [${String(i).padStart(4)}] ${line}`);
}
await worker.terminate();
console.log(`\n(${shown} distinct readings)`);
