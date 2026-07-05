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
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, getSpecies, isLegalSpecies } from '@pokechamps/core/domain/data.js';
import { colorHistogram, quadrantHistogram, type ColorHistRef } from '../src/colorHist.js';
import { opponentSpriteBoxes, playerSpriteBoxes, CHAMPIONS_OPP_PANEL_BG, CHAMPIONS_PLAYER_CARD_BG, CHAMPIONS_PLAYER_HIGHLIGHT_BG } from '../src/regions.js';

const BINS = 4;
// --player harvests the streamer's OWN team (left column, name-labelled) instead of the
// opponent panel — zero-guess refs that fill gaps the opponent side surfaces slowly.
const player = process.argv.includes('--player');
const [framePath, idsCsv] = process.argv.slice(2).filter((a) => a !== '--player');
if (!framePath || !idsCsv) {
  console.error('usage: bootstrap-refs [--player] <frame.png> <id1,id2,...>  (species top→bottom)');
  process.exit(1);
}
// Positional: ids[i] labels box i (top→bottom). Use '-' (or empty) to SKIP a slot
// that's facecam-covered or too small/dark to identify — don't poison a ref.
const ids = idsCsv.split(',').map((s) => s.trim());

const img = await Jimp.read(framePath);
const boxes = (player ? playerSpriteBoxes : opponentSpriteBoxes)(img.bitmap.width, img.bitmap.height);
const bg = player ? CHAMPIONS_PLAYER_CARD_BG : CHAMPIONS_OPP_PANEL_BG;
// A ref carries provenance + a `verified` flag: an allocation (crop -> species) is
// UNVERIFIED until a human confirms it in the review sheet (scripts/review-sheet.ts).
// The crop PNG is saved so the allocation is auditable — this is how we catch a
// misID (e.g. shiny Grimmsnarl mislabelled "Mewtwo") before it's trusted.
const cropDir = join(dataDirPath(), 'sprite-ref-crops');
mkdirSync(cropDir, { recursive: true });
const pending: { ref: ColorHistRef & { verified: boolean }; crop: InstanceType<typeof Jimp> }[] = [];
ids.slice(0, boxes.length).forEach((id, i) => {
  if (!id || id === '-') return;   // skipped slot (covered / unidentifiable)
  const b = boxes[i]!;
  const c = img.clone().crop({ x: b.x, y: b.y, w: b.w, h: b.h });
  const histOpts = { bins: BINS, bgColor: bg, bgColor2: player ? CHAMPIONS_PLAYER_HIGHLIGHT_BG : undefined, darkThreshold: player ? 65 : 55 };
  const px = new Uint8ClampedArray(c.bitmap.data);
  const hist = colorHistogram(px, b.w, b.h, histOpts).map((v) => +v.toFixed(5));
  const quad = quadrantHistogram(px, b.w, b.h, histOpts).map((v) => +v.toFixed(5));
  // Strip the variant suffix (-shiny / -f / -m / -f-shiny) to the base species for the
  // canonical name; the full variant id stays the ref key so variants coexist.
  const baseId = id.replace(/-shiny$/, '').replace(/-(f|m)$/, '');
  // Legality guard: refuse to label a slot with a species not in the format allow-list.
  // A preview slot is ALWAYS a legal opponent, so an illegal label = a misidentification.
  if (!isLegalSpecies(baseId)) {
    console.error(`  ⚠ slot ${i}: "${id}" -> base "${baseId}" is NOT format-legal — skipping (misID?).`);
    return;
  }
  const name = (getSpecies(baseId) as { name?: string } | undefined)?.name ?? baseId;
  pending.push({ ref: { id, name, hist, quad, verified: false }, crop: c });
});
// Save each crop as provenance (named by ref id) so the human can audit the allocation.
for (const { ref, crop } of pending) await crop.write(join(cropDir, `${ref.id}.png`) as `${string}.png`);
const fresh = pending.map((p) => p.ref);

const out = join(dataDirPath(), 'sprite-refs.json');
const existing = existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as { refs: ColorHistRef[] }) : { refs: [] };
const byId = new Map<string, ColorHistRef>(existing.refs.map((r) => [r.id, r]));
for (const r of fresh) byId.set(r.id, r);
const refs = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(out, JSON.stringify({ bins: BINS, refs }) + '\n');
console.log(`wrote ${refs.length} refs (${fresh.length} new/updated): ${fresh.map((r) => r.name).join(', ')}`);
console.log(`-> ${out}`);
