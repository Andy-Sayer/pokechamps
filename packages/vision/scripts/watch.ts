// Live preview + frame tap from the HDMI capture dongle, in ONE ffmpeg process.
// The UVC device is EXCLUSIVE — only one app may hold it — so we can't run a
// separate viewer (Windows Camera/OBS) AND capture. This opens a single device
// handle and fans it out: an SDL window so you can WATCH the Switch, plus a
// continuously-overwritten latest.png the read pipeline polls. See
// project_capture_hardware in memory for the device facts.
//
//   npm run -w @pokechamps/vision watch              # 1080p raw + preview window
//   npm run -w @pokechamps/vision watch -- --mjpeg   # compressed: USB2 / glitchy link
//   npm run -w @pokechamps/vision watch -- --no-preview            # headless tap only
//   npm run -w @pokechamps/vision watch -- --at -1920,0 --fullscreen  # game on monitor 2
//   PC_CAPTURE_DEVICE="Other Name" npm run -w @pokechamps/vision watch
//
// IMPORTANT: ffmpeg's -f sdl is a bare previewer — DRAGGING/RESIZING it crashes
// ffmpeg. Use --fullscreen (optionally --at X,Y to pick a monitor) so there is
// nothing to grab; then never click it. Watch on one screen, run the TUI on the
// other. Press q in the window (or Ctrl+C here) to stop. Clean color bars = the
// dongle has NO HDMI input lock (check dock HDMI-OUT -> dongle HDMI-IN, Switch on;
// NOT HDCP, which would be black/noise).

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';

const DEVICE = process.env.PC_CAPTURE_DEVICE ?? 'Guermok USB3 Video';
const argv = process.argv.slice(2);
const mjpeg = argv.includes('--mjpeg');
const preview = !argv.includes('--no-preview');
const fullscreen = argv.includes('--fullscreen');
const atIdx = argv.indexOf('--at');
const at = atIdx >= 0 ? argv[atIdx + 1]!.split(',').map(Number) : null; // [x, y] monitor origin
const outIdx = argv.indexOf('--out');
// Default path is anchored to THIS script's location, not cwd — npm workspace
// scripts run with cwd=packages/vision, so a repo-root-relative default doubled up.
const defaultOut = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/live/latest.png');
const out = outIdx >= 0 ? resolve(argv[outIdx + 1]!) : defaultOut;
mkdirSync(dirname(out), { recursive: true });

// One input (single exclusive device handle). MJPEG is compressed — survives a
// bandwidth-starved link at the cost of OCR-hurting artifacts; raw yuyv422 is the
// clean default.
const input = [
  '-f', 'dshow',
  '-rtbufsize', '256M',
  ...(mjpeg ? ['-vcodec', 'mjpeg'] : ['-pixel_format', 'yuyv422']),
  '-video_size', '1920x1080',
  '-i', `video=${DEVICE}`,
];
// Frame tap: throttle to 4fps and keep overwriting a single file for pollers.
const tap = ['-map', '0:v', '-r', '4', '-update', '1', '-y', out];
// Live window from the same handle (omit with --no-preview). SDL needs a format
// it can blit — yuv420p; handing it raw YUY2 throws "Operation not permitted".
// --at places the window on a given monitor's origin; SDL fullscreens on whichever
// monitor the window sits on, so --at + --fullscreen pins the game to one screen.
const win = preview
  ? [
      '-map', '0:v', '-pix_fmt', 'yuv420p',
      ...(at && at.length === 2 && at.every(Number.isFinite)
        ? ['-window_x', String(at[0]), '-window_y', String(at[1])]
        : []),
      ...(fullscreen ? ['-window_fullscreen', '1'] : []),
      '-f', 'sdl', 'PokeChamps — Switch feed',
    ]
  : [];

const args = ['-hide_banner', ...input, ...tap, ...win];
console.error(`[watch] device="${DEVICE}" ${mjpeg ? 'mjpeg' : 'raw yuyv422'} 1080p` +
  `${preview ? ' + preview window' : ' (headless)'} -> ${out}`);

// Capture stderr (still echo it) so a fast exit can be explained instead of
// looking like a silent crash. The #1 cause is the device being held by another
// app (Windows Camera, OBS, a Discord/Teams/Zoom call) — a busy UVC device makes
// ffmpeg exit instantly with an I/O error.
const started = Date.now();
let tail = '';
const ff = spawn(ffmpegPath as unknown as string, args, { stdio: ['ignore', 'ignore', 'pipe'] });
ff.stderr?.on('data', (b: Buffer) => { process.stderr.write(b); tail = (tail + b.toString()).slice(-4000); });
process.on('SIGINT', () => ff.kill('SIGINT'));
ff.on('exit', (code) => {
  const quick = Date.now() - started < 2000;
  if (code && (quick || /I\/O error|Could not run graph|device.*in use/i.test(tail))) {
    console.error('\n[watch] ffmpeg exited immediately — this is almost always the capture');
    console.error('[watch] device being held by another app. Close Windows Camera / OBS, and');
    console.error('[watch] end any Discord/Teams/Zoom call using the webcam, then retry.');
    console.error(`[watch] (device: "${DEVICE}" — override with PC_CAPTURE_DEVICE=...)`);
  }
  process.exit(code ?? 0);
});
