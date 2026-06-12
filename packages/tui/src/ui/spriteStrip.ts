// Compose several indexed sprites into one horizontal strip (shared palette)
// so the battle screen can draw the active opponents with a single sixel
// emission. Palettes merge with colour dedup; 0 stays transparent.
import type { Bitmap, Palette } from './sixel.js';
import type { Sprite } from './spriteCache.js';

const GAP = 4; // transparent pixels between sprites

/** Majority-vote downsample on an INDEXED bitmap (palette preserved). Each
 *  output pixel takes the MOST COMMON colour of its factor×factor block —
 *  transparent wins only when it covers more than ~60% of the block, so
 *  silhouettes stay solid while edges stop speckling (the old first-opaque
 *  pick made small sprites ragged). Used by the half-block renderer, which
 *  shows two pixel rows per text row and wants small, clean output. */
export function downsampleIndexed(sprite: Sprite, factor: number): Sprite {
  if (factor <= 1) return sprite;
  const { bitmap } = sprite;
  const w = Math.max(1, Math.floor(bitmap.width / factor));
  const h = Math.max(1, Math.floor(bitmap.height / factor));
  const pixels = new Array<number>(w * h).fill(0);
  const counts = new Map<number, number>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      counts.clear();
      let opaque = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const p = bitmap.pixels[(y * factor + dy) * bitmap.width + (x * factor + dx)] ?? 0;
          if (p > 0) { opaque++; counts.set(p, (counts.get(p) ?? 0) + 1); }
        }
      }
      const block = factor * factor;
      if (opaque <= block * 0.4) { pixels[y * w + x] = 0; continue; }
      let best = 0, bestN = 0;
      for (const [p, n] of counts) if (n > bestN) { best = p; bestN = n; }
      pixels[y * w + x] = best;
    }
  }
  return { bitmap: { width: w, height: h, pixels }, palette: sprite.palette };
}

/** Crop to the bounding box of opaque pixels — sprite canvases carry large
 *  transparent margins (a 96px box the mon rarely fills), which made strip
 *  spacing uneven and the on-screen footprint bigger than the art. */
export function cropToContent(sprite: Sprite): Sprite {
  const { width, height, pixels } = sprite.bitmap;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x]! > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return sprite; // fully transparent — leave as-is
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const out = new Array<number>(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[y * w + x] = pixels[(y + minY) * width + (x + minX)]!;
  }
  return { bitmap: { width: w, height: h, pixels: out }, palette: sprite.palette };
}

export function composeStrip(rawSprites: Sprite[]): Sprite | null {
  if (!rawSprites.length) return null;
  const sprites = rawSprites.map(cropToContent);
  const height = Math.max(...sprites.map(s => s.bitmap.height));
  const width = sprites.reduce((w, s) => w + s.bitmap.width, 0) + GAP * (sprites.length - 1);
  const colors: [number, number, number][] = [];
  const index = new Map<number, number>();
  const mapColor = (c: readonly [number, number, number]): number | null => {
    const key = (c[0] << 16) | (c[1] << 8) | c[2];
    let idx = index.get(key);
    if (idx == null) {
      if (colors.length >= 255) return null;
      colors.push([c[0], c[1], c[2]]);
      idx = colors.length;
      index.set(key, idx);
    }
    return idx;
  };
  const pixels = new Array<number>(width * height).fill(0);
  let xOff = 0;
  for (const s of sprites) {
    // Bottom-align so differently-sized sprites stand on a common baseline.
    const yOff = height - s.bitmap.height;
    for (let y = 0; y < s.bitmap.height; y++) {
      for (let x = 0; x < s.bitmap.width; x++) {
        const p = s.bitmap.pixels[y * s.bitmap.width + x]!;
        if (p === 0) continue;
        const mapped = mapColor(s.palette.colors[p - 1]!);
        if (mapped == null) return null;
        pixels[(y + yOff) * width + (x + xOff)] = mapped;
      }
    }
    xOff += s.bitmap.width + GAP;
  }
  const bitmap: Bitmap = { width, height, pixels };
  const palette: Palette = { colors };
  return { bitmap, palette };
}
