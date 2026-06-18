import type { Frame } from './types.js';

/** Source of capture frames. The vision loop calls next() repeatedly (~2-5 fps). */
export interface FrameGrabber {
  next(): Promise<Frame | null>;   // null = stream ended
  close?(): void | Promise<void>;
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
