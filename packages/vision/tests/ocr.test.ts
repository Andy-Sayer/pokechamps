import { describe, test, expect } from 'vitest';
import { binarizeWhiteText, StubOcrReader } from '../src/ocr.js';
import type { Frame } from '../src/types.js';

describe('binarizeWhiteText', () => {
  // 3 pixels: near-white text, a saturated fire colour, and a bright-but-saturated
  // light green that a plain brightness threshold would wrongly keep.
  const px = new Uint8ClampedArray([
    245, 250, 240, 255,   // near-white (low saturation) → black text
    255, 140, 30, 255,    // fire orange (min low)        → white bg
    200, 255, 200, 255,   // light green (max-min=55)     → white bg (saturation reject)
  ]);
  const out = binarizeWhiteText(px, 3, 1);
  test('keeps near-white as black text', () => {
    expect([out[0], out[1], out[2]]).toEqual([0, 0, 0]);
  });
  test('rejects a saturated colour even when bright', () => {
    expect([out[4], out[5], out[6]]).toEqual([255, 255, 255]);   // fire orange
    expect([out[8], out[9], out[10]]).toEqual([255, 255, 255]);  // light green
  });
});

describe('StubOcrReader', () => {
  test('reads nothing (pipeline wiring without an engine)', async () => {
    const frame: Frame = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4), ts: 0 };
    expect(await new StubOcrReader().read(frame, { x: 0, y: 0, w: 1, h: 1 })).toBe('');
  });
});
