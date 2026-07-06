// Live auto-read: poll serve.ts's latest.png tap, run the production read
// pipeline, and emit each completed turn as canonical turn-log lines. Emits a
// JSON line per turn on STDOUT (for a parent process — the TUI — to consume) and
// a human-readable line on STDERR. Only READS the tap, so it runs alongside the
// serve process that owns the capture device.
//
//   1) npm run -w @pokechamps/vision serve        # owns the dongle, writes latest.png
//   2) npx tsx scripts/read-live.ts [--full] [--leads o1=Ninetales,o2=Whimsicott,m1=Espathra,m2=Maushold]
//
// --full = no GameShare inset (full-frame regions). Default assumes a GameShare
// inset (the shared screen is a 5/6 centred inset — see regions.GAMESHARE_INSET).
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVision } from '../src/visionSource.js';
import { LatestTapGrabber } from '../src/frameGrabber.js';
import { TesseractOcrReader } from '../src/ocr.js';
import { CHAMPIONS_DOUBLES_PLACEHOLDER, insetRegionMap } from '../src/regions.js';
import type { Roster } from '../src/assemble.js';
import type { Frame, FrameRead } from '../src/types.js';
import { mkdirSync, createWriteStream, rmSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { Jimp } from 'jimp';

const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
const gameshare = !process.argv.includes('--full');
const tapArg = arg('--tap');
const tap = tapArg ? resolve(tapArg) : resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/live/latest.png');

const leads: Partial<Roster> = {};
const leadsArg = arg('--leads');
if (leadsArg) for (const pair of leadsArg.split(',')) {
  const [k, v] = pair.split('=').map(s => s.trim());
  if (k && v && ['m1', 'm2', 'o1', 'o2'].includes(k)) (leads as Record<string, string>)[k] = v;
}

const regions = gameshare ? insetRegionMap(CHAMPIONS_DOUBLES_PLACEHOLDER) : CHAMPIONS_DOUBLES_PLACEHOLDER;
const grabber = new LatestTapGrabber(tap);
const ocr = new TesseractOcrReader();

console.error(`[read-live] tap=${tap}`);
console.error(`[read-live] regions=${regions.label} · leads=${JSON.stringify(leads)}`);
console.error('[read-live] reading… (start `serve` first; Ctrl+C to stop)');

process.on('SIGINT', () => { grabber.close(); void ocr.close().finally(() => process.exit(0)); });

// --debug: dump a self-documenting trace so a failed live watch can be diagnosed
// offline with NO live coordination. Writes to fixtures/live-debug/:
//   frames.jsonl   — every frame's banner OCR + per-slot species/HP reads
//   proposals.jsonl— every emitted turn (INCLUDING empty ones) with confidence/notes
//   frames/*.png   — the actual frame each time the banner shows a NEW real message
//                    (the move/damage/faint screens we need to see when a turn is empty)
const debug = process.argv.includes('--debug');
let framesDir = '';
// Write streams, NOT appendFileSync: the synchronous append blocked the reader's event loop
// whenever an external reader (the monitor) held frames.jsonl open → the "stall". A stream
// buffers + flushes async, so the read loop never waits on disk regardless of who's reading.
let frameStream: WriteStream | null = null, propStream: WriteStream | null = null;
const savedBanners = new Set<string>();
let frameNo = 0;
if (debug) {
  const dbgDir = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/live-debug');
  framesDir = join(dbgDir, 'frames');
  try { rmSync(dbgDir, { recursive: true, force: true }); } catch { /* fresh */ }
  mkdirSync(framesDir, { recursive: true });
  frameStream = createWriteStream(join(dbgDir, 'frames.jsonl'), { flags: 'w' });
  propStream = createWriteStream(join(dbgDir, 'proposals.jsonl'), { flags: 'w' });
  console.error(`[read-live] DEBUG trace → ${dbgDir}`);
}
// A REAL banner has ≥2 alphabetic words; OCR of the battle CINEMATIC reads unique GARBAGE
// every frame ("dl | w=", "a A Cave"). Saving a full-res PNG per unique banner would then fire
// a slow 1080p encode EVERY frame during a cinematic — they pile up faster than they finish and
// starve the event loop → the reader freezes (the stall). So (a) only save real-looking text,
// (b) hard-cap the total, (c) never let more than ONE encode be in flight (backpressure).
const looksReal = (t: string) => (t.match(/[a-z]{3,}/gi)?.length ?? 0) >= 2;
const MAX_SAVED = 250;
let encoding = false;
const onFrame = debug ? (fr: FrameRead, raw: Frame) => {
  frameNo++;
  frameStream?.write(JSON.stringify({
    n: frameNo, ts: fr.ts, banner: fr.battleText,
    slots: fr.slots.map(s => ({ ref: `${s.side}${s.index}`, sp: s.species, raw: s.speciesRaw, conf: +s.speciesConfidence.toFixed(2), hp: s.hpFraction })),
  }) + '\n');
  const b = fr.battleText.trim();
  if (looksReal(b) && !savedBanners.has(b) && savedBanners.size < MAX_SAVED && !encoding) {
    savedBanners.add(b);
    encoding = true;
    const img = new Jimp({ width: raw.width, height: raw.height });
    img.bitmap.data = Buffer.from(raw.data);
    const safe = b.slice(0, 40).replace(/[^a-z0-9]/gi, '_');
    void img.write(join(framesDir, `f${String(frameNo).padStart(4, '0')}_${safe}.png`) as `${string}.png`).catch(() => { /* best-effort */ }).finally(() => { encoding = false; });
  }
} : undefined;

await runVision({ grabber, ocr, regions }, (p) => {
  process.stdout.write(JSON.stringify({ lines: p.lines, confidence: p.confidence, partial: p.partial }) + '\n');
  console.error(`[read-live] ${p.partial ? 'preview' : 'TURN'} → ${p.lines.join('  |  ')}`);
  if (debug && !p.partial) propStream?.write(JSON.stringify({ afterFrame: frameNo, lines: p.lines, confidence: p.confidence, notes: p.notes }) + '\n');
}, {
  leads, onFrame,
  // WATCHDOG: runVision self-heals a hung OCR (timeout→reset), but if a frame is ever stuck
  // MID-PROCESSING past the watchdog window (a wedge that defeats even the reset), exit(3) so the
  // parent (TUI watcher) respawns a clean reader. A paused feed does NOT trip it.
  onWedge: () => { console.error('[read-live] WATCHDOG: frame wedged — exit(3) for a clean respawn'); process.exit(3); },
  // A bad frame is now skipped, not fatal — surface it so a stall-that-was becomes visible.
  onError: (e, n) => { console.error(`[read-live] frame error #${n}: ${e.message}`); frameStream?.write(JSON.stringify({ n: frameNo, error: e.message, consecutive: n }) + '\n'); },
});
