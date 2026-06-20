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

import { spawn } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
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

const ff = spawn(ffmpegPath as unknown as string, [
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
], { stdio: ['ignore', 'pipe', 'pipe'] });

// Explain a device-busy quick exit instead of letting it look like a crash.
const started = Date.now();
let tail = '';
ff.stderr?.on('data', (b: Buffer) => { process.stderr.write(b); tail = (tail + b.toString()).slice(-4000); });
ff.on('exit', (code) => {
  if (code && (Date.now() - started < 2500 || /I\/O error|Could not run graph|in use/i.test(tail))) {
    console.error('\n[serve] ffmpeg exited immediately — the capture device is busy.');
    console.error('[serve] Close Windows Camera / OBS and end any Discord/Teams/Zoom webcam call, then retry.');
    console.error(`[serve] (device: "${DEVICE}" — override with PC_CAPTURE_DEVICE=...)`);
  }
  process.exit(code ?? 0);
});

// Fan ffmpeg's mpjpeg stdout out to every connected /stream client. New clients
// join mid-stream and resync at the next JPEG boundary — browsers handle that.
const clients = new Set<ServerResponse>();
ff.stdout!.on('data', (chunk: Buffer) => { for (const c of clients) c.write(chunk); });

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

process.on('SIGINT', () => { ff.kill('SIGINT'); process.exit(0); });
