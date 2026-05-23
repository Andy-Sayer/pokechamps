// Renders arbitrary text for the user to select + copy from the terminal
// directly. No file is written; the user uses their terminal's normal
// selection mechanism (mouse drag / shift+arrow / etc.).
//
// IMPORTANT: the body lines render with NO surrounding bordered box. Ink's
// borderStyle draws a `│` on the left of every body line, and that pipe
// gets included when the user selects text. Instead we use horizontal
// rules above and below the body as a visual frame, leaving the body lines
// pristine for copy.
//
// Esc closes via the parent (we accept onClose). We don't trap input
// ourselves — every caller already has a useInput handler that needs to
// know about its own modal precedence, so they wire Esc through to the
// callsite.
import React from 'react';
import { Box, Text } from 'ink';

export interface ExportPanelProps {
  title: string;
  body: string;
  /** Extra hint to print under the body (e.g. "Paste into the Showdown
   *  teambuilder"). Defaults to a generic copy hint. */
  hint?: string;
}

const RULE = '─'.repeat(60);

export function ExportPanel({ title, body, hint }: ExportPanelProps) {
  // Split on newlines so Ink can lay out each line independently — pasting
  // a single multi-line string into a <Text> would still render, but per-
  // line keeps wrapping behaviour predictable across terminal widths.
  const lines = body.split('\n');
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">{title}</Text>
      <Text dimColor>{RULE}</Text>
      {/* Body — no Box wrapper, no border, no padding. Each <Text> renders
          flush-left so terminal selection grabs the raw text. */}
      {lines.map((line, i) => (
        <Text key={i}>{line.length === 0 ? ' ' : line}</Text>
      ))}
      <Text dimColor>{RULE}</Text>
      <Text dimColor>{hint ?? 'Select with your terminal + copy · Esc closes'}</Text>
    </Box>
  );
}
