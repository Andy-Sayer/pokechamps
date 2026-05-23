// Tiny sixel encoder. Takes a pixel grid + colour palette, returns the
// terminal escape sequence that renders it as a bitmap.
//
// Sixel format (very abridged):
//   ESC P q                                      header
//   #N;2;R;G;B                                   define colour N as RGB (0–100 scale!)
//   #N                                           select colour N
//   <one char per column, encoding 6 rows>       pixel data band
//   $                                            return to start of band
//   -                                            advance to next band
//   ESC \                                        terminator
//
// Each char in a band represents 6 vertical pixels in one column, as a 6-bit
// value: bit 0 = top, bit 5 = bottom. The character is `(value + 0x3F)` so it
// stays in the printable ASCII range. `?` (0x3F) = empty column.
//
// We render one colour at a time over the whole band: select colour, emit
// the column chars for that colour (other colours' columns are `?`), then
// `$` to rewind for the next colour. This is the simplest correct encoding;
// not the most space-efficient.

export type Pixel = number; // index into the palette (1-based; 0 = transparent)

export interface Palette {
  /** Each entry is [R, G, B] on a 0–255 scale; we convert to 0–100 for sixel. */
  colors: ReadonlyArray<readonly [number, number, number]>;
}

export interface Bitmap {
  width: number;
  height: number;
  /** Row-major. Length must equal width * height. */
  pixels: ReadonlyArray<Pixel>;
}

const ESC = '\x1b';

export interface EncodeOptions {
  /** Nearest-neighbour scale factor — each source pixel becomes scale×scale
   *  output pixels. Default 1. Use 2 or 3 to make a tiny sprite visible. */
  scale?: number;
}

export function encodeSixel(bitmap: Bitmap, palette: Palette, opts: EncodeOptions = {}): string {
  const scale = Math.max(1, Math.floor(opts.scale ?? 1));
  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const srcPixels = bitmap.pixels;
  if (srcPixels.length !== srcW * srcH) {
    throw new Error(`sixel: pixels length ${srcPixels.length} doesn't match ${srcW}x${srcH}`);
  }
  // Upscale: blit each source pixel into a scale×scale block.
  let width = srcW;
  let height = srcH;
  let pixels: ReadonlyArray<Pixel> = srcPixels;
  if (scale > 1) {
    width = srcW * scale;
    height = srcH * scale;
    const scaled = new Array<Pixel>(width * height);
    for (let y = 0; y < srcH; y++) {
      for (let x = 0; x < srcW; x++) {
        const p = srcPixels[y * srcW + x]!;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            scaled[(y * scale + dy) * width + (x * scale + dx)] = p;
          }
        }
      }
    }
    pixels = scaled;
  }

  let out = `${ESC}Pq`;
  // Palette definitions. Sixel colour-space is 0–100 per channel.
  for (let i = 0; i < palette.colors.length; i++) {
    const [r, g, b] = palette.colors[i]!;
    const rr = Math.round((r / 255) * 100);
    const gg = Math.round((g / 255) * 100);
    const bb = Math.round((b / 255) * 100);
    // Palette index in sixel is 1-based; 0 is reserved as transparent.
    out += `#${i + 1};2;${rr};${gg};${bb}`;
  }

  // Per-colour, per-band emission.
  const bandCount = Math.ceil(height / 6);
  for (let band = 0; band < bandCount; band++) {
    const rowBase = band * 6;
    for (let ci = 0; ci < palette.colors.length; ci++) {
      const colour = ci + 1;
      // Build the column string for this colour. RLE the trailing `?`s
      // (no-pixel columns) so the output isn't enormous.
      let cols = '';
      for (let x = 0; x < width; x++) {
        let bits = 0;
        for (let yOff = 0; yOff < 6; yOff++) {
          const y = rowBase + yOff;
          if (y >= height) break;
          const px = pixels[y * width + x]!;
          if (px === colour) bits |= 1 << yOff;
        }
        cols += String.fromCharCode(bits + 0x3f);
      }
      out += `#${colour}${cols}$`;
    }
    // Advance to next band (except after the last one).
    if (band < bandCount - 1) out += '-';
  }

  out += `${ESC}\\`;
  return out;
}

// Build a Bitmap from a string-art grid: array of rows, each row a string
// where each char is a key into `legend`. Whitespace and `.` map to
// transparent (pixel index 0).
export function bitmapFromArt(art: ReadonlyArray<string>, legend: Record<string, number>): Bitmap {
  const height = art.length;
  const width = art[0]?.length ?? 0;
  const pixels: Pixel[] = [];
  for (let y = 0; y < height; y++) {
    const row = art[y]!;
    if (row.length !== width) {
      throw new Error(`bitmapFromArt: row ${y} width ${row.length}, expected ${width}`);
    }
    for (let x = 0; x < width; x++) {
      const ch = row[x]!;
      if (ch === '.' || ch === ' ') {
        pixels.push(0);
      } else {
        const idx = legend[ch];
        if (idx == null) throw new Error(`bitmapFromArt: unknown char "${ch}" at (${x},${y})`);
        pixels.push(idx);
      }
    }
  }
  return { width, height, pixels };
}
