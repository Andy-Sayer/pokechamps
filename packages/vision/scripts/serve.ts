// Robust browser viewer + frame tap from the HDMI capture dongle.
//
// ffmpeg is the SINGLE (exclusive) device owner. It fans the one handle into:
//   (a) a 4fps latest.png the read pipeline polls, and
//   (b) an MJPEG multipart stream this tiny HTTP server relays to the browser.
// The browser <img> is a real, movable, resizable, crash-proof window — unlike
// ffmpeg's -f sdl previewer (which renders black / crashes on drag / ignores the
// target monitor). ffmpeg keeps running regardless of browser connects, so
// closing/refreshing the tab never disturbs capture. See project_capture_hardware.
//
//   npm run -w @pokechamps/vision serve
//   -> open http://localhost:8099 in a browser; double-click the image for fullscreen.
//
//   -- --mjpeg-in     read the device as MJPEG (USB2 / bandwidth-starved link)
//   -- --port 9000    listen port (or PC_CAPTURE_PORT)
//   PC_CAPTURE_DEVICE="Other Name"   override the device name

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';

const DEVICE = process.env.PC_CAPTURE_DEVICE ?? 'Guermok USB3 Video';
const argv = process.argv.slice(2);
const mjpegIn = argv.includes('--mjpeg-in');
const portIdx = argv.indexOf('--port');
const PORT = Number(portIdx >= 0 ? argv[portIdx + 1] : process.env.PC_CAPTURE_PORT ?? '8099');
const fpsIdx = argv.indexOf('--fps');
const FPS = String(Number(fpsIdx >= 0 ? argv[fpsIdx + 1] : 30));   // capture + view fps
const BOUNDARY = 'pokeframe';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/live/latest.png');
mkdirSync(dirname(out), { recursive: true });

const FF_ARGS = [
  '-hide_banner', '-loglevel', 'warning',
  // Low-latency input: low fps is plenty for a menu game (less data + CPU than 60),
  // a small rtbuf drops stale frames instead of queuing them, nobuffer = no extra
  // input buffering. Capture fps matches the view fps so no frames are dropped.
  '-f', 'dshow', '-framerate', FPS, '-rtbufsize', '64M', '-fflags', 'nobuffer',
  ...(mjpegIn ? ['-vcodec', 'mjpeg'] : ['-pixel_format', 'yuyv422']),
  '-video_size', '1920x1080',
  '-i', `video=${DEVICE}`,
  // (a) tap for the read pipeline — keep FULL 1080p so OCR/region accuracy is intact
  '-map', '0:v', '-r', '4', '-update', '1', '-y', out,
  // (b) MJPEG multipart stream to stdout for the browser — scaled to 720p for a
  // smooth, low-latency view (the view doesn't need full res; the tap has it).
  '-map', '0:v', '-s', '1280x720', '-c:v', 'mjpeg', '-q:v', '7', '-r', FPS,
  '-f', 'mpjpeg', '-boundary_tag', BOUNDARY, 'pipe:1',
];

// Fan ffmpeg's mpjpeg stdout to every connected /stream client. The client set
// PERSISTS across ffmpeg restarts — browsers join mid-stream and resync at the
// next JPEG boundary, so an ffmpeg respawn never needs a manual page reload.
const clients = new Set<ServerResponse>();

// AUTO-RECOVER. ffmpeg fails two ways: it EXITS (device busy / crash) and it
// STALLS (stays alive but stops emitting frames when the HDMI/GameShare input
// blips — both the tap and the MJPEG stream freeze). On exit we respawn with
// backoff; a watchdog kills+respawns it when the tap stops advancing. The HTTP
// server stays up throughout, so the feed self-heals without a restart.
let ff: ChildProcess | null = null;
let ffStartedAt = 0;
let shuttingDown = false;
let consecutiveFast = 0;

function startFfmpeg(): void {
  if (shuttingDown) return;
  ffStartedAt = Date.now();
  let tail = '';
  const proc = spawn(ffmpegPath as unknown as string, FF_ARGS, { stdio: ['ignore', 'pipe', 'pipe'] });
  ff = proc;
  proc.stderr?.on('data', (b: Buffer) => { process.stderr.write(b); tail = (tail + b.toString()).slice(-4000); });
  proc.stdout!.on('data', (chunk: Buffer) => { for (const c of clients) c.write(chunk); });
  proc.on('error', () => { /* spawn failure surfaces via the exit handler's retry */ });
  proc.on('exit', (code) => {
    if (ff === proc) ff = null;
    if (shuttingDown) return;
    consecutiveFast = Date.now() - ffStartedAt < 2500 ? consecutiveFast + 1 : 0;
    const busy = /I\/O error|Could not run graph|in use/i.test(tail);
    const delay = Math.min(10_000, 500 * 2 ** Math.min(consecutiveFast, 4));
    console.error(busy
      ? `[serve] capture device busy (close Camera/OBS/Discord webcam holding "${DEVICE}") — retrying in ${delay}ms…`
      : `[serve] ffmpeg exited (code ${code}) — restarting in ${delay}ms…`);
    setTimeout(startFfmpeg, delay);
  });
}

// Stall watchdog: once ffmpeg is past warm-up, if the 1080p tap hasn't advanced
// in STALL_MS the input froze — kill ffmpeg so the exit handler respawns it.
const STALL_MS = 5000, WARMUP_MS = 6000;
setInterval(() => {
  if (!ff || shuttingDown || Date.now() - ffStartedAt < WARMUP_MS) return;
  try {
    const age = Date.now() - statSync(out).mtimeMs;
    if (age > STALL_MS) { console.error(`[serve] feed stalled (${(age / 1000).toFixed(0)}s — input blip) — restarting ffmpeg…`); ff.kill(); }
  } catch { /* tap not written yet */ }
}, 3000);

startFfmpeg();

const PAGE = `<!doctype html><meta charset="utf-8"><title>PokeChamps — Switch feed</title>
<style>html,body{margin:0;background:#000;height:100%;overflow:hidden}
img{width:100%;height:100%;object-fit:contain;display:block;cursor:pointer}</style>
<img id="v" src="/stream" alt="Switch feed">
<script>document.getElementById('v').addEventListener('dblclick',e=>{
  if(document.fullscreenElement)document.exitFullscreen();else e.target.requestFullscreen();});</script>`;

createServer((req, res) => {
  if (req.url === '/stream') {
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace;boundary=${BOUNDARY}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    });
    res.socket?.setNoDelay(true);   // no Nagle — push frames out immediately
    clients.add(res);
    req.on('close', () => clients.delete(res));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.error(`[serve] device="${DEVICE}" ${mjpegIn ? 'mjpeg' : 'raw yuyv422'} 1080p -> tap ${out}`);
  console.error(`[serve] OPEN http://localhost:${PORT} in a browser (double-click image = fullscreen). Ctrl+C to stop.`);
});

process.on('SIGINT', () => { shuttingDown = true; ff?.kill('SIGINT'); process.exit(0); });
