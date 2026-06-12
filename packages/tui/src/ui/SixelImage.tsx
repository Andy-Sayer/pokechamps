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

// Cadence of the self-heal repaint. Fast enough that a layout shift (a
// message appearing, the turn log growing) only blanks the sprite for a
// blink; slow enough that the terminal isn't re-decoding sixels per frame.
const SELF_HEAL_MS = 250;

// Sentinel colors for the reservation rows. Under incremental rendering Ink
// only rewrites lines whose CONTENT changed — identical blank rows compare
// equal across a vertical layout shift, so the old sixel pixels were never
// cleaned and a repaint a few rows lower produced split/doubled sprites.
// An invisibly-colored space per row (distinct SGR per index, and Ink's
// trimEnd doesn't strip a styled space) makes every row unique, so any shift
// forces a real rewrite that erases the stale pixels. All 15 names emit
// distinct codes even at 16-color depth; reservations are ≤8 rows in
// practice. (gray IS blackBright in chalk — don't list both.)
const SENTINELS = [
  'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray',
  'redBright', 'greenBright', 'yellowBright', 'blueBright', 'magentaBright',
  'cyanBright', 'whiteBright',
] as const;

export interface SixelImageProps {
  bitmap: Bitmap;
  palette: Palette;
  /** Nearest-neighbour scale factor (1 = native pixels). */
  scale?: number;
  /** Override the auto-computed row reservation. Use sparingly. */
  rows?: number;
}

// POSITIONING CONTRACT: this component must be (one of) the LAST things in
// the rendered frame. After Ink paints, the cursor sits just below the frame,
// so walking up our OWN reservation lands exactly at its top — valid only
// when nothing renders beneath us. (A yoga-tree walk to support mid-layout
// placement was tried and reverted: any error in the computed distance
// desyncs Ink's paint anchor and ERASES the UI — seen live twice. Callers
// place sixel images at the frame bottom instead; see BattleScreen's strip.)
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

  // REDRAW POLICY: with Ink's incrementalRendering (cli.tsx) unchanged lines
  // are never rewritten, so typing doesn't erase the pixels — redrawing on
  // every React render (the old dep-less effect) burned a full cursor dance +
  // sixel decode per keystroke for nothing ("super jittery"). Instead:
  //   - immediate draw when the image itself changes (deps below), and
  //   - a slow self-heal repaint for the cases that DO clobber the pixels
  //     (a layout shift rewrites the reservation rows positionally; resize).
  // Each draw is one atomic write wrapped in DEC 2026 synchronized output so
  // an in-place overdraw is invisible; terminals without 2026 ignore it.
  useEffect(() => {
    if (!stdout) return;
    const draw = () => {
      // Guard: skip the draw when the reservation can't be reached exactly or
      // the image could touch the bottom margin (sixel scrolling shifts the
      // whole frame under Ink). Skipping is recoverable; desyncing is not.
      const viewport = stdout.rows ?? 0;
      if (viewport <= 0 || reservedRows >= viewport) return;
      stdout.write(
        '\x1b[?2026h' +              // begin synchronized update
        `\x1b[${reservedRows}A` +    // up to the top of our reservation
        '\x1b7' +                    // save cursor (VT100 — widest support)
        '\x1b[2K\x1b[B'.repeat(reservedRows) + // clear our rows (stale pixels)
        '\x1b8' +                    // restore to the reservation top
        seq +                        // draw sixel
        '\x1b8' +                    // restore again (DECSC state persists)
        `\x1b[${reservedRows}B` +    // back down to where Ink expects
        '\r' +                       // column 0
        '\x1b[?2026l',               // end synchronized update
      );
    };
    draw();
    const heal = setInterval(draw, SELF_HEAL_MS);
    return () => clearInterval(heal);
  }, [stdout, seq, reservedRows]);

  // Reserve rows of vertical space the sixel overlays. Each row is an
  // invisibly-colored space (see SENTINELS) so the rows stay unique under
  // Ink's incremental line diff.
  const blanks: React.ReactElement[] = [];
  for (let i = 0; i < reservedRows; i++) {
    blanks.push(<Text key={i} color={SENTINELS[i % SENTINELS.length]}>{' '}</Text>);
  }
  return <Box ref={boxRef} flexDirection="column">{blanks}</Box>;
}
