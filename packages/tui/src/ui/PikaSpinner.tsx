// Tiny Ink spinner used while the AI is thinking. Frames are intentionally
// short (a couple of glyphs each) so they fit inline with a status message
// like "Pikachu thinking… ⚡(>'-')>". The frame index advances on a 120ms
// interval that's cleared when the component unmounts.
//
// The exported `spinnerFrames` array is the single source of truth and is
// used by the test to assert the cycle progresses. Keep it short and visually
// distinct; the goal is "something is happening", not a flipbook.
import React, { useEffect, useState } from 'react';
import { Text } from 'ink';

// Pikachu cheek-spark animation. Tail wags left/right with little lightning
// bolts firing alongside. Reads as motion in a monospace cell.
export const spinnerFrames: readonly string[] = [
  "⚡(>'-')>  ",
  "  <('-'<)⚡",
  " ⚡^('-')^ ",
  "  <('-'<)⚡",
];

export const FRAME_INTERVAL_MS = 120;

export interface PikaSpinnerProps {
  /** Status text shown after the animated frame. Default 'Pikachu thinking…'. */
  label?: string;
  /** Override the colour of the label (defaults to yellow — Pikachu's hue). */
  color?: string;
}

export function PikaSpinner({ label = 'Pikachu thinking…', color = 'yellow' }: PikaSpinnerProps) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      setFrame(f => (f + 1) % spinnerFrames.length);
    }, FRAME_INTERVAL_MS);
    return () => clearInterval(t);
  }, []);
  return (
    <Text color={color}>
      {spinnerFrames[frame]} {label}
    </Text>
  );
}

// Test-only: deterministic frame for a given tick count. Pure function so we
// can unit-test the cycle without rendering.
export function frameAt(tick: number): string {
  return spinnerFrames[tick % spinnerFrames.length]!;
}
