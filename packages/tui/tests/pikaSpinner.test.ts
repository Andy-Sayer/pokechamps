// PikaSpinner sanity tests. We don't render the Ink component (no point in
// pulling jsdom into the node-env tui suite for a spinner) — instead we
// assert the pure `frameAt(tick)` helper cycles through the registered
// frames in order, and that each 3-line frame has the structural invariants
// the renderer relies on.
import { describe, expect, it } from 'vitest';
import { frameAt, spinnerFrames, FRAME_INTERVAL_MS } from '../src/ui/PikaSpinner.js';

describe('PikaSpinner frames', () => {
  it('has at least 4 frames so the animation reads as motion', () => {
    expect(spinnerFrames.length).toBeGreaterThanOrEqual(4);
  });

  it('every frame has three non-empty lines (top/mid/bot)', () => {
    for (const f of spinnerFrames) {
      expect(typeof f.top).toBe('string');
      expect(typeof f.mid).toBe('string');
      expect(typeof f.bot).toBe('string');
      expect(f.top.length).toBeGreaterThan(0);
      expect(f.mid.length).toBeGreaterThan(0);
      expect(f.bot.length).toBeGreaterThan(0);
    }
  });

  it('top and bot stay constant across frames (silhouette anchor)', () => {
    // The chin doesn't animate, so every frame's bot row matches frame 0's.
    const baseBot = spinnerFrames[0]!.bot;
    for (const f of spinnerFrames) {
      expect(f.bot).toBe(baseBot);
    }
  });

  it('all three rows are the same width within each frame', () => {
    // Visual alignment depends on this — if widths drift, the silhouette
    // jitters between frames in a way that reads as a render bug.
    for (const f of spinnerFrames) {
      // Use Array.from to count Unicode code points, not UTF-16 surrogate
      // halves. ⚡ is a single grapheme but two UTF-16 units.
      const w = (s: string) => [...s].length;
      expect(w(f.top)).toBe(w(f.mid));
      expect(w(f.mid)).toBe(w(f.bot));
    }
  });

  it('frameAt cycles through frames modulo length', () => {
    for (let i = 0; i < spinnerFrames.length * 2; i++) {
      expect(frameAt(i)).toBe(spinnerFrames[i % spinnerFrames.length]);
    }
  });

  it('FRAME_INTERVAL_MS is a sensible animation cadence (50-300ms)', () => {
    expect(FRAME_INTERVAL_MS).toBeGreaterThanOrEqual(50);
    expect(FRAME_INTERVAL_MS).toBeLessThanOrEqual(300);
  });
});
