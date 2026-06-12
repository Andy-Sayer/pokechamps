// Compose several indexed sprites into one horizontal strip (shared palette)
// so the battle screen can draw the active opponents with a single sixel
// emission. Palettes merge with colour dedup; 0 stays transparent.
import type { Bitmap, Palette } from './sixel.js';
import type { Sprite } from './spriteCache.js';

const GAP = 4; // transparent pixels between sprites

/** Nearest-neighbour downsample on an INDEXED bitmap (palette preserved) —
 *  half-block rendering covers two pixel rows per text row, so sprites get an
 *  extra 2:1 to keep the on-screen footprint reasonable. */
export function downsampleIndexed(sprite: Sprite, factor: number): Sprite {
  if (factor <= 1) return sprite;
  const { bitmap } = sprite;
  const w = Math.max(1, Math.floor(bitmap.width / factor));
  const h = Math.max(1, Math.floor(bitmap.height / factor));
  const pixels = new Array<number>(w * h).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Prefer an opaque pixel anywhere in the block (keeps thin outlines).
      let pick = 0;
      outer: for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const p = bitmap.pixels[(y * factor + dy) * bitmap.width + (x * factor + dx)] ?? 0;
          if (p > 0) { pick = p; break outer; }
        }
      }
      pixels[y * w + x] = pick;
    }
  }
  return { bitmap: { width: w, height: h, pixels }, palette: sprite.palette };
}

export function composeStrip(sprites: Sprite[]): Sprite | null {
  if (!sprites.length) return null;
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
