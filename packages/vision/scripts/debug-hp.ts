// Debug the my-HP read at the GameShare inset scale: for each my slot, dump the
// raw HP-text OCR + parseAbsHp + the bar fraction, and save the cropped HP-text /
// bar regions so we can SEE whether the region is placed right (or the OCR is the
// problem).  npx tsx scripts/debug-hp.ts [path] [--full]
import { Jimp } from 'jimp';
import { loadFrame } from '../src/decode.js';
import { TesseractOcrReader } from '../src/ocr.js';
import { CHAMPIONS_DOUBLES_PLACEHOLDER, insetRegionMap } from '../src/regions.js';
import { parseAbsHp } from '../src/hpRead.js';
import { cropRegion } from '../src/visionSource.js';
import { readHpFraction } from '../src/hpBar.js';

const path = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'fixtures/gameshare-battle.png';
const regions = !process.argv.includes('--full') ? insetRegionMap(CHAMPIONS_DOUBLES_PLACEHOLDER) : CHAMPIONS_DOUBLES_PLACEHOLDER;
const frame = await loadFrame(path);
const ocr = new TesseractOcrReader();

const save = async (px: Uint8ClampedArray, w: number, h: number, name: string) => {
  const img = new Jimp({ width: w, height: h });
  img.bitmap.data.set(px);
  await (img as unknown as { write(p: string): Promise<unknown> }).write(`fixtures/${name}`);
};

for (const i of [0, 1] as const) {
  const r = regions.myHpText![i];
  const raw = await ocr.read(frame, r, { mode: 'digits', psm: 7 });
  const abs = parseAbsHp(raw);
  const c = cropRegion(frame, r); await save(c.data, c.width, c.height, `dbg_myhp_${i}.png`);
  const slot = regions.slots.find(s => s.side === 'mine' && s.index === i)!;
  const b = cropRegion(frame, slot.hpBar); await save(b.data, b.width, b.height, `dbg_mybar_${i}.png`);
  console.log(`mine${i}: rawHP="${raw}"  parsed=${JSON.stringify(abs)}  barFrac=${readHpFraction(b.data, b.width, b.height).toFixed(2)}  hpTextPx=${JSON.stringify(toPx(r))}`);
}
await ocr.close();

function toPx(r: { x: number; y: number; w: number; h: number }) {
  return { x: Math.round(r.x * frame.width), y: Math.round(r.y * frame.height), w: Math.round(r.w * frame.width), h: Math.round(r.h * frame.height) };
}
