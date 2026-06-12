// Sprite pipeline (Theme 6): PNG decode → palette quantise (native sixel
// variant) / area-resize (half-block variant) → strip compose. All offline —
// network fetch is exercised by scripts/preview-sprites.ts, the iteration tool.
import { describe, test, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodePng } from '../src/ui/png.js';
import { quantise, areaResize } from '../src/ui/spriteCache.js';
import { composeStrip } from '../src/ui/spriteStrip.js';
import { halfBlockRows } from '../src/ui/HalfBlockImage.js';

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

describe('quantise', () => {
  test('builds a 1-based palette with 0 for transparency', () => {
    const rgba = new Uint8Array([...R, ...B, ...T, ...R]);
    const sprite = quantise(2, 2, rgba)!;
    expect(sprite.palette.colors).toEqual([[255, 0, 0], [0, 0, 255]]);
    expect(sprite.bitmap.pixels).toEqual([1, 2, 0, 1]);
  });
});

describe('half-block fallback renderer', () => {
  test('two pixel rows fold into ▀/▄/space segments with run-merging', () => {
    // 2x2: top row red,red — bottom row transparent,blue.
    const bitmap = { width: 2, height: 2, pixels: [1, 1, 0, 2] };
    const palette = { colors: [[255, 0, 0], [0, 0, 255]] as [number, number, number][] };
    const rows = halfBlockRows(bitmap, palette);
    expect(rows).toHaveLength(1);
    // Col 0: top red only → ▀ fg red; col 1: red over blue → ▀ fg red bg blue.
    expect(rows[0]).toEqual([
      { ch: '▀', fg: '#ff0000', bg: undefined },
      { ch: '▀', fg: '#ff0000', bg: '#0000ff' },
    ]);
    // Bottom-only pixel renders ▄; fully transparent renders space.
    const rows2 = halfBlockRows({ width: 2, height: 2, pixels: [0, 0, 2, 0] }, palette);
    expect(rows2[0]).toEqual([{ ch: '▄', fg: '#0000ff', bg: undefined }, { ch: ' ', fg: undefined, bg: undefined }]);
  });

  test('areaResize: solid regions stay solid (no pinholes), aspect preserved', () => {
    // 4x4 fully red → resize to height 2: every output pixel opaque red.
    const red = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) red.set([255, 0, 0, 255], i * 4);
    const r = areaResize(4, 4, red, 2);
    expect([r.width, r.height]).toEqual([2, 2]);
    for (let i = 0; i < 4; i++) {
      expect([...r.rgba.slice(i * 4, i * 4 + 4)]).toEqual([255, 0, 0, 255]);
    }
    // A mostly-transparent region stays transparent (≤43% coverage threshold).
    const sparse = new Uint8Array(4 * 4 * 4);
    sparse.set([255, 0, 0, 255], 0); // one opaque pixel of 16
    const s = areaResize(4, 4, sparse, 1);
    expect(s.rgba[3]).toBe(0);
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
