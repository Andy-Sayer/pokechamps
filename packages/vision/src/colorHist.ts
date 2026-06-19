import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '@pokechamps/core/domain/data.js';

// Sprite identification by COLOUR HISTOGRAM — the validated approach for matching
// the opponent's team-preview sprites (icons with no text, so OCR can't help).
//
// WHY NOT dHash (see sprite.ts): a perceptual hash is alignment- and background-
// fragile. Measured on real Champions preview sprites, a ±6px crop shift flipped up
// to 22/64 dHash bits — as large as the gap between *different* species — so it
// misidentified 5/54 jittered crops. A colour histogram is naturally alignment- AND
// scale-invariant (it's just the distribution of sprite colours), which is exactly
// what we need: the same species at any offset/size hashes the same. Measured on the
// same six sprites: 54/54 correct under ±8px jitter and 6/6 cross-frame, species
// separation 0.76 vs worst self-distance 0.49 (L1, range 0..2). Deterministic — no
// LLM/visual guessing in the loop.
//
// The game draws each preview sprite on a flat panel background (the Champions
// opponent panel is a dark magenta ≈ rgb(131,6,55)); we mask that out so only the
// creature's colours contribute. Across all 208 species some palettes will collide,
// so for the full table this is the primary score with the per-match candidate set
// (and optionally a spatial/quadrant histogram) as the tie-break — but as a
// discriminator on real game art it is strong where dHash was not.

export type RGB = readonly [number, number, number];

export interface ColorHistOptions {
  /** Quantisation bins per channel; histogram length is bins³. Default 4 (64 bins). */
  bins?: number;
  /** Panel/background colour to mask out (skip pixels within bgThreshold of it). */
  bgColor?: RGB;
  /** Euclidean RGB radius treated as background. Default 75. */
  bgThreshold?: number;
  /** Skip near-black pixels (r+g+b below this). Default 55. */
  darkThreshold?: number;
}

const dist3 = (r: number, g: number, b: number, c: RGB) => Math.hypot(r - c[0], g - c[1], b - c[2]);

/** Normalised colour histogram of an RGBA buffer (bins³ floats summing to 1). */
export function colorHistogram(
  pixels: Uint8ClampedArray | number[] | Buffer,
  width: number,
  height: number,
  opts: ColorHistOptions = {},
): number[] {
  const bins = opts.bins ?? 4;
  const bg = opts.bgColor;
  const bgT = opts.bgThreshold ?? 75;
  const darkT = opts.darkThreshold ?? 55;
  const h = new Array(bins ** 3).fill(0);
  let n = 0;
  for (let p = 0; p < width * height; p++) {
    const i = p * 4, r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!;
    if (pixels[i + 3]! < 16) continue;                 // transparent
    if (r + g + b < darkT) continue;                   // near-black (masked bg too)
    if (bg && dist3(r, g, b, bg) < bgT) continue;      // panel background
    const q = (v: number) => Math.min(bins - 1, (v * bins) >> 8);
    h[(q(r) * bins + q(g)) * bins + q(b)]++;
    n++;
  }
  return n ? h.map((v) => v / n) : h;
}

/** L1 distance between two normalised histograms (0 = identical, 2 = disjoint). */
export function histDistance(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s;
}

export interface ColorHistRef { id: string; name: string; hist: number[]; }
export interface ColorHistMatch { id: string; name: string; distance: number; score: number; }

/** Nearest-reference matcher over precomputed colour histograms. */
export class HistogramMatcher {
  constructor(private readonly refs: readonly ColorHistRef[], private readonly opts: ColorHistOptions = {}) {}
  /** Best species match for a cropped sprite (RGBA). score = 1 − distance/2 (0..1). */
  match(pixels: Uint8ClampedArray | number[] | Buffer, width: number, height: number): ColorHistMatch | null {
    if (!this.refs.length) return null;
    const q = colorHistogram(pixels, width, height, this.opts);
    let best: ColorHistRef | null = null, bestD = Infinity, second = Infinity;
    for (const r of this.refs) {
      const d = histDistance(q, r.hist);
      if (d < bestD) { second = bestD; bestD = d; best = r; }
      else if (d < second) second = d;
    }
    return best ? { id: best.id, name: best.name, distance: bestD, score: 1 - bestD / 2 } : null;
  }
}

/** Load the bootstrapped reference table (data/sprite-refs.json). Built from the
 *  GAME'S OWN art by scripts/bootstrap-refs.ts; grows as more species are labelled
 *  (preview slots get named by the in-battle text reveal). Empty if not yet built. */
export function loadColorHistRefs(): ColorHistRef[] {
  const p = join(dataDirPath(), 'sprite-refs.json');
  if (!existsSync(p)) return [];
  const json = JSON.parse(readFileSync(p, 'utf8')) as { bins?: number; refs: ColorHistRef[] };
  return json.refs ?? [];
}
