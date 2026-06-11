// Sprite pipeline (Theme 6): PNG decode → nearest-neighbour downsample →
// palette quantise → strip compose. All offline — network fetch is exercised
// by scripts/preview-sprites.ts, the visual-iteration tool.
import { describe, test, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodePng } from '../src/ui/png.js';
import { downsample, quantise } from '../src/ui/spriteCache.js';
import { composeStrip } from '../src/ui/spriteStrip.js';

// Build a minimal non-interlaced 8-bit RGBA PNG in-memory. The decoder skips
// CRC validation, so chunks carry zero CRCs.
function makePng(width: number, height: number, rgba: number[]): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: None
    raw.set(rgba.slice(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  }
  const idat = new Uint8Array(deflateSync(Buffer.from(raw)));
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]);
}

const R = [255, 0, 0, 255], B = [0, 0, 255, 255], T = [0, 0, 0, 0];

describe('png decoder', () => {
  test('round-trips a 2x2 RGBA image', () => {
    const png = makePng(2, 2, [...R, ...B, ...T, ...R]);
    const d = decodePng(png);
    expect([d.width, d.height]).toEqual([2, 2]);
    expect([...d.rgba.slice(0, 4)]).toEqual(R);
    expect([...d.rgba.slice(4, 8)]).toEqual(B);
    expect(d.rgba[11]).toBe(0); // transparent pixel's alpha
  });

  test('rejects non-PNG input', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow();
  });
});

describe('downsample + quantise', () => {
  test('2:1 nearest-neighbour keeps palette colours and transparency', () => {
    // 4x2: left 2x2 block red-dominant, right block fully transparent.
    const rgba = new Uint8Array([...R, ...R, ...T, ...T, ...R, ...B, ...T, ...T]);
    const small = downsample(4, 2, rgba);
    expect([small.width, small.height]).toEqual([2, 1]);
    expect([...small.rgba.slice(0, 4)]).toEqual(R); // first opaque pick
    expect(small.rgba[7]).toBe(0);                  // transparent block stays empty
    const sprite = quantise(small.width, small.height, small.rgba)!;
    expect(sprite.palette.colors).toEqual([[255, 0, 0]]);
    expect(sprite.bitmap.pixels).toEqual([1, 0]);
  });
});

describe('composeStrip', () => {
  test('concatenates with a shared deduped palette and a gap', () => {
    const a = quantise(1, 1, new Uint8Array(R))!;
    const b = quantise(1, 1, new Uint8Array(R))!;
    const strip = composeStrip([a, b])!;
    expect(strip.bitmap.width).toBe(1 + 4 + 1); // GAP = 4
    expect(strip.palette.colors).toEqual([[255, 0, 0]]); // deduped
    expect(strip.bitmap.pixels[0]).toBe(1);
    expect(strip.bitmap.pixels[5]).toBe(1);
    expect(strip.bitmap.pixels[2]).toBe(0); // gap transparent
  });
});
