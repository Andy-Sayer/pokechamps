// One-shot read of a single captured frame through the production read path —
// the validation that the OCR/regions actually read a GameShare frame at the
// shrunk inset scale. Prints the FrameRead (per-slot species + HP%, banner).
//   npx tsx scripts/read-once.ts [path] [--full]    (--full = no GameShare inset)
import { loadFrame } from '../src/decode.js';
import { readFrame } from '../src/visionSource.js';
import { TesseractOcrReader } from '../src/ocr.js';
import { StaticFrameGrabber } from '../src/frameGrabber.js';
import { CHAMPIONS_DOUBLES_PLACEHOLDER, insetRegionMap } from '../src/regions.js';

const path = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'fixtures/gameshare-battle.png';
const gameshare = !process.argv.includes('--full');
const regions = gameshare ? insetRegionMap(CHAMPIONS_DOUBLES_PLACEHOLDER) : CHAMPIONS_DOUBLES_PLACEHOLDER;

const frame = await loadFrame(path);
const ocr = new TesseractOcrReader();
console.error(`reading ${path} (${frame.width}x${frame.height}) · regions: ${regions.label}`);
const read = await readFrame(frame, { grabber: new StaticFrameGrabber([]), ocr, regions });
await ocr.close();

console.log(`banner: ${JSON.stringify(read.battleText)}`);
for (const s of read.slots) {
  const hp = s.hpFraction == null ? '?' : `${Math.round(s.hpFraction * 100)}%`;
  console.log(`  ${s.side}${s.index}: ${s.species ?? '(none)'} [raw "${s.speciesRaw}" conf ${s.speciesConfidence.toFixed(2)}]  hp ${hp}`);
}
