// Archive a deduped frame SEQUENCE of a live match by polling serve.ts's tap
// (latest.png). Real battle data to calibrate regions and develop/verify the turn
// reader. Non-invasive: it only copies the file ffmpeg already writes, so it never
// touches the capture device (which serve.ts holds exclusively). Run serve first.
//
//   npm run -w @pokechamps/vision record              # -> fixtures/live/seq-<ts>/
//   npm run -w @pokechamps/vision record -- --fps 4 --dir mydir
//
// Ctrl+C to stop. Only complete, changed PNGs are kept (torn mid-write frames and
// duplicates are skipped).

import { mkdirSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

const src = resolve(arg('--src') ?? join(here, '../fixtures/live/latest.png'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = resolve(arg('--dir') ?? join(here, `../fixtures/live/seq-${stamp}`));
const fps = Number(arg('--fps') ?? 4);
const period = Math.max(50, Math.round(1000 / fps));
mkdirSync(dir, { recursive: true });

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

let n = 0, lastMtime = 0, lastSize = -1;
console.error(`[record] ${src} -> ${dir} @ ${fps}fps (Ctrl+C to stop)`);

setInterval(() => {
  try {
    const st = statSync(src);
    if (st.mtimeMs === lastMtime && st.size === lastSize) return;   // unchanged
    const buf = readFileSync(src);
    // Complete-PNG guard: signature + IEND trailer, so torn mid-write reads are skipped.
    if (buf.length < 1000 || !buf.subarray(0, 8).equals(PNG_SIG) || !buf.subarray(-8).equals(IEND)) return;
    // Write the verified buffer (NOT copyFileSync, which would re-read the file and
    // could capture a torn state if ffmpeg overwrote it between check and copy).
    writeFileSync(join(dir, `frame_${String(n++).padStart(5, '0')}.png`), buf);
    lastMtime = st.mtimeMs; lastSize = st.size;
    if (n % 20 === 0) console.error(`[record] ${n} frames`);
  } catch { /* file mid-swap; try next tick */ }
}, period);

process.on('SIGINT', () => { console.error(`\n[record] stopped: ${n} frames in ${dir}`); process.exit(0); });
