// Pre-label a team-preview frame for sprite harvest: for each of the 6 opponent slots,
// read the two type-icons (→ type combo), list the legal-dossier species with that combo
// (the shortlist), and run the existing colour-hist sprite matcher as a pre-guess. Also
// writes a vertical montage of the six sprite crops (+ per-slot crops) so I can confirm
// each pick visually. Turns "eyeball 200 sprites" into "confirm 1 of ~3".
//   npx tsx packages/vision/scripts/harvest-assist.ts <preview-frame.png>
import { Jimp } from 'jimp';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { dataDirPath, toId } from '@pokechamps/core/domain/data.js';
import { loadDossier } from '@pokechamps/core/domain/monDossier.js';
import { colorHistogram, histDistance, HistogramMatcher, loadColorHistRefs, type ColorHistRef } from '../src/colorHist.js';
import { opponentSpriteBoxes, typeIconBoxes, CHAMPIONS_OPP_PANEL_BG } from '../src/regions.js';

const framePath = process.argv[2];
if (!framePath) { console.error('usage: harvest-assist <preview-frame.png>'); process.exit(1); }

const BINS = 4;
const img = await Jimp.read(framePath);
const W = img.bitmap.width, H = img.bitmap.height;

// --- type-icon refs + reader ---------------------------------------------------------
const tiPath = join(dataDirPath(), 'type-icon-refs.json');
const tiRefs: ColorHistRef[] = existsSync(tiPath) ? (JSON.parse(readFileSync(tiPath, 'utf8')) as { refs: ColorHistRef[] }).refs : [];
const iconBoxes = typeIconBoxes(W, H);
const histOfBox = (b: { x: number; y: number; w: number; h: number }, bg = false) => {
  const c = img.clone().crop(b);
  return colorHistogram(new Uint8ClampedArray(c.bitmap.data), b.w, b.h, bg ? { bins: BINS, bgColor: CHAMPIONS_OPP_PANEL_BG } : { bins: BINS });
};
const readType = (b: { x: number; y: number; w: number; h: number }): { type: string; dist: number } => {
  if (!tiRefs.length) return { type: '?', dist: Infinity };
  const q = histOfBox(b); let best = '?', bd = Infinity;
  for (const r of tiRefs) { const d = histDistance(q, r.hist); if (d < bd) { bd = d; best = r.name; } }
  return { type: best, dist: bd };
};

// --- dossier shortlist by type combo -------------------------------------------------
const dossier = loadDossier().filter(e => !e.forme); // base species + regionals (mega shares base sprite)
const shortlistFor = (t1: string, t2: string): string[] => {
  const want = new Set([toId(t1), toId(t2)].filter(x => x && x !== '?'));
  if (!want.size) return [];
  return dossier
    .filter(e => { const et = new Set(e.types.map(toId)); return [...want].every(w => et.has(w)) && et.size === want.size; })
    .map(e => e.label);
};

// --- existing sprite matcher (pre-guess) ---------------------------------------------
const matcher = new HistogramMatcher(loadColorHistRefs(), { bins: BINS, bgColor: CHAMPIONS_OPP_PANEL_BG });
const spriteBoxes = opponentSpriteBoxes(W, H);

// --- montage of the six sprite crops -------------------------------------------------
const PAD = 4;
const cw = spriteBoxes[0]!.w, ch = spriteBoxes[0]!.h;
const montage = new Jimp({ width: cw + PAD * 2, height: (ch + PAD) * 6 + PAD, color: 0x202020ff });
spriteBoxes.forEach((b, i) => {
  const crop = img.clone().crop(b);
  montage.composite(crop, PAD, PAD + i * (ch + PAD));
});
const outDir = dirname(framePath);
const stem = basename(framePath).replace(/\.png$/, '');
const montagePath = join(outDir, `${stem}_montage.png`);
await montage.write(montagePath as `${string}.png`);

console.log(`\n${basename(framePath)}  →  montage: ${montagePath}\n`);
for (let i = 0; i < 6; i++) {
  const ta = readType(iconBoxes[i]!.a), tb = readType(iconBoxes[i]!.b);
  const combo = tb.type !== '?' && tb.type !== ta.type ? `${ta.type}/${tb.type}` : ta.type;
  const sl = shortlistFor(ta.type, tb.type);
  const b = spriteBoxes[i]!;
  const crop = img.clone().crop(b);
  const m = matcher.match(new Uint8ClampedArray(crop.bitmap.data), b.w, b.h);
  const guess = m ? `${m.name}(${m.distance.toFixed(2)})` : '—';
  console.log(`slot ${i}: ${combo.padEnd(18)} icons(${ta.dist.toFixed(2)}/${tb.dist.toFixed(2)})  match=${guess}`);
  console.log(`         shortlist[${sl.length}]: ${sl.slice(0, 8).join(', ')}${sl.length > 8 ? ' …' : ''}`);
}
console.log(`\nlabel:  npx tsx packages/vision/scripts/bootstrap-refs.ts ${framePath} <id0,id1,id2,id3,id4,id5>`);
process.exit(0);
