// Bootstrap / grow the colour-histogram sprite reference table (data/sprite-refs.json)
// from the GAME'S OWN art — the only thing that matches (public icons don't; see
// colorHist.ts). Point it at a fullscreen team-preview frame and give the opponent's
// six species top→bottom; it crops each via the verified opponent grid, computes a
// background-masked colour histogram, and UPSERTS by id (so you accumulate species
// across many frames/matches — preview slots get named by the in-battle text reveal).
//
// VARIANTS: colour-hist is colour-based, so shiny / visibly-different-female sprites need
// their OWN ref — pass a variant-suffixed id (garchomp-shiny, basculegion-f,
// basculegion-f-shiny). The suffix is stripped for the canonical species NAME, so every
// variant maps to the same species when matched (gender/shiny "usually don't matter").
//
//   npx tsx packages/vision/scripts/bootstrap-refs.ts <frame.png> <id1,id2,...>
//   e.g. ... frame.png azumarill,staraptor,arcanine,florges,sylveon,gholdengo
//        ... frame.png garchomp-shiny,-,basculegion-f,...    ('-' skips a slot)

import { Jimp } from 'jimp';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, getSpecies } from '@pokechamps/core/domain/data.js';
import { colorHistogram, type ColorHistRef } from '../src/colorHist.js';
import { opponentSpriteBoxes, CHAMPIONS_OPP_PANEL_BG } from '../src/regions.js';

const BINS = 4;
const [framePath, idsCsv] = process.argv.slice(2);
if (!framePath || !idsCsv) {
  console.error('usage: bootstrap-refs <frame.png> <id1,id2,...>  (opponent species, top→bottom)');
  process.exit(1);
}
// Positional: ids[i] labels box i (top→bottom). Use '-' (or empty) to SKIP a slot
// that's facecam-covered or too small/dark to identify — don't poison a ref.
const ids = idsCsv.split(',').map((s) => s.trim());

const img = await Jimp.read(framePath);
const boxes = opponentSpriteBoxes(img.bitmap.width, img.bitmap.height);
const fresh: ColorHistRef[] = ids.slice(0, boxes.length).flatMap((id, i) => {
  if (!id || id === '-') return [];   // skipped slot (covered / unidentifiable)
  const b = boxes[i]!;
  const c = img.clone().crop({ x: b.x, y: b.y, w: b.w, h: b.h });
  const hist = colorHistogram(new Uint8ClampedArray(c.bitmap.data), b.w, b.h, { bins: BINS, bgColor: CHAMPIONS_OPP_PANEL_BG })
    .map((v) => +v.toFixed(5));
  // Strip the variant suffix (-shiny / -f / -m / -f-shiny) to the base species for the
  // canonical name; the full variant id stays the ref key so variants coexist.
  const baseId = id.replace(/-shiny$/, '').replace(/-(f|m)$/, '');
  const name = (getSpecies(baseId) as { name?: string } | undefined)?.name ?? baseId;
  return [{ id, name, hist }];
});

const out = join(dataDirPath(), 'sprite-refs.json');
const existing = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as { refs: ColorHistRef[] }) : { refs: [] };
const byId = new Map<string, ColorHistRef>(existing.refs.map((r) => [r.id, r]));
for (const r of fresh) byId.set(r.id, r);
const refs = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(out, JSON.stringify({ bins: BINS, refs }) + '\n');
console.log(`wrote ${refs.length} refs (${fresh.length} new/updated): ${fresh.map((r) => r.name).join(', ')}`);
console.log(`-> ${out}`);
