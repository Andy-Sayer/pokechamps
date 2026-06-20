// Read a directory of captured battle frames and print the reconstructed event
// timeline — the live-tracking readout. Chains the proven pipeline:
//   frame → banner band (near-white-text detect) → OCR → dedupe → parseBanner.
// Species come from the banner text (fuzzy-matched to the legal list); nicknamed
// mons fall back to the nameplate appearance match elsewhere.
//
//   npx tsx packages/vision/scripts/read-battle.ts [framesDir=packages/vision/fixtures/seq]
//
// Frames must be the single 1920×1080 game monitor (normalized region adapts to the
// actual frame size, so any fullscreen 16:9 capture works).

import { Jimp } from 'jimp';
import { createWorker } from 'tesseract.js';
import { readdirSync } from 'node:fs';
import { CHAMPIONS_DOUBLES_PLACEHOLDER, toPixels } from '../src/regions.js';
import { parseBanner, type BattleMessage } from '../src/bannerParse.js';

const dir = process.argv[2] ?? 'packages/vision/fixtures/seq';
const files = readdirSync(dir).filter(f => /\.(png|jpg)$/i.test(f)).sort();
if (!files.length) { console.error(`no frames in ${dir}`); process.exit(1); }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const detail = (e: BattleMessage): string => {
  switch (e.kind) {
    case 'move': return `${e.species ?? e.label} → ${e.move}`;
    case 'mega': case 'faint': case 'flinch': case 'weather': return `${e.species ?? e.label}${e.kind === 'weather' ? ` (${e.weather})` : ''}`;
    case 'megaReact': return `${e.species ?? e.label} (${e.item})`;
    case 'switchIn': return `${e.species ?? '?'}${e.nickname ? ` "${e.nickname}"` : ''}${e.trainer ? ` ← ${e.trainer}` : ''}`;
    case 'switchOut': return `${e.species ?? e.label} → ${e.trainer}`;
    case 'statChange': return `${e.species ?? e.label}: ${e.stats.join('/')} ${e.dir}`;
    case 'effectiveness': return `${e.level} on ${e.species ?? e.label}`;
    case 'heal': return `${e.species ?? e.label} (from ${e.source})`;
    case 'ability': return `${e.species ?? e.label} (${e.ability})`;
    case 'residual': return `${e.species ?? e.label} (${e.source})`;
    case 'status': return `${e.species ?? e.label} (${e.status})`;
    case 'protect': case 'miss': case 'hpLoss': return `${e.species ?? e.label}`;
    case 'confusionHit': return 'self-hit';
    case 'weatherStart': return `(${e.weather})`;
    case 'weatherEnd': return 'cleared';
    case 'screen': return e.screen;
    case 'end': return `${e.reason}${e.trainer ? ` (${e.trainer})` : ''}`;
    default: return '';
  }
};

const worker = await createWorker('eng', 1, { langPath: process.cwd(), cachePath: process.cwd(), gzip: false });
const tmp = `${dir}/_band.png`;
let last = '', scanned = 0, banners = 0, unknown = 0;
const events: { i: number; e: BattleMessage }[] = [];

for (let i = 0; i < files.length; i++) {
  const img = await Jimp.read(`${dir}/${files[i]}`);
  const W = img.bitmap.width, H = img.bitmap.height;
  const r = toPixels(CHAMPIONS_DOUBLES_PLACEHOLDER.battleText, W, H);
  const band = { x: Math.max(0, r.x - 4), y: Math.max(0, r.y - 2), w: Math.min(W, Math.round(r.w * 1.12)), h: r.h + 6 };
  const c = img.clone().crop(band);
  const d = c.bitmap.data; const n = c.bitmap.width * c.bitmap.height;
  // Gate + binarize on WHITE (bright AND low-saturation) — the banner text colour.
  // Plain luminance also fired on coloured effects (fire/explosions) and light-coloured
  // mons (e.g. Pelipper), flooding OCR with garbage. Saturation rejects all of that.
  const isWhite = (p: number) => {
    const r0 = d[p*4]!, g0 = d[p*4+1]!, b0 = d[p*4+2]!;
    return Math.min(r0, g0, b0) > 175 && Math.max(r0, g0, b0) - Math.min(r0, g0, b0) < 45;
  };
  let white = 0;
  for (let p = 0; p < n; p++) if (isWhite(p)) white++;
  scanned++;
  if (white < 250) continue;                                  // no banner text
  const g = c.clone();
  g.scan(0, 0, g.bitmap.width, g.bitmap.height, function (x, y, idx) {
    const mn = Math.min(this.bitmap.data[idx]!, this.bitmap.data[idx+1]!, this.bitmap.data[idx+2]!);
    const mx = Math.max(this.bitmap.data[idx]!, this.bitmap.data[idx+1]!, this.bitmap.data[idx+2]!);
    const o = mn > 175 && mx - mn < 45 ? 0 : 255;             // white text -> black on white
    this.bitmap.data[idx] = this.bitmap.data[idx + 1] = this.bitmap.data[idx + 2] = o;
  });
  g.scale(3);
  await g.write(tmp as `${string}.png`);
  const { data } = await worker.recognize(tmp);
  const text = data.text.trim().replace(/\s+/g, ' ');
  if (text.length <= 5 || !/[a-z]{3}/i.test(text) || norm(text) === norm(last)) continue;
  last = text;
  banners++;
  const e = parseBanner(text);
  if (e.kind === 'unknown') { unknown++; if (process.env.DEBUG_UNK) console.log(`  UNK [${String(i).padStart(4)}] ${JSON.stringify(text)}`); continue; }
  events.push({ i, e });
}
await worker.terminate();

// A banner persists across many frames, so the same event is re-read repeatedly
// (with OCR jitter on the move text). Collapse CONSECUTIVE same-event reads by a
// structural signature — kind + side + species — so a single use/switch/faint
// shows once. Move text is deliberately excluded (it jitters: "Iron Head" vs
// "lron Head"); a mon only acts once before a different event intervenes, so the
// next genuine occurrence (separated by other events) is still kept.
const sig = (e: BattleMessage): string => {
  const id = ('species' in e ? (e.species ?? e.label) : '') || '';
  const side = 'side' in e ? e.side : '-';
  let extra = '';
  if (e.kind === 'effectiveness') extra = e.level;
  else if (e.kind === 'statChange') extra = `${e.stats.join(',')}${e.dir}`;
  else if (e.kind === 'ability') extra = e.ability;
  else if (e.kind === 'residual') extra = e.source;
  else if (e.kind === 'status') extra = e.status;
  else if (e.kind === 'weatherStart') extra = e.weather;
  return [e.kind, side, id, extra].join('|');
};
const shown = events.filter((ev, idx) => idx === 0 || sig(ev.e) !== sig(events[idx - 1]!.e));

console.log(`\n=== EVENT TIMELINE (${shown.length} events [${events.length} pre-dedup] from ${banners} banners / ${scanned} frames) ===`);
for (const { i, e } of shown) console.log(`  [${String(i).padStart(4)}] ${e.kind.padEnd(13)} ${('side' in e ? e.side : '--').padEnd(5)} ${detail(e)}`);
console.log(`\n(${unknown} banners parsed as unknown — animation/garbage)`);
