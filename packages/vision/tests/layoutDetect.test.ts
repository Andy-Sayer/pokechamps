import { describe, test, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFrame } from '../src/decode.js';
import { voteScreenLayout, LayoutDetector, GAMESHARE_INSET } from '../src/regions.js';
import type { Frame } from '../src/types.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const has = (f: string) => existsSync(join(FIX, f));

// Synthetic frames: a flat field, optionally with the GameShare border painted black.
// Lets the hysteresis logic be tested without fixtures (which are gitignored).
function synth(inset: boolean, innerLuma = 180): Frame {
  const W = 1920, H = 1080;
  const data = new Uint8ClampedArray(W * H * 4);
  const bx = Math.round(GAMESHARE_INSET.x * W), by = Math.round(GAMESHARE_INSET.y * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const border = inset && (x < bx || x >= W - bx || y < by || y >= H - by);
    const v = border ? 4 : innerLuma;
    const i = (y * W + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  return { width: W, height: H, data, ts: 0 };
}

describe('screen-layout detection', () => {
  test('a synthetic GameShare border reads as inset; a full-bleed frame as full', () => {
    expect(voteScreenLayout(synth(true))).toBe('inset');
    expect(voteScreenLayout(synth(false))).toBe('full');
  });

  test('an all-dark frame ABSTAINS — dark is not evidence of an inset', () => {
    // A fade / black screen has a dark border AND a dark middle. Voting 'inset' here
    // would flip the map on every scene transition; voting 'full' would make a run of
    // dark frames read as evidence for direct capture. The only honest answer is null.
    expect(voteScreenLayout(synth(true, 6))).toBeNull();
    expect(voteScreenLayout(synth(false, 6))).toBeNull();
  });

  test('flipping needs a sustained run; one odd frame cannot thrash the map', () => {
    const d = new LayoutDetector(4);
    expect(d.layout).toBe('full');                       // own screen is the default
    expect(d.feed(synth(true))).toBe('full');            // 1 vote — not yet
    expect(d.feed(synth(true))).toBe('full');
    expect(d.feed(synth(false))).toBe('full');           // contrary vote resets the run
    for (let i = 0; i < 3; i++) d.feed(synth(true));
    expect(d.layout).toBe('full');                       // 3 < 4
    expect(d.feed(synth(true))).toBe('inset');           // 4th consecutive → flip
  });

  test('abstentions neither flip nor reset an in-progress run', () => {
    const d = new LayoutDetector(3);
    d.feed(synth(true)); d.feed(synth(true));
    expect(d.feed(synth(false, 6))).toBe('full');        // dark frame abstains
    expect(d.feed(synth(true))).toBe('inset');           // run continued across it
  });

  test.runIf(has('gameshare-battle.png') && has('battle1.png'))(
    'REAL frames: a GameShare battle capture vs a direct capture', async () => {
      expect(voteScreenLayout(await loadFrame(join(FIX, 'gameshare-battle.png')))).toBe('inset');
      expect(voteScreenLayout(await loadFrame(join(FIX, 'battle1.png')))).toBe('full');
    });
});
