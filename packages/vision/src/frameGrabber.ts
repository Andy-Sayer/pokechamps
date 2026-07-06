import { statSync } from 'node:fs';
import type { Frame } from './types.js';
import { loadFrame } from './decode.js';

/** Source of capture frames. The vision loop calls next() repeatedly (~2-5 fps). */
export interface FrameGrabber {
  next(): Promise<Frame | null>;   // null = stream ended
  close?(): void | Promise<void>;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`loadFrame timed out after ${ms}ms`)), ms).unref?.())]);

/** Polls serve.ts's single continuously-overwritten PNG tap (`latest.png`) and
 *  yields each NEW frame (dedup by mtime). It only READS the file, so it runs
 *  alongside the serve process that owns the capture device. `next()` blocks
 *  until a fresh, complete frame is available (torn mid-writes are retried), or
 *  returns null once `stop()` is true. */
export class LatestTapGrabber implements FrameGrabber {
  private lastMtime = 0;
  private stopped = false;
  constructor(
    private readonly path: string,
    private readonly opts: { pollMs?: number; stop?: () => boolean; loadTimeoutMs?: number } = {},
  ) {}
  async next(): Promise<Frame | null> {
    const pollMs = this.opts.pollMs ?? 200;
    while (!this.stopped && !this.opts.stop?.()) {
      let mt = 0;
      try { mt = statSync(this.path).mtimeMs; } catch { /* tap not written yet */ }
      if (mt && mt !== this.lastMtime) {
        try {
          // Timeout guards a decode that HANGS on a heavy/torn frame — without it a single bad
          // frame freezes the whole watch loop (this was the "doesn't keep rolling" stall).
          const frame = await withTimeout(loadFrame(this.path), this.opts.loadTimeoutMs ?? 4000);
          this.lastMtime = mt;
          return frame;
        } catch { /* torn mid-write OR slow/hung decode — skip, retry the next (newer) frame */ }
      }
      await sleep(pollMs);
    }
    return null;
  }
  close(): void { this.stopped = true; }
}

/** Replays a fixed list of frames once — tests + dev against saved screenshots. */
export class StaticFrameGrabber implements FrameGrabber {
  private i = 0;
  constructor(private readonly frames: Frame[]) {}
  async next(): Promise<Frame | null> { return this.frames[this.i++] ?? null; }
}

// TODO(hardware): real capture. Switch 2 dock HDMI → a USB-C UVC capture dongle
// (~$30) shows up as a webcam; decode RGBA frames in-stack (a JS/WASM capture lib,
// or an ffmpeg pipe reading the UVC device). PRE-FLIGHT: confirm Switch 2 gameplay
// is not HDCP-protected (the original Switch never protected games — almost
// certainly fine, but verify before buying). Sample at ~2-5 fps, not per-frame.
export class UvcFrameGrabber implements FrameGrabber {
  async next(): Promise<Frame | null> {
    throw new Error('UvcFrameGrabber not implemented — wire a JS capture source (see TODO).');
  }
}
