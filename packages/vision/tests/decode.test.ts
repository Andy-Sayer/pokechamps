import { describe, test, expect } from 'vitest';
import { Jimp } from 'jimp';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFrame } from '../src/decode.js';

describe('loadFrame', () => {
  test('decodes a PNG into an RGBA Frame with correct dims + pixels', async () => {
    // Build a known 4×2 image (black) with one red pixel, save, reload.
    const img = new Jimp({ width: 4, height: 2, color: 0x000000ff });
    img.setPixelColor(0xff0000ff, 1, 0);
    const p = join(tmpdir(), `vision-decode-${Date.now()}.png`);
    await img.write(p as `${string}.png`);

    const f = await loadFrame(p);
    expect(f.width).toBe(4);
    expect(f.height).toBe(2);
    expect(f.data.length).toBe(4 * 2 * 4);          // RGBA
    const i = (0 * 4 + 1) * 4;                        // pixel (x=1, y=0)
    expect([f.data[i], f.data[i + 1], f.data[i + 2], f.data[i + 3]]).toEqual([255, 0, 0, 255]);
  });
});
