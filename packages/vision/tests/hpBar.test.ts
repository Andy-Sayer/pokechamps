import { describe, test, expect } from 'vitest';
import { readHpFraction, defaultIsFilled, hpPercentFromFraction } from '../src/hpBar.js';

// Build a width×height RGBA strip whose first `fillCols` columns are the filled
// colour and the rest the empty track.
function strip(width: number, height: number, fillCols: number, fill: [number, number, number] = [40, 200, 60], empty: [number, number, number] = [50, 50, 50]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const c = x < fillCols ? fill : empty;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
  }
  return d;
}

describe('defaultIsFilled', () => {
  test('bright saturated HP colours read as filled; grey track does not', () => {
    expect(defaultIsFilled(40, 200, 60)).toBe(true);    // green
    expect(defaultIsFilled(220, 220, 40)).toBe(true);   // yellow
    expect(defaultIsFilled(200, 40, 40)).toBe(true);    // red
    expect(defaultIsFilled(50, 50, 50)).toBe(false);    // dark grey empty
    expect(defaultIsFilled(15, 15, 15)).toBe(false);    // near-black
  });
});

describe('readHpFraction', () => {
  test('60%-filled green bar reads ~0.6', () => {
    expect(readHpFraction(strip(100, 6, 60), 100, 6)).toBeCloseTo(0.6, 1);
  });
  test('full bar reads 1.0, empty reads 0', () => {
    expect(readHpFraction(strip(100, 6, 100), 100, 6)).toBe(1);
    expect(readHpFraction(strip(100, 6, 0), 100, 6)).toBe(0);
  });
  test('low-HP red bar still reads its fraction', () => {
    expect(readHpFraction(strip(100, 6, 15, [200, 40, 40]), 100, 6)).toBeCloseTo(0.15, 1);
  });
  test('hpPercentFromFraction clamps + rounds to the engine unit', () => {
    expect(hpPercentFromFraction(0.6)).toBe(60);
    expect(hpPercentFromFraction(1.4)).toBe(100);
    expect(hpPercentFromFraction(-0.1)).toBe(0);
  });
});
