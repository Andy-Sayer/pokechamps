// Calibration helper: find the tight bounding box of the white battle-text banner
// ("X used Y!") in a frame, so regions.ts battleText can be set precisely.
// Detects near-white text pixels in the lower band, isolates the densest
// contiguous ROW strip (the text line), then its column extent. Prints px + norm.
//
//   npx tsx packages/vision/scripts/find-banner.ts <frame.png> [<frame.png> ...]

import { Jimp } from 'jimp';

const SEARCH_Y0 = 0.55, SEARCH_Y1 = 0.95;   // lower portion of the frame
const SEARCH_X0 = 0.03, SEARCH_X1 = 0.97;

async function analyze(path: string) {
  const img = await Jimp.read(path);
  const W = img.bitmap.width, H = img.bitmap.height, d = img.bitmap.data;
  const y0 = Math.round(SEARCH_Y0 * H), y1 = Math.round(SEARCH_Y1 * H);
  const x0 = Math.round(SEARCH_X0 * W), x1 = Math.round(SEARCH_X1 * W);

  const rowCount = new Array(H).fill(0);
  const isWhite = (i: number) => {
    const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!;
    const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
    return mn > 175 && mx - mn < 45;            // bright + low-saturation = white-ish text
  };
  for (let y = y0; y < y1; y++) {
    let c = 0;
    for (let x = x0; x < x1; x++) if (isWhite((y * W + x) * 4)) c++;
    rowCount[y] = c;
  }

  // Densest contiguous row strip: grow around the peak row while rows stay >20% of peak.
  const peak = Math.max(...rowCount);
  if (peak < 10) { console.log(`${path}\n  no banner text detected (peak row white=${peak})`); return; }
  const peakY = rowCount.indexOf(peak);
  const thresh = Math.max(8, peak * 0.2);
  let top = peakY, bot = peakY;
  while (top > y0 && rowCount[top - 1] >= thresh) top--;
  while (bot < y1 - 1 && rowCount[bot + 1] >= thresh) bot++;

  // Column extent within that strip (same white test), with a small density floor
  // so a few stray pixels don't widen the box.
  const colCount = new Array(W).fill(0);
  for (let x = x0; x < x1; x++) {
    let c = 0;
    for (let y = top; y <= bot; y++) if (isWhite((y * W + x) * 4)) c++;
    colCount[x] = c;
  }
  const colFloor = Math.max(1, (bot - top) * 0.08);
  let left = x1, right = x0;
  for (let x = x0; x < x1; x++) if (colCount[x] >= colFloor) { if (x < left) left = x; if (x > right) right = x; }

  const pad = 4;
  const bx = Math.max(0, left - pad), by = Math.max(0, top - pad);
  const bw = Math.min(W, right + pad) - bx, bh = Math.min(H, bot + pad) - by;
  const f = (n: number, dp = 4) => n.toFixed(dp);
  console.log(`${path}`);
  console.log(`  px   x=${bx} y=${by} w=${bw} h=${bh}   (text rows ${top}..${bot}, peak@${peakY}=${peak})`);
  console.log(`  norm x=${f(bx / W)} y=${f(by / H)} w=${f(bw / W)} h=${f(bh / H)}`);
}

for (const p of process.argv.slice(2)) await analyze(p);
