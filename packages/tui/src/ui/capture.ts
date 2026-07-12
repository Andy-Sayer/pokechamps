// Module-level singleton for the HDMI capture SERVER — the ffmpeg process that OWNS the exclusive
// UVC dongle, writes the 4fps latest.png tap the read pipeline polls, and serves the MJPEG browser
// viewer. "Turn on screen" on the main menu toggles this; once it's on, the watcher (read-live) and
// Ctrl+R reads have frames to work with, so you no longer need a second terminal running
// `npm run -w @pokechamps/vision serve`.
//
// It spawns serve.ts as its OWN child (like watcher.ts spawns read-live) rather than running ffmpeg
// in-process: the device handle + ffmpeg's chatty stderr stay isolated from the Ink render, and a
// crash can't take the TUI down. Only ONE capture child ever runs.
//
// "On" means FRAMES ARE FLOWING, not merely "serve launched": we poll the tap's mtime. serve's HTTP
// server binds even with no dongle attached, so a naive "server up" signal would lie — a stale tap
// after warm-up is surfaced as `no-signal` (device busy, or no HDMI lock → color bars). serve auto-
// recovers ffmpeg internally; this layer auto-respawns serve itself on an unexpected exit.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type CaptureState = 'off' | 'starting' | 'on' | 'no-signal';

const TAP = fileURLToPath(new URL('../../../vision/fixtures/live/latest.png', import.meta.url));
const SERVE = fileURLToPath(new URL('../../../vision/scripts/serve.ts', import.meta.url));
const VIEWER_URL = `http://localhost:${process.env.PC_CAPTURE_PORT ?? '8099'}`;

const FRESH_MS = 4000;    // tap younger than this ⇒ frames are flowing ⇒ 'on'
const WARMUP_MS = 8000;   // grace before a stale tap counts as 'no-signal'
const POLL_MS = 2000;

let proc: ChildProcess | null = null;
let intended = false;        // do we WANT capture on? a deliberate stop clears it → no respawn
let external = false;        // adopted a capture we did NOT spawn (user's own serve) — never kill it
let state: CaptureState = 'off';
let busyHint = false;        // saw a device-busy line on serve's stderr — enriches the status text
let respawns = 0;
let startedAt = 0;
let poll: ReturnType<typeof setInterval> | null = null;
let openedViewer = false;

const stateCbs = new Set<(s: CaptureState) => void>();
function setState(s: CaptureState): void { if (s !== state) { state = s; for (const cb of stateCbs) cb(s); } }

export function captureState(): CaptureState { return state; }
export function isCapturing(): boolean { return state !== 'off'; }
export function onCaptureChange(cb: (s: CaptureState) => void): () => void { stateCbs.add(cb); return () => { stateCbs.delete(cb); }; }
export function viewerUrl(): string { return VIEWER_URL; }

/** One-line status for the header badge (null when off). */
export function captureStatusText(): string | null {
  switch (state) {
    case 'off': return null;
    case 'starting': return '◌ screen starting…';
    case 'on': return `● screen on — ${VIEWER_URL} (browser view)`;
    case 'no-signal': return busyHint
      ? '▲ screen: capture device busy — close Camera/OBS/Discord, or unplug/replug the dongle'
      : '▲ screen: no signal — check dongle HDMI-IN + that the Switch is on (color bars = no lock)';
  }
}

/** Open the MJPEG viewer in the default browser (best-effort, once per start). The TUI is a
 *  terminal — the browser tab is where you actually WATCH the Switch. */
function openViewer(): void {
  if (openedViewer || process.env.PC_CAPTURE_NO_OPEN) return;   // opt out of the browser pop
  openedViewer = true;
  try {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', VIEWER_URL]]
      : process.platform === 'darwin' ? ['open', [VIEWER_URL]]
      : ['xdg-open', [VIEWER_URL]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch { /* best-effort — the URL is in the badge regardless */ }
}

/** Is the tap advancing right now? True ⇒ SOME capture is already feeding frames (this app's, or a
 *  serve the user launched in a terminal). The tap updates at 4fps even on a static game screen. */
function tapFresh(): boolean {
  try { return Date.now() - statSync(TAP).mtimeMs < FRESH_MS; } catch { return false; }
}

function stopPoll(): void { if (poll) { clearInterval(poll); poll = null; } }

function startPoll(): void {
  stopPoll();
  poll = setInterval(() => {
    if (!proc || !intended) return;
    let age = Infinity;
    try { age = Date.now() - statSync(TAP).mtimeMs; } catch { /* tap not written yet */ }
    if (age < FRESH_MS) setState('on');
    else if (Date.now() - startedAt > WARMUP_MS) setState('no-signal');
  }, POLL_MS);
}

function launch(): ChildProcess | null {
  let p: ChildProcess;
  try {
    p = spawn(process.execPath, ['--import', 'tsx', SERVE], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch { return null; }
  startedAt = Date.now();
  busyHint = false;
  // serve logs to stderr: "[serve] OPEN http://…" once the HTTP server is up (open the viewer then),
  // and device-busy lines when ffmpeg can't grab the dongle.
  if (p.stderr) createInterface({ input: p.stderr }).on('line', line => {
    if (proc !== p) return;
    if (/OPEN http/i.test(line)) openViewer();
    if (/device busy|in use|I\/O error/i.test(line)) busyHint = true;
  });
  const onGone = (): void => {
    if (proc !== p) return;                          // superseded / double-fire (error then exit)
    proc = null;
    const uptime = Date.now() - startedAt;
    if (uptime > 60_000) respawns = 0;               // a stable run refills the respawn budget
    if (intended && respawns < 30) {                 // unexpected exit while still wanted → respawn
      respawns++;
      setState('starting');
      setTimeout(() => { if (intended && !proc) { proc = launch(); startPoll(); } }, 1_500);
    } else { intended = false; stopPoll(); setState('off'); }
  };
  p.on('error', onGone);
  p.on('exit', onGone);
  return p;
}

/** Start the capture server (no-op if already on). If a capture is ALREADY feeding the tap — a
 *  serve the user launched in a terminal — adopt it instead of spawning a competitor that would
 *  fight for the exclusive dongle + the :8099 port. Returns a short status string. */
export function startCapture(): string {
  if (proc || external) return 'screen already on';
  intended = true; respawns = 0; openedViewer = false;
  if (tapFresh()) {                                   // someone's already capturing → adopt, don't spawn
    external = true; openViewer(); startPoll(); setState('on');
    return 'screen already live (adopted an existing capture)';
  }
  setState('starting');
  proc = launch();
  if (!proc) { intended = false; setState('off'); return "couldn't launch the capture server"; }
  startPoll();
  return 'turning on the screen…';
}

/** Stop the capture server and release the dongle. Tree-kills on Windows so the ffmpeg GRANDCHILD
 *  (spawned by serve) can't orphan and keep holding the exclusive device. An ADOPTED external
 *  capture is only detached (we didn't start it, so we don't kill it). */
export function stopCapture(): void {
  intended = false;
  stopPoll();
  if (external) { external = false; setState('off'); return; }   // detach only — leave the user's serve running
  const p = proc; proc = null;
  if (p?.pid) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/t', '/f'], { stdio: 'ignore' });
      else p.kill();
    } catch { /* already gone */ }
  }
  setState('off');
}

// Never leave an ffmpeg holding the dongle after the TUI exits.
process.once('exit', () => { if (proc) stopCapture(); });
