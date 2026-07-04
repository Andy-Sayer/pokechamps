// Per-source calibration check for the team-preview grid. Crop boxes shift with a
// streamer's facecam / overlay / resolution, so before harvesting refs from a new VOD,
// verify the calibrated opponent grid lands on the sprites — and adjust the coords in
// regions.ts (a named calibration) if it doesn't. Saves crop_opp_<i>.png for a visual
// check and prints the box coords.
//   npx tsx packages/vision/scripts/calibrate-preview.ts <frame.png>
import { Jimp } from 'jimp';
import { dirname, join } from 'node:path';
import { opponentSpriteBoxes } from '../src/regions.js';

const framePath = process.argv[2];
if (!framePath) { console.error('usage: calibrate-preview <frame.png>'); process.exit(1); }
const img = await Jimp.read(framePath);
const boxes = opponentSpriteBoxes(img.bitmap.width, img.bitmap.height);
const outDir = dirname(framePath);
console.log(`frame ${img.bitmap.width}x${img.bitmap.height} · ${boxes.length} opponent boxes`);
for (let i = 0; i < boxes.length; i++) {
  const b = boxes[i]!;
  await img.clone().crop({ x: b.x, y: b.y, w: b.w, h: b.h }).write(join(outDir, `crop_opp_${i}.png`) as `${string}.png`);
  console.log(`  box ${i}: x=${b.x} y=${b.y} w=${b.w} h=${b.h}`);
}
console.log('→ view crop_opp_0..5.png; if they miss the sprites, adjust regions.ts for this source.');
process.exit(0);
