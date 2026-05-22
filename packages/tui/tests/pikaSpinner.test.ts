// PikaSpinner sanity tests. We don't render the Ink component (no point
// pulling jsdom into the node-env tui suite for a spinner) — instead we
// assert the pure `frameAt(tick)` helper cycles through the frames in order
// and that each 3-line frame has the structural invariants the renderer
// relies on.
import { describe, expect, it } from 'vitest';
import {
  frameAt,
  spinnerFrames,
  segWidth,
  FRAME_INTERVAL_MS,
} from '../src/ui/PikaSpinner.js';

describe('PikaSpinner frames', () => {
  it('has at least 4 frames so the animation reads as motion', () => {
    expect(spinnerFrames.length).toBeGreaterThanOrEqual(4);
  });

  it('every frame has three non-empty rows', () => {
    for (const f of spinnerFrames) {
      expect(f.top.length).toBeGreaterThan(0);
      expect(f.mid.length).toBeGreaterThan(0);
      expect(f.bot.length).toBeGreaterThan(0);
      for (const seg of [...f.top, ...f.mid, ...f.bot]) {
        expect(typeof seg.text).toBe('string');
        expect(seg.text.length).toBeGreaterThan(0);
      }
    }
  });

  it('chin row is constant across frames (silhouette anchor)', () => {
    const base = spinnerFrames[0]!.bot;
    for (const f of spinnerFrames) {
      expect(f.bot).toEqual(base);
    }
  });

  it('all three rows are the same width within each frame', () => {
    // Visual alignment depends on this — if widths drift, the silhouette
    // jitters between frames in a way that reads as a render bug.
    for (let i = 0; i < spinnerFrames.length; i++) {
      const f = spinnerFrames[i]!;
      const wTop = segWidth(f.top);
      const wMid = segWidth(f.mid);
      const wBot = segWidth(f.bot);
      expect(wTop, `frame ${i} top vs mid`).toBe(wMid);
      expect(wMid, `frame ${i} mid vs bot`).toBe(wBot);
    }
  });

  it('every frame uses at least one red cheek segment (Pikachu hallmark)', () => {
    for (const f of spinnerFrames) {
      const hasRed = f.mid.some(s => s.color === 'red' || s.color === 'redBright');
      expect(hasRed).toBe(true);
    }
  });

  it('at least one frame in the cycle includes a lightning spark', () => {
    const cycleHasSpark = spinnerFrames.some(f =>
      [...f.top, ...f.mid, ...f.bot].some(s => s.text.includes('⚡')),
    );
    expect(cycleHasSpark).toBe(true);
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
