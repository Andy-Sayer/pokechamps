// Render a single bitmap frame as a sixel escape sequence.
//
// PROBLEM with the naive `<Text>{seq}</Text>` approach: Ink's text renderer
// runs the content through wrap-ansi + width measurement, which strips or
// escapes the DCS (ESC P ... ESC \) sequence so the terminal never sees the
// raw bytes. preview-pika.ts works because it bypasses Ink entirely.
//
// FIX: write the sequence directly to stdout via `useStdout` + `useEffect`,
// completely outside Ink's text pipeline. We reserve vertical space by
// rendering a stack of blank `<Text>{' '}</Text>` lines (so Ink lays out the
// rest of the UI below the sprite), then position the cursor up N lines,
// emit the sixel, and snap back down. The terminal draws the bitmap into
// the cells Ink already reserved.
//
// Re-emit happens on every render — sixel is cheap to draw and this keeps
// the sprite visible after Ink repaints other parts of the screen.
import React, { useEffect, useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';
import { encodeSixel, type Bitmap, type Palette } from './sixel.js';

export interface SixelImageProps {
  bitmap: Bitmap;
  palette: Palette;
  /** Nearest-neighbour scale factor (1 = native pixels). */
  scale?: number;
  /** Reserved rows of layout for the sprite. Should be ≥ ceil(scaledHeight
   *  / cellHeight); 5 covers most font sizes for a 46px-tall sprite. */
  rows?: number;
}

export function SixelImage({ bitmap, palette, scale = 1, rows = 5 }: SixelImageProps) {
  const seq = useMemo(() => encodeSixel(bitmap, palette, { scale }), [bitmap, palette, scale]);
  const { stdout } = useStdout();
  useEffect(() => {
    if (!stdout) return;
    // After Ink finishes painting the current frame, walk the cursor up to
    // the top of our reserved area, write the sixel, then walk back down so
    // Ink's next paint continues where it expected. ESC[<n>A = move up n;
    // ESC[<n>B = move down n.
    stdout.write(`\x1b[${rows}A`);
    stdout.write(seq);
    stdout.write(`\x1b[${rows}B\r`);
  });
  // Reserve rows of vertical space — blank lines that Ink will measure
  // correctly. The sixel overlays this region.
  const blanks: React.ReactElement[] = [];
  for (let i = 0; i < rows; i++) blanks.push(<Text key={i}>{' '}</Text>);
  return <Box flexDirection="column">{blanks}</Box>;
}
