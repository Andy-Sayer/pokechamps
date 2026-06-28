// Switch 2 GameShare: the shared screen is a 5/6-scale centred inset of the
// 1920×1080 capture (measured — 1600×900, 160px L/R + 90px T/B borders). The
// region map is remapped into that inset so the existing battle calibration
// works through GameShare with no re-measuring.
import { describe, test, expect } from 'vitest';
import { CHAMPIONS_DOUBLES_PLACEHOLDER, GAMESHARE_INSET, insetRegionMap, toPixels } from '../src/regions.js';
import type { Rect } from '../src/types.js';

describe('GameShare inset transform', () => {
  test('a full-frame region maps to the exact 1600×900 centred inset', () => {
    const map = insetRegionMap({ ...CHAMPIONS_DOUBLES_PLACEHOLDER, battleText: { x: 0, y: 0, w: 1, h: 1 } }, GAMESHARE_INSET);
    expect(toPixels(map.battleText, 1920, 1080)).toEqual({ x: 160, y: 90, w: 1600, h: 900 });
  });

  test('every battle box lands inside the inset rectangle [160,1760]×[90,990]', () => {
    const map = insetRegionMap(CHAMPIONS_DOUBLES_PLACEHOLDER);
    const inside = (r: Rect) => {
      const p = toPixels(r, 1920, 1080);
      return p.x >= 160 && p.y >= 90 && p.x + p.w <= 1760 && p.y + p.h <= 990;
    };
    expect(inside(map.battleText)).toBe(true);
    for (const s of map.slots) { expect(inside(s.name)).toBe(true); expect(inside(s.hpBar)).toBe(true); }
    for (const r of map.oppHpText!) expect(inside(r)).toBe(true);
    for (const r of map.myHpText!) expect(inside(r)).toBe(true);
  });

  test('default inset is the measured 5/6 centred frame', () => {
    expect(GAMESHARE_INSET.scale).toBeCloseTo(0.8333, 4);
    expect(GAMESHARE_INSET.x).toBeCloseTo(160 / 1920, 6);
    expect(GAMESHARE_INSET.y).toBeCloseTo(90 / 1080, 6);
  });
});
