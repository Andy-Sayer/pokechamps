// Tiny chibi-Pikachu throbber used while the AI is thinking. Three short
// lines (ears / face / chin) so it actually reads as a creature rather than
// just a row of glyphs. The middle row's face cycles through expressions and
// cheek-spark states; the ears and chin stay still, keeping the silhouette
// stable enough that the eye moves catch the user's eye.
//
// The exported `spinnerFrames` array is the single source of truth — both
// the React component and the test consume it. Each frame is the full 3-line
// silhouette so tests can verify width parity without parsing the component.
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';

export interface PikaFrame {
  /** Ears row — the two pointy `/\__/\` ear silhouette. */
  top: string;
  /** Face row — the part that animates: eyes + cheek glow + side sparks. */
  mid: string;
  /** Chin row — round bottom of the head. */
  bot: string;
}

// Six frames cycle through: idle → cheek glow → spark left → cheek glow →
// blink → spark right. All rows are padded to 11 columns so the silhouette
// stays vertically aligned regardless of which frame is showing.
export const spinnerFrames: readonly PikaFrame[] = [
  { top: '   /\\__/\\  ', mid: '  ( o.o )  ', bot: '   \\____/  ' },
  { top: '   /\\__/\\  ', mid: ' •( o.o )• ', bot: '   \\____/  ' },
  { top: ' ⚡ /\\__/\\  ', mid: '  ( O.O )  ', bot: '   \\____/  ' },
  { top: '   /\\__/\\  ', mid: ' •( O.O )• ', bot: '   \\____/  ' },
  { top: '   /\\__/\\  ', mid: '  ( -.- )  ', bot: '   \\____/  ' },
  { top: '   /\\__/\\ ⚡', mid: '  ( O.O )  ', bot: '   \\____/  ' },
];

export const FRAME_INTERVAL_MS = 180;

export interface PikaSpinnerProps {
  /** Status text shown to the right of the throbber. */
  label?: string;
  /** Override the colour of the silhouette + label. Default 'yellow' (Pika hue). */
  color?: string;
}

export function PikaSpinner({ label = 'Pikachu thinking…', color = 'yellow' }: PikaSpinnerProps) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), FRAME_INTERVAL_MS);
    return () => clearInterval(t);
  }, []);
  const frame = frameAt(tick);
  return (
    <Box flexDirection="row">
      <Box flexDirection="column" marginRight={2}>
        <Text color={color}>{frame.top}</Text>
        <Text color={color} bold>{frame.mid}</Text>
        <Text color={color}>{frame.bot}</Text>
      </Box>
      <Box alignItems="center">
        <Text color={color}>{label}</Text>
      </Box>
    </Box>
  );
}

// Pure helper so tests can assert the cycle without mounting React.
export function frameAt(tick: number): PikaFrame {
  return spinnerFrames[tick % spinnerFrames.length]!;
}
