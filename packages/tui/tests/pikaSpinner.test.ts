// PikaSpinner sanity tests. We don't render the Ink component (no point in
// pulling jsdom into the node-env tui suite for a spinner) — instead we
// assert the pure `frameAt(tick)` helper cycles through the registered
// frames in order, and that the frames array itself is non-empty and
// composed of short visible strings.
import { describe, expect, it } from 'vitest';
import { frameAt, spinnerFrames, FRAME_INTERVAL_MS } from '../src/ui/PikaSpinner.js';

describe('PikaSpinner frames', () => {
  it('has at least 3 frames', () => {
    expect(spinnerFrames.length).toBeGreaterThanOrEqual(3);
  });

  it('every frame is a non-empty short string', () => {
    for (const f of spinnerFrames) {
      expect(typeof f).toBe('string');
      expect(f.length).toBeGreaterThan(0);
      expect(f.length).toBeLessThanOrEqual(20);
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
