// Bordered overlay that renders arbitrary text for the user to select +
// copy from the terminal directly. No file is written; the user uses their
// terminal's normal selection mechanism (mouse drag / shift+arrow / etc.).
//
// Esc closes via the parent (we accept onClose). We don't trap input
// ourselves — every caller already has a useInput handler that needs to
// know about its own modal precedence, so they wire Esc through to onClose.
import React from 'react';
import { Box, Text } from 'ink';

export interface ExportPanelProps {
  title: string;
  body: string;
  /** Extra hint to print under the body (e.g. "Paste into the Showdown
   *  teambuilder"). Defaults to a generic copy hint. */
  hint?: string;
}

export function ExportPanel({ title, body, hint }: ExportPanelProps) {
  // Split on newlines so Ink can lay out each line independently — pasting
  // a single multi-line string into a <Text> would still render, but per-
  // line keeps wrapping behaviour predictable across terminal widths.
  const lines = body.split('\n');
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">{title}</Text>
      <Box flexDirection="column" marginTop={1}>
        {lines.map((line, i) => (
          <Text key={i}>{line.length === 0 ? ' ' : line}</Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{hint ?? 'Select with your terminal + copy · Esc closes'}</Text>
      </Box>
    </Box>
  );
}
