import { describe, test, expect } from 'vitest';
import { colorHistogram, histDistance, HistogramMatcher, loadColorHistRefs } from '../src/colorHist.js';

const BINS = 4;
/** Solid w×h RGBA fill. */
function solid(w: number, h: number, [r, g, b]: [number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; }
  return d;
}
/** Left half colour A, right half colour B. */
function split(w: number, h: number, a: [number, number, number], b: [number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, c = x < w / 2 ? a : b;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
  }
  return d;
}

describe('colorHistogram', () => {
  test('normalised to 1 and concentrated in the colour bin', () => {
    const h = colorHistogram(solid(8, 8, [0, 0, 255]), 8, 8, { bins: BINS });
    expect(h.length).toBe(BINS ** 3);
    expect(h.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
    expect(h[3]).toBeCloseTo(1, 6);                 // (0,0,3) bin = pure blue
  });
  test('bgColor masks out the panel background', () => {
    const px = split(8, 8, [131, 6, 55], [0, 0, 255]);   // half panel-red, half blue
    const h = colorHistogram(px, 8, 8, { bins: BINS, bgColor: [131, 6, 55] });
    expect(h.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
    expect(h[3]).toBeCloseTo(1, 6);                 // only the blue survives
  });
});

describe('histDistance', () => {
  test('identical → 0, disjoint colours → 2', () => {
    const blue = colorHistogram(solid(8, 8, [0, 0, 255]), 8, 8, { bins: BINS });
    const red = colorHistogram(solid(8, 8, [255, 0, 0]), 8, 8, { bins: BINS });
    expect(histDistance(blue, blue)).toBeCloseTo(0, 6);
    expect(histDistance(blue, red)).toBeCloseTo(2, 6);
  });
});

describe('HistogramMatcher', () => {
  const refs = (['blue', 'red', 'green'] as const).map((id, i) => ({
    id, name: id, hist: colorHistogram(solid(8, 8, [[0, 0, 255], [255, 0, 0], [0, 255, 0]][i] as [number, number, number]), 8, 8, { bins: BINS }),
  }));
  const m = new HistogramMatcher(refs, { bins: BINS });

  test('matches a noisy query to its colour', () => {
    const r = m.match(solid(8, 8, [20, 20, 235]), 8, 8)!;   // off-blue
    expect(r.id).toBe('blue');
    expect(r.score).toBeGreaterThan(0.5);
  });
  test('empty table → null', () => {
    expect(new HistogramMatcher([]).match(solid(8, 8, [0, 0, 255]), 8, 8)).toBeNull();
  });
});

describe('seed reference table (data/sprite-refs.json)', () => {
  const refs = loadColorHistRefs();
  test('the bootstrapped game-art seed loads and is well-formed', () => {
    // Built by scripts/bootstrap-refs.ts from a verified fullscreen frame.
    expect(refs.length).toBeGreaterThanOrEqual(6);
    for (const r of refs) {
      expect(r.hist.length).toBe(BINS ** 3);
      expect(r.hist.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 2);
    }
    const ids = new Set(refs.map((r) => r.id));
    for (const id of ['azumarill', 'staraptor', 'arcanine', 'florges', 'sylveon', 'gholdengo']) expect(ids.has(id)).toBe(true);
  });
  test('seed species are mutually separated (matcher can tell them apart)', () => {
    const seed = refs.filter((r) => ['azumarill', 'staraptor', 'arcanine', 'florges', 'sylveon', 'gholdengo'].includes(r.id));
    let minD = Infinity;
    for (let i = 0; i < seed.length; i++) for (let j = i + 1; j < seed.length; j++) minD = Math.min(minD, histDistance(seed[i].hist, seed[j].hist));
    expect(minD).toBeGreaterThan(0.3);
  });
});
