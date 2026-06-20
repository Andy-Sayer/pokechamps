import { describe, test, expect } from 'vitest';
import { binarizeWhiteDigits, parseHpNumber, parseAbsHp, readOpponentHpPercents } from '../src/hpRead.js';
import { CHAMPIONS_DOUBLES_PLACEHOLDER } from '../src/regions.js';
import type { Frame } from '../src/types.js';

describe('parseHpNumber', () => {
  test('extracts the integer from a noisy readout', () => {
    expect(parseHpNumber('100%')).toBe(100);
    expect(parseHpNumber('82')).toBe(82);
    expect(parseHpNumber(' 45% ')).toBe(45);
    expect(parseHpNumber('o0')).toBe(0);        // OCR slop → digits only
    expect(parseHpNumber('')).toBeNull();
    expect(parseHpNumber('---')).toBeNull();
  });
});

describe('parseAbsHp', () => {
  test('parses my-side cur/max, requires both numbers', () => {
    expect(parseAbsHp('183/183')).toEqual({ cur: 183, max: 183 });
    expect(parseAbsHp('117/175')).toEqual({ cur: 117, max: 175 });
    expect(parseAbsHp('0/207')).toEqual({ cur: 0, max: 207 });
    expect(parseAbsHp('183183')).toBeNull();   // dropped "/" → don't trust it
    expect(parseAbsHp('183')).toBeNull();
    expect(parseAbsHp('')).toBeNull();
  });
});

describe('binarizeWhiteDigits', () => {
  test('isolates white (digit) pixels as black on white', () => {
    // 2 pixels: white digit, saturated-green bar
    const px = new Uint8ClampedArray([245, 250, 240, 255,  60, 200, 40, 255]);
    const out = binarizeWhiteDigits(px, 2, 1);
    expect([out[0], out[1], out[2]]).toEqual([0, 0, 0]);       // white → black digit
    expect([out[4], out[5], out[6]]).toEqual([255, 255, 255]); // green → white bg
  });
});

describe('readOpponentHpPercents', () => {
  const frame: Frame = { width: 1920, height: 1080, data: new Uint8ClampedArray(1920 * 1080 * 4), ts: 0 };

  test('reads both opponent slots via injected OCR, clamps to 0..100', async () => {
    const replies = ['100', '150'];                            // 2nd is an over-read → clamp
    let i = 0;
    const hp = await readOpponentHpPercents(frame, async () => replies[i++]!, CHAMPIONS_DOUBLES_PLACEHOLDER);
    expect(hp).toEqual({ o1: 100, o2: 100 });
  });

  test('skips a slot the OCR can\'t read', async () => {
    const replies = ['67', ''];
    let i = 0;
    const hp = await readOpponentHpPercents(frame, async () => replies[i++]!, CHAMPIONS_DOUBLES_PLACEHOLDER);
    expect(hp).toEqual({ o1: 67 });
  });
});
