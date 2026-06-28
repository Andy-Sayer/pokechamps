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

await runVision({ grabber, ocr, regions }, (p) => {
  process.stdout.write(JSON.stringify({ lines: p.lines, confidence: p.confidence }) + '\n');
  console.error(`[read-live] TURN → ${p.lines.join('  |  ')}`);
}, { leads });
