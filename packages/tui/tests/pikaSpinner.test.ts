// PikaSpinner sanity tests. We don't render the Ink component (no point
// pulling jsdom into the node-env tui suite for a spinner) — instead we
// assert the pure `glyphAt(tick)` helper cycles the plain throbber and the
// shared cadence stays sensible. The sixel sprite frames themselves are
// generated data (pikaSprite.ts) checked structurally here.
import { describe, expect, it } from 'vitest';
import {
  glyphAt,
  SPINNER_GLYPHS,
  FRAME_INTERVAL_MS,
} from '../src/ui/PikaSpinner.js';
import {
  IDLE_FRAMES, IDLE_PALETTE,
  RUN_FRAMES, RUN_PALETTE,
} from '../src/ui/pikaSprite.js';

describe('PikaSpinner', () => {
  it('plain throbber has enough glyphs to read as motion', () => {
    expect(SPINNER_GLYPHS.length).toBeGreaterThanOrEqual(4);
    for (const g of SPINNER_GLYPHS) expect([...g]).toHaveLength(1);
  });

  it('glyphAt cycles modulo length', () => {
    for (let i = 0; i < SPINNER_GLYPHS.length * 2; i++) {
      expect(glyphAt(i)).toBe(SPINNER_GLYPHS[i % SPINNER_GLYPHS.length]);
    }
  });

  it('FRAME_INTERVAL_MS is a sensible animation cadence (50-300ms)', () => {
    expect(FRAME_INTERVAL_MS).toBeGreaterThanOrEqual(50);
    expect(FRAME_INTERVAL_MS).toBeLessThanOrEqual(300);
  });

  it('sixel sprite sets are well-formed (frames match their palette)', () => {
    for (const [frames, palette] of [
      [RUN_FRAMES, RUN_PALETTE],
      [IDLE_FRAMES, IDLE_PALETTE],
    ] as const) {
      expect(frames.length).toBeGreaterThanOrEqual(2);
      for (const f of frames) {
        expect(f.pixels).toHaveLength(f.width * f.height);
        for (const p of f.pixels) {
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThanOrEqual(palette.colors.length);
        }
      }
    }
  });
});
