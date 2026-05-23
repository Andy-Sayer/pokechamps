// Render a single bitmap frame as a sixel escape sequence.
//
// Why this isn't just `<Text>{seq}</Text>`: Ink runs text content through
// wrap-ansi + width measurement, which strips/escapes the DCS (ESC P ...
// ESC \) bytes before they reach the terminal. preview-pika.ts works
// because it writes directly to stdout outside Ink.
//
// Why this isn't just `useEffect → stdout.write(seq)`: every animation
// frame, Ink re-renders the spinner. Ink only knows how many *terminal
// rows* its `<Text>` blanks occupy (we reserve `rows`), but the actual
// sixel pixel image typically spans MORE rows than that (cell height is
// usually 16-20px, sprite is 46-57px tall = 3-4 rows). On the next paint
// Ink clears only the rows it reserved, so the bottom half of the
// previous sprite stays on screen as a ghost. Multiple ghosts pile up
// over time — exactly what the user reported ("appears twice, once
// static and once animated").
//
// Fix: figure out roughly how many terminal rows the sprite actually
// occupies (pixels / typical cell height) and reserve THAT many. Save +
// restore cursor on every emit so we don't drift. Use sixel header
// `0;1q` (P1=0 = default aspect, P2=1 = transparent background) so the
// sprite doesn't repaint cells outside its bounding box.
//
// Approximate cell height — Ink doesn't expose font metrics, so we use
// a conservative average. Slightly overshooting the row reservation is
// fine (small gap below the sprite); undershooting leaves ghosts.
const APPROX_CELL_PX = 14;

import React, { useEffect, useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';
import { encodeSixel, type Bitmap, type Palette } from './sixel.js';

export interface SixelImageProps {
  bitmap: Bitmap;
  palette: Palette;
  /** Nearest-neighbour scale factor (1 = native pixels). */
  scale?: number;
  /** Override the auto-computed row reservation. Use sparingly. */
  rows?: number;
}

export function SixelImage({ bitmap, palette, scale = 1, rows }: SixelImageProps) {
  const seq = useMemo(() => encodeSixel(bitmap, palette, { scale }), [bitmap, palette, scale]);
  const { stdout } = useStdout();

  // Auto-compute rows from sprite height, +1 row safety pad.
  const pxHeight = bitmap.height * scale;
  const reservedRows = rows ?? Math.ceil(pxHeight / APPROX_CELL_PX) + 1;

  useEffect(() => {
    if (!stdout) return;
    // After Ink finishes painting, the cursor is below the last row we
    // reserved (Ink writes blank lines top-to-bottom). Walk up to the top
    // of our reservation, save cursor, draw, restore. Save/restore via
    // ESC 7 / ESC 8 (the classic VT100 form — more terminals honour it
    // than ESC [ s / ESC [ u).
    stdout.write(`\x1b[${reservedRows}A`); // up to top of reservation
    stdout.write('\x1b7');                  // save cursor (VT100)
    stdout.write(seq);                      // draw sixel
    stdout.write('\x1b8');                  // restore cursor
    stdout.write(`\x1b[${reservedRows}B`);  // down to where Ink expects
    stdout.write('\r');                     // column 0
  });

  // Reserve rows of vertical space — blank lines that Ink lays out and
  // clears between paints. The sixel overlays this region.
  const blanks: React.ReactElement[] = [];
  for (let i = 0; i < reservedRows; i++) blanks.push(<Text key={i}>{' '}</Text>);
  return <Box flexDirection="column">{blanks}</Box>;
}
