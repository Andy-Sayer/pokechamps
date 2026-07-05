// Backfill helper: for a preview frame, show each slot's matcher pre-guess + distance,
// flag [NEED] when that species has no saved crop yet, and dump a montage to confirm by
// sight. Lets a crop-backfill pass target only the un-cropped refs instead of re-labelling
// everything. Opponent side by default; --player for the streamer's own team.
//   npx tsx packages/vision/scripts/backfill-assist.ts [--player] <frame.png>
import { Jimp } from 'jimp';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { dataDirPath, toId } from '@pokechamps/core/domain/data.js';
import { HistogramMatcher, loadColorHistRefs } from '../src/colorHist.js';
import { opponentSpriteBoxes, playerSpriteBoxes, CHAMPIONS_OPP_PANEL_BG, CHAMPIONS_PLAYER_CARD_BG, CHAMPIONS_PLAYER_HIGHLIGHT_BG } from '../src/regions.js';

const player = process.argv.includes('--player');
const framePath = process.argv.slice(2).find((a) => a !== '--player');
if (!framePath) { console.error('usage: backfill-assist [--player] <frame.png>'); process.exit(1); }

const cropDir = join(dataDirPath(), 'sprite-ref-crops');
const captured = new Set(existsSync(cropDir) ? readdirSync(cropDir).map((f) => f.replace('.png', '')) : []);
const matcher = new HistogramMatcher(loadColorHistRefs(), {
  bins: 4, bgColor: player ? CHAMPIONS_PLAYER_CARD_BG : CHAMPIONS_OPP_PANEL_BG,
  bgColor2: player ? CHAMPIONS_PLAYER_HIGHLIGHT_BG : undefined, darkThreshold: player ? 65 : 55,
});

const img = await Jimp.read(framePath);
const boxes = (player ? playerSpriteBoxes : opponentSpriteBoxes)(img.bitmap.width, img.bitmap.height);

// montage of the six crops
const PAD = 4, cw = boxes[0]!.w, ch = boxes[0]!.h;
const montage = new Jimp({ width: cw + PAD * 2, height: (ch + PAD) * 6 + PAD, color: 0x202020ff });
const outDir = dirname(framePath), stem = basename(framePath).replace(/\.png$/, '');
console.log(`\n${basename(framePath)}${player ? ' [player]' : ''}`);
boxes.forEach((b, i) => {
  const c = img.clone().crop({ x: b.x, y: b.y, w: b.w, h: b.h });
  montage.composite(c, PAD, PAD + i * (ch + PAD));
  const m = matcher.match(new Uint8ClampedArray(c.bitmap.data), b.w, b.h);
  const need = m && !captured.has(m.id);
  console.log(`  slot ${i}: ${m ? `${m.name.padEnd(16)} ${m.distance.toFixed(2)}  ${need ? '[NEED]' + (m.id !== toId(m.name) ? ` (${m.id})` : '') : 'have'}` : '—'}`);
});
const mp = join(outDir, `${stem}_bf${player ? 'P' : ''}.png`);
await montage.write(mp as `${string}.png`);
console.log(`  montage: ${mp}`);
