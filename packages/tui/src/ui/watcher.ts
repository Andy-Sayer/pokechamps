// Module-level singleton for the live turn-watcher (read-live child process). Lives ABOVE the
// individual screens so it survives the opponent → bring → lead → battle route changes: starting
// it at team-select means it's warmed up when the game sends the leads out, catching the opening
// (Intimidate before turn 1) a battle-mount start would miss. Screens subscribe to proposals /
// watching-state; only ONE child ever runs.
//
// SELF-HEALING: read-live has an internal watchdog that exit(3)s if its loop ever wedges with no
// forward progress. This module AUTO-RESPAWNS on any unexpected exit while still intended to be
// watching, so a freeze recovers itself (~2s gap) instead of needing the user to re-toggle. A
// deliberate stopWatch() clears the intent → no respawn. Backoff + uptime guard avoid hot-looping
// when serve is down.
//
// NOTE: `--debug` (the trace/PNG dump) is OFF by default — it's a diagnostic, and its file writes
// are pure liability during normal play. Pass { debug: true } only when actively diagnosing.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export interface WatchProposal { lines: string[]; confidence?: number; partial?: boolean }
export interface WatchOpts { leads?: string[]; full?: boolean; debug?: boolean }

let proc: ChildProcess | null = null;
let intended = false;          // do we WANT to be watching? deliberate stop clears it → no respawn
let lastOpts: WatchOpts = {};
let respawns = 0;
const propCbs = new Set<(p: WatchProposal) => void>();
const stateCbs = new Set<(watching: boolean) => void>();
const emitState = () => { for (const cb of stateCbs) cb(proc != null); };

export function isWatching(): boolean { return proc != null; }
export function onProposal(cb: (p: WatchProposal) => void): () => void { propCbs.add(cb); return () => { propCbs.delete(cb); }; }
export function onWatchingChange(cb: (watching: boolean) => void): () => void { stateCbs.add(cb); return () => { stateCbs.delete(cb); }; }

function launch(opts: WatchOpts): ChildProcess | null {
  let p: ChildProcess;
  try {
    const readLive = fileURLToPath(new URL('../../../vision/scripts/read-live.ts', import.meta.url));
    const flags = [readLive];
    if (opts.leads?.length) flags.push('--leads', opts.leads.join(','));
    if (opts.full) flags.push('--full');
    if (opts.debug) flags.push('--debug');
    p = spawn(process.execPath, ['--import', 'tsx', ...flags], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { return null; }
  const startedAt = Date.now();
  const onGone = (): void => {
    if (proc !== p) return;                         // superseded / double-fire (error then exit)
    proc = null; emitState();
    const uptime = Date.now() - startedAt;
    if (uptime > 60_000) respawns = 0;              // a stable run refills the respawn budget
    // Respawn on an UNEXPECTED exit (watchdog exit(3) or crash) while still intended. Only if it
    // ran a while — a <3s exit is a spawn failure / serve-not-up, which we must NOT hot-loop.
    if (intended && uptime > 3_000 && respawns < 30) {
      respawns++;
      setTimeout(() => { if (intended && !proc) { proc = launch(lastOpts); emitState(); } }, 1_500);
    }
  };
  p.on('error', onGone);
  p.on('exit', onGone);
  const rl = createInterface({ input: p.stdout! });
  rl.on('line', (line) => {
    const s = line.trim();
    if (s[0] !== '{') return;
    try { const parsed = JSON.parse(s) as WatchProposal; if (Array.isArray(parsed.lines) && parsed.lines.length) for (const cb of propCbs) cb(parsed); }
    catch { /* partial/garbled line */ }
  });
  return p;
}

/** Start the reader (no-op if already running). `leads` are `m1=Species` strings (optional —
 *  read-live rebuilds its roster from the send-out banners if omitted). Returns a status. */
export function startWatch(opts: WatchOpts = {}): string {
  if (proc) return 'already watching';
  intended = true; lastOpts = opts; respawns = 0;
  proc = launch(opts);
  if (!proc) { intended = false; return "couldn't launch the reader"; }
  emitState();
  return `watching${opts.full ? ' (full frame)' : ''}`;
}

export function stopWatch(): void {
  intended = false;                                 // deliberate stop → no respawn
  const p = proc; proc = null;
  if (p) { try { p.kill(); } catch { /* already gone */ } }
  emitState();
}
