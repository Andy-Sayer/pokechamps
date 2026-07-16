// Replay a DIRECTORY of captured battle frames through the FULL production read
// pipeline (readFrame → BattleStateMachine → TurnProposals) — the dongle-free
// integration validation from vision-plan P8. Where read-battle.ts prints the
// banner-parse event timeline only, this exercises everything the live watcher
// does: HP-number OCR, the per-action HP timeline (per-hit damage attribution),
// raw mine-side HP, crit/status banners, spread detection.
//
//   npx tsx packages/vision/scripts/replay-frames.ts <framesDir> [--full]
//       [--leads m1=Talonflame,m2=Kingambit,o1=Froslass,o2=Incineroar] [--verbose]
//
// --full = frames are the bare 16:9 game screen (default assumes a GameShare inset,
//          matching how the live sequences under fixtures/live/ were captured).
// Prints each completed turn's canonical lines + notes; partial previews only
// with --verbose. Frames are replayed in filename order.
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runVision } from '../src/visionSource.js';
import type { FrameGrabber } from '../src/frameGrabber.js';
import { TesseractOcrReader } from '../src/ocr.js';
import { CHAMPIONS_DOUBLES_PLACEHOLDER, insetRegionMap } from '../src/regions.js';
import { loadFrame } from '../src/decode.js';
import type { Roster } from '../src/assemble.js';
import type { Frame } from '../src/types.js';

const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith('--'));
if (!dir) { console.error('usage: replay-frames.ts <framesDir> [--full] [--leads ...] [--verbose]'); process.exit(1); }
const arg = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const gameshare = !args.includes('--full');
const verbose = args.includes('--verbose');

const leads: Partial<Roster> = {};
const leadsArg = arg('--leads');
if (leadsArg) for (const pair of leadsArg.split(',')) {
  const [k, v] = pair.split('=').map(s => s.trim());
  if (k && v && ['m1', 'm2', 'o1', 'o2'].includes(k)) (leads as Record<string, string>)[k] = v;
}

/** Serves every image in the directory once, in filename order. */
class DirFrameGrabber implements FrameGrabber {
  private files: string[];
  private i = 0;
  constructor(private readonly root: string) {
    this.files = readdirSync(root).filter(f => /\.(png|jpg)$/i.test(f)).sort();
    if (!this.files.length) { console.error(`no frames in ${root}`); process.exit(1); }
  }
  get total(): number { return this.files.length; }
  async next(): Promise<Frame | null> {
    const f = this.files[this.i++];
    if (!f) return null;
    try { return await loadFrame(join(this.root, f)); }
    catch { return this.next(); }   // torn/corrupt frame — skip
  }
}

const regions = gameshare ? insetRegionMap(CHAMPIONS_DOUBLES_PLACEHOLDER) : CHAMPIONS_DOUBLES_PLACEHOLDER;
const grabber = new DirFrameGrabber(resolve(dir));
const ocr = new TesseractOcrReader();

console.error(`[replay] ${grabber.total} frames from ${dir} · regions=${regions.label} · leads=${JSON.stringify(leads)}`);
const t0 = Date.now();
let frames = 0, turns = 0;

await runVision(
  { grabber, ocr, regions },
  p => {
    if (p.partial) { if (verbose) console.log(`  (preview) ${p.lines.join('  |  ')}`); return; }
    turns++;
    console.log(`TURN ${turns} @f${frames}:`);
    for (const l of p.lines) console.log(`  ${l}`);
    for (const n of p.notes) console.log(`  # ${n}`);
  },
  {
    leads,
    onFrame: () => {
      frames++;
      if (frames % 50 === 0) console.error(`[replay] frame ${frames}/${grabber.total} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    },
    onError: (e, n) => console.error(`[replay] frame error (${n}): ${e.message}`),
  },
);

console.error(`[replay] done: ${frames} frames, ${turns} turns, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
await ocr.close?.();
