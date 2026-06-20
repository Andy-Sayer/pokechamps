// Extract a frame SEQUENCE from a YouTube match VOD — a dongle-free frame SOURCE so
// the vision/OCR pipeline is portable: iterate on any Champions VOD from a laptop
// (or Claude Code on the web), no capture hardware and no 17GB of local fixtures.
// Output layout mirrors record.ts (fixtures/yt/<id>/frame_NNNNN.png) so read-battle.ts
// consumes it unchanged.
//
//   npm run -w @pokechamps/vision youtube -- <url> [--fps 2] [--start 1:30] [--end 4:00] [--dir name] [--read]
//   then: npx tsx packages/vision/scripts/read-battle.ts packages/vision/fixtures/yt/<id>
//   (--read chains read-battle automatically when the extract finishes.)
//
// Needs yt-dlp — found on PATH or via `python -m yt_dlp` (install: `pip install yt-dlp`).
// ffmpeg is bundled (ffmpeg-static), so nothing else to install. The regions are
// calibrated for CLEAN full-screen 1080p gameplay; facecams / stream overlays shift
// the normalized boxes — sanity-check a frame with find-banner.ts before trusting OCR.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const url = argv.find(a => !a.startsWith('--'));
const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const has = (k: string) => argv.includes(k);

if (!url) {
  console.error('usage: youtube <url> [--fps N] [--start MM:SS] [--end MM:SS] [--dir name] [--read]');
  process.exit(1);
}

// Locate yt-dlp: a PATH binary first, else the pip module via python. Returns the
// command + the leading args that turn it into a yt-dlp invocation.
function resolveYtDlp(): { cmd: string; pre: string[] } | null {
  if (spawnSync('yt-dlp', ['--version'], { stdio: 'ignore' }).status === 0) return { cmd: 'yt-dlp', pre: [] };
  for (const py of ['python', 'python3', 'py']) {
    if (spawnSync(py, ['-m', 'yt_dlp', '--version'], { stdio: 'ignore' }).status === 0) return { cmd: py, pre: ['-m', 'yt_dlp'] };
  }
  return null;
}

// "v=ID" or "youtu.be/ID" → ID, for a stable per-video fixture dir.
function videoId(u: string): string | null {
  return (/[?&]v=([\w-]{6,})/.exec(u) ?? /youtu\.be\/([\w-]{6,})/.exec(u) ?? /\/shorts\/([\w-]{6,})/.exec(u))?.[1] ?? null;
}

const yt = resolveYtDlp();
if (!yt) {
  console.error('[youtube] yt-dlp not found. Install it with:  pip install yt-dlp   (or put yt-dlp on PATH)');
  process.exit(1);
}

const fps = Number(arg('--fps') ?? 2);
const start = arg('--start'), end = arg('--end');
const id = arg('--dir') ?? videoId(url) ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = resolve(join(here, `../fixtures/yt/${id}`));
mkdirSync(dir, { recursive: true });

// Download VIDEO ONLY (no audio → no merge/remux step, so the output codec/container
// never matters; ffmpeg decodes whatever it is for frames). Cap at 1080p to match the
// calibration resolution. --download-sections trims to the match if start/end given.
const sections = (start || end) ? ['--download-sections', `*${start ?? '0:00'}-${end ?? 'inf'}`] : [];
console.error(`[youtube] downloading via ${yt.cmd} ${yt.pre.join(' ')} -> ${dir}`);
const dl = spawnSync(yt.cmd, [
  ...yt.pre, '--no-playlist', '--ffmpeg-location', String(ffmpegPath),
  '-f', 'bv*[height<=1080]/b[height<=1080]/b',
  ...sections, '-o', join(dir, '_vod.%(ext)s'), url,
], { stdio: 'inherit' });
if (dl.status !== 0) { console.error('[youtube] download failed'); process.exit(dl.status ?? 1); }

const vod = readdirSync(dir).filter(f => f.startsWith('_vod.')).map(f => join(dir, f))[0];
if (!vod) { console.error('[youtube] no downloaded file found'); process.exit(1); }

// Extract frames at the requested cadence, normalized to 1080p so OCR scale + region
// boxes match the dongle calibration. (Regions are normalized so other 16:9 sizes also
// work, but pinning 1080p keeps tesseract's input identical to the calibrated case.)
console.error(`[youtube] extracting frames @ ${fps}fps`);
const ex = spawnSync(String(ffmpegPath), [
  '-hide_banner', '-loglevel', 'warning', '-y',
  '-i', vod, '-vf', `fps=${fps},scale=1920:1080:flags=bicubic`,
  join(dir, 'frame_%05d.png'),
], { stdio: 'inherit' });
if (ex.status !== 0) { console.error('[youtube] frame extraction failed'); process.exit(ex.status ?? 1); }

const frames = readdirSync(dir).filter(f => /^frame_\d+\.png$/.test(f)).length;
console.error(`[youtube] ${frames} frames -> ${dir}`);

if (has('--read')) {
  console.error('[youtube] running read-battle…\n');
  spawnSync('npx', ['tsx', join(here, 'read-battle.ts'), dir], { stdio: 'inherit', shell: process.platform === 'win32' });
} else {
  console.error(`[youtube] next:  npx tsx packages/vision/scripts/read-battle.ts ${join('packages/vision/fixtures/yt', id)}`);
}
