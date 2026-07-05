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
//
// SHINY CAVEAT: a colour histogram keys on the palette, so a SHINY variant (different
// colours, sometimes drastically) will NOT match a reference built from the normal
// variant — and may mis-rank to a similar-coloured species. Two saving graces: (1) a
// shiny appears shiny in BOTH the team preview AND the in-battle nameplate, so a
// reference bootstrapped from THIS match's preview still matches that match's battle
// icon; the failure is only the cross-match GENERIC table (normal ref vs a shiny). (2)
// the per-match candidate set narrows it. Proper fix when it bites: store a shiny ref
// alongside the normal one (id + isShiny), or fall back to a shape feature + flag the
// read low-confidence for manual confirm. Not handled yet — recorded so it isn't a
// silent mismatch.

export type RGB = readonly [number, number, number];

export interface ColorHistOptions {
  /** Quantisation bins per channel; histogram length is bins³. Default 4 (64 bins). */
  bins?: number;
  /** Panel/background colour to mask out (skip pixels within bgThreshold of it). */
  bgColor?: RGB;
  /** Second background colour to mask (e.g. the green "selected-card" highlight on the
   *  player side — the focused row is drawn green, not the usual card colour). */
  bgColor2?: RGB;
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
  const bg2 = opts.bgColor2;
  const bgT = opts.bgThreshold ?? 75;
  const darkT = opts.darkThreshold ?? 55;
  const h = new Array(bins ** 3).fill(0);
  let n = 0;
  for (let p = 0; p < width * height; p++) {
    const i = p * 4, r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!;
    if (pixels[i + 3]! < 16) continue;                 // transparent
    if (r + g + b < darkT) continue;                   // near-black (masked bg too)
    if (bg && dist3(r, g, b, bg) < bgT) continue;      // panel background
    if (bg2 && dist3(r, g, b, bg2) < bgT) continue;    // 2nd bg (selected-card highlight)
    const q = (v: number) => Math.min(bins - 1, (v * bins) >> 8);
    h[(q(r) * bins + q(g)) * bins + q(b)]++;
    n++;
  }
  return n ? h.map((v) => v / n) : h;
}

/** 2×2 SPATIAL colour histogram: a bins³ histogram per quadrant, concatenated (length
 *  4·bins³, each quadrant normalised to sum 1). The global histogram is palette-only, so
 *  two same-palette / different-shape mons collide (measured: a Kingambit sprite matched
 *  the red/black/gold `sneasler` ref at 0.19). The quadrant histogram encodes WHERE the
 *  colours sit, which separates them. It IS alignment-sensitive (a shift moves colour
 *  across a quadrant boundary), so it is used ONLY as a TIE-BREAK behind the global score
 *  — never as the primary — to preserve the global hist's jitter-invariance. */
export function quadrantHistogram(
  pixels: Uint8ClampedArray | number[] | Buffer,
  width: number,
  height: number,
  opts: ColorHistOptions = {},
): number[] {
  const bins = opts.bins ?? 4;
  const bg = opts.bgColor, bg2 = opts.bgColor2;
  const bgT = opts.bgThreshold ?? 75, darkT = opts.darkThreshold ?? 55;
  const q = (v: number) => Math.min(bins - 1, (v * bins) >> 8);
  const mx = width >> 1, my = height >> 1;
  const cells: [number, number, number, number][] = [
    [0, 0, mx, my], [mx, 0, width - mx, my], [0, my, mx, height - my], [mx, my, width - mx, height - my],
  ];
  const out: number[] = [];
  for (const [x0, y0, cw, ch] of cells) {
    const h = new Array(bins ** 3).fill(0);
    let n = 0;
    for (let y = y0; y < y0 + ch; y++) for (let x = x0; x < x0 + cw; x++) {
      const i = (y * width + x) * 4, r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!;
      if (pixels[i + 3]! < 16) continue;
      if (r + g + b < darkT) continue;
      if (bg && dist3(r, g, b, bg) < bgT) continue;
      if (bg2 && dist3(r, g, b, bg2) < bgT) continue;
      h[(q(r) * bins + q(g)) * bins + q(b)]++; n++;
    }
    for (let k = 0; k < h.length; k++) out.push(n ? h[k] / n : 0);
  }
  return out;
}

/** L1 distance between two normalised histograms (0 = identical, 2 = disjoint). */
export function histDistance(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s;
}

export interface ColorHistRef { id: string; name: string; hist: number[]; quad?: number[]; verified?: boolean; }
export interface ColorHistMatch { id: string; name: string; distance: number; score: number; tiebroke?: boolean; }

// Tie-break tuning. The quadrant histogram is alignment/pose-sensitive, so it must ONLY
// arbitrate genuine near-ties — otherwise cross-frame quad noise flips a correct-but-weak
// global lead (measured: at margin 0.35 a laser-degraded Sinistcha at 0.46 got flipped to
// Arcanine at 0.76). So: only consider it when the leader is a plausible match
// (d < QUAD_GATE) AND only refs within a TIGHT QUAD_MARGIN of the leader are candidates —
// the real collision it fixes was a 0.03 gap (Kingambit 0.22 vs `sneasler` 0.19). A
// candidate lacking a quad histogram is charged QUAD_NOQUAD so a strong quad match can
// still overturn a crop-less leader.
const QUAD_GATE = 0.55;
const QUAD_MARGIN = 0.15;
const QUAD_WEIGHT = 0.6;
const QUAD_NOQUAD = 1.0;

/** Nearest-reference matcher over precomputed colour histograms. */
export class HistogramMatcher {
  constructor(private readonly refs: readonly ColorHistRef[], private readonly opts: ColorHistOptions = {}) {}
  /** Best species match for a cropped sprite (RGBA). score = 1 − distance/2 (0..1).
   *  Global histogram ranks; a 2×2 quadrant histogram breaks palette collisions. */
  match(pixels: Uint8ClampedArray | number[] | Buffer, width: number, height: number): ColorHistMatch | null {
    if (!this.refs.length) return null;
    const q = colorHistogram(pixels, width, height, this.opts);
    const scored = this.refs.map((r) => ({ r, d: histDistance(q, r.hist) })).sort((a, b) => a.d - b.d);
    const leader = scored[0]!;
    const collision = scored.filter((s) => s.d <= leader.d + QUAD_MARGIN);
    let chosen = leader.r, chosenD = leader.d, tiebroke = false;
    if (leader.d < QUAD_GATE && collision.length > 1 && collision.some((s) => s.r.quad)) {
      const qq = quadrantHistogram(pixels, width, height, this.opts);
      let bestScore = Infinity;
      for (const s of collision) {
        const quadD = s.r.quad ? histDistance(qq, s.r.quad) : QUAD_NOQUAD;
        const score = s.d + QUAD_WEIGHT * quadD;
        if (score < bestScore) { bestScore = score; chosen = s.r; chosenD = s.d; }
      }
      tiebroke = chosen !== leader.r;
    }
    return { id: chosen.id, name: chosen.name, distance: chosenD, score: 1 - chosenD / 2, tiebroke };
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
