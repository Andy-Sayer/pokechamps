// Render an indexed bitmap as ANSI half-block characters (▀ / ▄ with
// truecolor fg+bg) — the universal fallback when sixel isn't available.
// Unlike SixelImage this is plain Ink <Text>, so it needs no escape-sequence
// smuggling, no row reservation, and works in every terminal that does
// 24-bit colour (Windows Terminal, VS Code, ConEmu, plain conhost…).
//
// Each text row covers TWO pixel rows: '▀' carries the top pixel as the
// foreground and the bottom pixel as the background. Transparency maps to
// spaces / missing halves ('▀' with no bg, '▄' for bottom-only).
import React from 'react';
import { Box, Text } from 'ink';
import type { Bitmap, Palette } from './sixel.js';

export interface HalfBlockSeg { ch: string; fg?: string; bg?: string }

const hex = (c: readonly [number, number, number]) =>
  `#${c[0].toString(16).padStart(2, '0')}${c[1].toString(16).padStart(2, '0')}${c[2].toString(16).padStart(2, '0')}`;

/** Pure row builder (exported for tests): two pixel rows → one text row of
 *  colour-run segments. */
export function halfBlockRows(bitmap: Bitmap, palette: Palette): HalfBlockSeg[][] {
  const colorOf = (p: number): string | undefined =>
    p > 0 ? hex(palette.colors[p - 1] ?? [0, 0, 0]) : undefined;
  const rows: HalfBlockSeg[][] = [];
  for (let y = 0; y < bitmap.height; y += 2) {
    const segs: HalfBlockSeg[] = [];
    for (let x = 0; x < bitmap.width; x++) {
      const top = colorOf(bitmap.pixels[y * bitmap.width + x]!);
      const bot = y + 1 < bitmap.height ? colorOf(bitmap.pixels[(y + 1) * bitmap.width + x]!) : undefined;
      let cell: HalfBlockSeg;
      if (top && bot) cell = { ch: '▀', fg: top, bg: bot };
      else if (top) cell = { ch: '▀', fg: top };
      else if (bot) cell = { ch: '▄', fg: bot };
      else cell = { ch: ' ' };
      const prev = segs[segs.length - 1];
      if (prev && prev.fg === cell.fg && prev.bg === cell.bg) prev.ch += cell.ch;
      else segs.push(cell);
    }
    rows.push(segs);
  }
  return rows;
}

export function HalfBlockImage({ bitmap, palette }: { bitmap: Bitmap; palette: Palette }) {
  const rows = halfBlockRows(bitmap, palette);
  return (
    <Box flexDirection="column">
      {rows.map((segs, i) => (
        <Text key={i}>
          {segs.map((s, j) => (
            <Text key={j} color={s.fg} backgroundColor={s.bg}>{s.ch}</Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}
