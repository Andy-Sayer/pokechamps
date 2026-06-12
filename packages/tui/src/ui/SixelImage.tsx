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
import React, { useEffect, useMemo, useRef } from 'react';
import { Box, Text, useStdout } from 'ink';
import { encodeSixel, type Bitmap, type Palette } from './sixel.js';
import { cellPixelHeight } from './sixelSupport.js';

export interface SixelImageProps {
  bitmap: Bitmap;
  palette: Palette;
  /** Nearest-neighbour scale factor (1 = native pixels). */
  scale?: number;
  /** Override the auto-computed row reservation. Use sparingly. */
  rows?: number;
}

// Walk the Ink/yoga layout tree from our Box up to the root: the sum of
// computed tops is the component's absolute ROW within the rendered frame,
// and the root's computed height is the frame's total rows. After Ink paints,
// the cursor sits just below the frame — so "rows to walk up" is
// total − absoluteTop, REGARDLESS of where in the layout we live. (The old
// version walked up only our own reservation, which was correct solely when
// the image was the last thing on screen — mid-layout images painted at the
// bottom of the frame instead.)
interface YogaIsh { getComputedTop(): number; getComputedHeight(): number }
interface DomIsh { yogaNode?: YogaIsh; parentNode?: DomIsh | null }
function rowsFromFrameBottom(node: DomIsh | null): number | null {
  if (!node?.yogaNode) return null;
  let top = 0;
  let cur: DomIsh | null | undefined = node;
  let root: DomIsh = node;
  while (cur) {
    if (cur.yogaNode) { top += cur.yogaNode.getComputedTop(); root = cur; }
    cur = cur.parentNode;
  }
  const total = root.yogaNode!.getComputedHeight();
  const up = total - top;
  return Number.isFinite(up) && up > 0 ? up : null;
}

export function SixelImage({ bitmap, palette, scale = 1, rows }: SixelImageProps) {
  const seq = useMemo(() => encodeSixel(bitmap, palette, { scale }), [bitmap, palette, scale]);
  const { stdout } = useStdout();
  const boxRef = useRef(null);

  // Auto-compute rows from sprite height, +1 row safety pad.
  const pxHeight = bitmap.height * scale;
  // Cell height: the terminal's own answer (XTWINOPS probe at startup) when
  // available, else a conservative 14px. Over-reserving leaves a small gap;
  // under-reserving leaves sixel ghosts on repaint.
  const cellPx = cellPixelHeight();
  const reservedRows = rows ?? Math.ceil(pxHeight / cellPx) + 1;

  useEffect(() => {
    if (!stdout) return;
    // Locate our reservation within the frame via the yoga tree; fall back to
    // the old "we're the last thing rendered" assumption if that fails.
    const up = rowsFromFrameBottom(boxRef.current as DomIsh | null) ?? reservedRows;
    // SAFETY GUARDS — a wrong cursor dance doesn't just misplace the image,
    // it desyncs Ink's paint anchor and erases the UI (seen live):
    //  · up ≥ viewport rows: the target row is scrolled off-screen; ESC[A
    //    clamps at the top but the walk-back still descends the full count,
    //    leaving the cursor below where Ink expects. Skip entirely.
    //  · image touching the bottom margin: sixel scrolling would shift the
    //    whole frame under Ink. Require the image to fit strictly above the
    //    cursor line.
    const viewport = stdout.rows ?? 0;
    const imageRows = Math.ceil(pxHeight / cellPx);
    if (viewport <= 0 || up >= viewport || imageRows >= up) return;
    stdout.write(`\x1b[${up}A`);  // up to the top of our reservation
    stdout.write('\x1b7');         // save cursor (VT100 — widest support)
    stdout.write(seq);             // draw sixel
    stdout.write('\x1b8');         // restore cursor
    stdout.write(`\x1b[${up}B`);   // back down to where Ink expects
    stdout.write('\r');            // column 0
  });

  // Reserve rows of vertical space — blank lines that Ink lays out and
  // clears between paints. The sixel overlays this region.
  const blanks: React.ReactElement[] = [];
  for (let i = 0; i < reservedRows; i++) blanks.push(<Text key={i}>{' '}</Text>);
  return <Box ref={boxRef} flexDirection="column">{blanks}</Box>;
}
