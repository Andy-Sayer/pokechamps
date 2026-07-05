// Render the sprite-ref review as a single labelled contact-sheet IMAGE (not HTML), so it
// can be shown inline. Each cell: the source crop + assigned species + nearest-rival
// distance; border red/amber/green by collision risk; riskiest/unverified first.
//   npx tsx packages/vision/scripts/review-montage.ts <out.png>
import { Jimp, loadFont } from 'jimp';
import { SANS_16_WHITE } from 'jimp/fonts';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId } from '@pokechamps/core/domain/data.js';
import { histDistance, type ColorHistRef } from '../src/colorHist.js';

const refs = (JSON.parse(readFileSync(join(dataDirPath(), 'sprite-refs.json'), 'utf8')).refs as (ColorHistRef & { verified?: boolean })[]);
const cropDir = join(dataDirPath(), 'sprite-ref-crops');

type Item = { name: string; id: string; verified: boolean; rd: number; rival: string; crop: Awaited<ReturnType<typeof Jimp.read>> };
const items: Item[] = [];
for (const r of refs) {
  const p = join(cropDir, `${r.id}.png`);
  if (!existsSync(p)) continue;
  let rd = Infinity, rival = '';
  for (const s of refs) { if (toId(s.name) === toId(r.name)) continue; const d = histDistance(r.hist, s.hist); if (d < rd) { rd = d; rival = s.name; } }
  items.push({ name: r.name, id: r.id, verified: !!r.verified, rd, rival, crop: await Jimp.read(p) });
}
items.sort((a, b) => a.rd - b.rd); // riskiest (closest rival) first

const COLS = 7, CW = 150, CH = 176, PAD = 6, IMG = 116;
const rows = Math.ceil(items.length / COLS);
const sheet = new Jimp({ width: COLS * CW, height: rows * CH, color: 0x161616ff });
const font = await loadFont(SANS_16_WHITE);
const small = font;

for (let i = 0; i < items.length; i++) {
  const it = items[i]!;
  const cx = (i % COLS) * CW, cy = Math.floor(i / COLS) * CH;
  const border = it.rd < 0.5 ? 0xd83a3aff : it.rd < 0.75 ? 0xcc9a22ff : 0x3a9a3aff;
  const cell = new Jimp({ width: CW - PAD, height: CH - PAD, color: border });
  cell.composite(new Jimp({ width: CW - PAD - 6, height: CH - PAD - 6, color: 0x7a0b39ff }), 3, 3); // magenta panel like the game
  const s = IMG / Math.max(it.crop.bitmap.width, it.crop.bitmap.height);
  const img = it.crop.clone().scale(s);
  cell.composite(img, Math.round((CW - PAD - img.bitmap.width) / 2), 6);
  cell.print({ font, x: 6, y: CH - PAD - 42, text: `${it.name}` });
  cell.print({ font: small, x: 6, y: CH - PAD - 22, text: `${it.verified ? 'v' : '?'} rival ${it.rd === Infinity ? '-' : it.rd.toFixed(2)}` });
  sheet.composite(cell, cx + Math.round(PAD / 2), cy + Math.round(PAD / 2));
}
const out = process.argv[2] ?? join(process.cwd(), 'review-montage.png');
await sheet.write(out as `${string}.png`);
console.log(`wrote ${out} — ${items.length} crops, ${COLS}x${rows} grid`);
