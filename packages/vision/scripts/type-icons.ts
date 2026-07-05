// Read the opponent type-icons at team preview → a coarse type combo → (caller) a dossier
// species shortlist. HARVEST HELPER ONLY, ADVISORY — do NOT use as a type oracle.
//   bootstrap: type-icons.ts bootstrap <frame.png> <slot:Type1/Type2> ...
//   read:      type-icons.ts read <frame.png>   → each slot's two types
//
// RELIABILITY (measured 2026-07-04): this reader is UNRELIABLE. The icons are tiny (48px)
// and several types are near-grey (Dark/Steel/Rock/Normal), which colour-histograms can't
// separate; the box-a (primary-type) crop is also mis-registered on the icon edge — so it
// systematically misreads the primary type (e.g. Grimmsnarl's DARK read as GRASS). This is
// TOLERATED because it never reaches the product: species identity comes from the SPRITE
// matcher (colorHist.ts), and once the species is known its types come from the DOSSIER —
// correct and free. Regional formes are disambiguated by their DISTINCT sprites (Alolan
// Ninetales is white/blue vs base gold), not by these icons. So the reader is only a
// search-narrowing hint during manual harvest; a wrong read just widens the shortlist. If
// a proper type oracle is ever needed, template-match the fixed icon symbols (not colour
// hist) and re-register box-a — but prefer the dossier-by-species path.
import { Jimp } from 'jimp';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '@pokechamps/core/domain/data.js';
import { colorHistogram, histDistance, type ColorHistRef } from '../src/colorHist.js';
import { typeIconBoxes } from '../src/regions.js';

const BINS = 4;
const [mode, framePath, ...rest] = process.argv.slice(2);
if (!mode || !framePath) { console.error('usage: type-icons.ts <bootstrap|read> <frame.png> [slot:T1/T2 …]'); process.exit(1); }
const out = join(dataDirPath(), 'type-icon-refs.json');
const load = (): ColorHistRef[] => existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as { refs: ColorHistRef[] }).refs : [];

const img = await Jimp.read(framePath);
const boxes = typeIconBoxes(img.bitmap.width, img.bitmap.height);
const histOf = (b: { x: number; y: number; w: number; h: number }) => {
  const c = img.clone().crop(b);
  return colorHistogram(new Uint8ClampedArray(c.bitmap.data), b.w, b.h, { bins: BINS }).map(v => +v.toFixed(5));
};

if (mode === 'bootstrap') {
  const byId = new Map(load().map(r => [r.id, r]));
  for (const spec of rest) {
    const [slotS, types] = spec.split(':'); const slot = Number(slotS); const [t1, t2] = (types ?? '').split('/');
    if (t1) byId.set(t1.toLowerCase(), { id: t1.toLowerCase(), name: t1, hist: histOf(boxes[slot]!.a) });
    if (t2) byId.set(t2.toLowerCase(), { id: t2.toLowerCase(), name: t2, hist: histOf(boxes[slot]!.b) });
  }
  const refs = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(out, JSON.stringify({ refs }) + '\n');
  console.log(`type-icon refs: ${refs.length}/18 (${refs.map(r => r.name).join(', ')})`);
} else {
  const refs = load();
  if (!refs.length) { console.error('no type-icon refs yet — bootstrap first.'); process.exit(1); }
  const match = (b: { x: number; y: number; w: number; h: number }) => {
    const q = histOf(b); let best: ColorHistRef | null = null, bd = Infinity;
    for (const r of refs) { const d = histDistance(q, r.hist); if (d < bd) { bd = d; best = r; } }
    return best ? `${best.name.padEnd(8)}(${bd.toFixed(2)})` : '?';
  };
  for (let i = 0; i < 6; i++) console.log(`  slot ${i}: ${match(boxes[i]!.a)} / ${match(boxes[i]!.b)}`);
}
process.exit(0);
