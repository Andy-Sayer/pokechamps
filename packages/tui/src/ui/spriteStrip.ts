// Compose several indexed sprites into one horizontal strip (shared palette)
// so the battle screen can draw the active opponents with a single sixel
// emission. Palettes merge with colour dedup; 0 stays transparent.
import type { Bitmap, Palette } from './sixel.js';
import type { Sprite } from './spriteCache.js';

const GAP = 4; // transparent pixels between sprites

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
