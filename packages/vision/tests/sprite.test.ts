import { describe, test, expect } from 'vitest';
import { dHash, hamming, SpriteHashMatcher } from '../src/sprite.js';

// A horizontal greyscale gradient (dark→bright, or reversed).
function gradient(w: number, h: number, reverse = false): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = reverse ? (w - 1 - x) / (w - 1) : x / (w - 1);
    const v = Math.round(t * 255);
    const i = (y * w + x) * 4;
    d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
  }
  return d;
}
// Same gradient with a little per-pixel noise (compression/lighting analogue).
function noisy(w: number, h: number): Uint8ClampedArray {
  const d = gradient(w, h);
  for (let i = 0; i < d.length; i += 4) { const n = ((i * 7) % 21) - 10; d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, d[i]! + n)); }
  return d;
}

describe('hamming', () => {
  test('counts differing bits', () => {
    expect(hamming(0b1010n, 0b1000n)).toBe(1);
    expect(hamming(0n, 0n)).toBe(0);
    expect(hamming(0b1111n, 0b0000n)).toBe(4);
  });
});

describe('dHash', () => {
  test('an increasing gradient hashes opposite to its reverse (max distance)', () => {
    const g = dHash(gradient(20, 16), 20, 16), r = dHash(gradient(20, 16, true), 20, 16);
    expect(hamming(g, g)).toBe(0);
    expect(hamming(g, r)).toBe(64);          // every bit flips
  });
  test('robust to noise — a noisy copy stays close', () => {
    expect(hamming(dHash(gradient(20, 16), 20, 16), dHash(noisy(20, 16), 20, 16))).toBeLessThan(8);
  });
});

describe('SpriteHashMatcher', () => {
  const refs = [
    { id: 'azumarill', name: 'Azumarill', hash: dHash(gradient(20, 16), 20, 16) },
    { id: 'gholdengo', name: 'Gholdengo', hash: dHash(gradient(20, 16, true), 20, 16) },
  ];
  const m = new SpriteHashMatcher(refs);

  test('matches a query to its nearest reference', () => {
    const a = m.match(noisy(20, 16), 20, 16)!;          // close to the first ref
    expect(a.id).toBe('azumarill');
    expect(a.score).toBeGreaterThan(0.85);
    expect(m.match(gradient(20, 16, true), 20, 16)!.id).toBe('gholdengo');
  });
  test('empty reference table → null', () => {
    expect(new SpriteHashMatcher([]).match(gradient(8, 8), 8, 8)).toBeNull();
  });
});
