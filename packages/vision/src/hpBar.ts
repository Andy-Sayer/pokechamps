// HP-bar reading: turn a cropped strip of the HP bar into a fill fraction [0,1].
// Hardware-independent pure logic — the only unknown is WHERE the bar is (the
// RegionMap), not how to read it. The bar fills left→right with a saturated
// green/yellow/red; the empty track is dark/desaturated.

/** A pixel counts as "filled" when it's bright AND colourful (the HP gradient),
 *  vs the dark grey empty track. Tunable; override per-UI if needed. */
export function defaultIsFilled(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const value = max / 255;                          // brightness
  const sat = max === 0 ? 0 : (max - min) / max;    // saturation
  return value > 0.35 && sat > 0.35;
}

export interface HpBarOpts {
  isFilled?: (r: number, g: number, b: number) => boolean;
  /** Empty-pixel run that ends the fill (tolerates anti-aliasing/gradient seams). */
  gapTolerance?: number;
  /** How many rows around the vertical centre to vote with (robust to glare). */
  sampleRows?: number;
}

/** Fill fraction [0,1] of a `width`×`height` RGBA crop of the HP bar. Reads the
 *  right edge of the contiguous filled run from the left, voting across a few
 *  centre rows so a stray bright pixel can't move the answer. */
export function readHpFraction(
  pixels: Uint8ClampedArray | number[], width: number, height: number, opts: HpBarOpts = {},
): number {
  if (width <= 0 || height <= 0) return 0;
  const isFilled = opts.isFilled ?? defaultIsFilled;
  const gapTol = opts.gapTolerance ?? Math.max(2, Math.round(width * 0.03));
  const rows = Math.max(1, Math.min(opts.sampleRows ?? 3, height));
  const midY = Math.floor(height / 2);
  let lastFilled = -1, gap = 0;
  for (let x = 0; x < width; x++) {
    let votes = 0;
    for (let r = 0; r < rows; r++) {
      const y = Math.min(height - 1, Math.max(0, midY - (rows >> 1) + r));
      const i = (y * width + x) * 4;
      if (isFilled(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!)) votes++;
    }
    if (votes * 2 > rows) { lastFilled = x; gap = 0; }
    else if (lastFilled >= 0 && ++gap > gapTol) break;
  }
  return (lastFilled + 1) / width;
}

/** Convenience: fill fraction → integer HP percent 0..100 (the engine's unit). */
export function hpPercentFromFraction(frac: number): number {
  return Math.max(0, Math.min(100, Math.round(frac * 100)));
}
