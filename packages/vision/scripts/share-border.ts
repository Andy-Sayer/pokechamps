// One-off: find the GameShare shared-screen inset border in a captured frame by
// luma profile. Prints per-column / per-row mean brightness so a darker frame
// border (or a distinct inset edge) shows up as edge plateaus vs a bright centre.
//   npx tsx scripts/share-border.ts [path]
import { Jimp } from 'jimp';

const path = process.argv[2] ?? 'fixtures/gameshare-feed.png';
const img = await Jimp.read(path);
const { width: W, height: H, data } = img.bitmap as { width: number; height: number; data: Buffer };
const luma = (x: number, y: number) => { const i = (y * W + x) * 4; return 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!; };
const colL = (x: number) => { let s = 0, n = 0; for (let y = 0; y < H; y += 4) { s += luma(x, y); n++; } return s / n; };
const rowL = (y: number) => { let s = 0, n = 0; for (let x = 0; x < W; x += 4) { s += luma(x, y); n++; } return s / n; };

console.log(`frame ${W}x${H}  (${path})`);
let cols = ''; for (let x = 0; x < W; x += 40) cols += `${x}:${colL(x).toFixed(0)} `;
console.log('COL luma (x:val):\n' + cols);
let rows = ''; for (let y = 0; y < H; y += 30) rows += `${y}:${rowL(y).toFixed(0)} `;
console.log('ROW luma (y:val):\n' + rows);

// Auto-detect the inset: first/last col & row whose full-line mean luma clears
// the dark-border threshold (borders ~15-30, content ~120-190 → 70 separates).
const T = 70;
let left = 0; while (left < W && colL(left) < T) left++;
let right = W - 1; while (right > 0 && colL(right) < T) right--;
let top = 0; while (top < H && rowL(top) < T) top++;
let bottom = H - 1; while (bottom > 0 && rowL(bottom) < T) bottom--;
const iw = right - left + 1, ih = bottom - top + 1;
console.log(`\nINSET  x:${left}..${right} (w ${iw})  y:${top}..${bottom} (h ${ih})`);
console.log(`borders  left ${left}  right ${W - 1 - right}  top ${top}  bottom ${H - 1 - bottom}`);
console.log(`shrink  x ${(iw / W).toFixed(3)}  y ${(ih / H).toFixed(3)}`);
