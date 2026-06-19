import { Jimp } from 'jimp';
import type { Frame } from './types.js';
import type { FrameGrabber } from './frameGrabber.js';

/** Decode a PNG/JPG file into a Frame (RGBA). In-stack via jimp (pure JS, no
 *  native build). Used for dev/calibration against saved screenshots and by
 *  FileFrameGrabber. */
export async function loadFrame(path: string): Promise<Frame> {
  const img = await Jimp.read(path);
  return {
    width: img.bitmap.width,
    height: img.bitmap.height,
    data: new Uint8ClampedArray(img.bitmap.data),   // jimp bitmap is RGBA
    ts: Date.now(),
  };
}

/** Replays image files from disk as frames — a recorded sequence for dev, or a
 *  single frame for region calibration. Swap for UvcFrameGrabber on real capture. */
export class FileFrameGrabber implements FrameGrabber {
  private i = 0;
  constructor(private readonly paths: string[]) {}
  async next(): Promise<Frame | null> {
    const p = this.paths[this.i++];
    return p ? await loadFrame(p) : null;
  }
}
