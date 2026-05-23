// Render a single bitmap frame as a sixel escape sequence. Ink writes the
// sequence to stdout; the terminal interprets it as raster pixels drawn at
// the cursor position. Ink's measurement layer treats the entire sequence
// as one "character" of text, so the parent Box must reserve enough cell
// height/width or adjacent elements will overlap the image.
//
// We don't import the sixel encoder eagerly at module level because some
// sprite files are largish; consumers pass in the pre-encoded string when
// caching matters.
import React, { useMemo } from 'react';
import { Text } from 'ink';
import { encodeSixel, type Bitmap, type Palette } from './sixel.js';

export interface SixelImageProps {
  bitmap: Bitmap;
  palette: Palette;
  /** Nearest-neighbour scale factor (1 = native pixels). */
  scale?: number;
}

export function SixelImage({ bitmap, palette, scale = 1 }: SixelImageProps) {
  // Re-encode only when the bitmap reference or scale changes — sixel
  // encoding for a 50x46 frame is a few KB and not free.
  const seq = useMemo(() => encodeSixel(bitmap, palette, { scale }), [bitmap, palette, scale]);
  return <Text>{seq}</Text>;
}
