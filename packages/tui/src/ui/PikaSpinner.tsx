// PikaSpinner — renders the real pixel Pikachu via sixel in terminals that
// support it (Windows Terminal Preview ≥1.22, WezTerm, iTerm2, etc.). Where
// sixel can't be used — unsupported terminal, or the battle sprite strip
// already owns the frame-bottom sixel slot — it degrades to a plain braille
// throbber + label. The old hand-drawn ASCII chibi fallback was removed on
// request: sixel sprites or no art at all.
//
// Two sprite sets are available via the `sprite` prop:
//   - 'run'  (default for active thinking): the Lord Libidan running-Pikachu
//   - 'idle' (for ambient / info displays): the BW idle stand
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { SixelImage } from './SixelImage.js';
import { sixelSupported } from './sixelSupport.js';
import {
  IDLE_FRAMES, IDLE_PALETTE,
  RUN_FRAMES, RUN_PALETTE,
} from './pikaSprite.js';

export const FRAME_INTERVAL_MS = 180;

// Plain-text throbber glyphs for the no-sixel path.
export const SPINNER_GLYPHS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

// Pure helper so tests can assert the cycle without mounting React.
export function glyphAt(tick: number): string {
  return SPINNER_GLYPHS[tick % SPINNER_GLYPHS.length]!;
}

export interface PikaSpinnerProps {
  /** Status text shown to the right of the throbber. */
  label?: string;
  /** Which sprite to show (sixel mode only). 'run' = active loading,
   *  'idle' = ambient/info. Default 'run'. */
  sprite?: 'run' | 'idle';
  /** Bypass the runtime sixel-support probe. 'sixel' forces bitmap mode
   *  even on terminals we couldn't auto-detect; 'plain' forces the
   *  text throbber (used when another component owns the sixel slot).
   *  The /pika debug command uses 'sixel' so the user can verify what
   *  their terminal actually renders. */
  force?: 'sixel' | 'plain';
}

// Sixel-bitmap renderer. Cycles through the chosen sprite's frames at the
// shared FRAME_INTERVAL_MS cadence.
function PikaSpinnerSixel({ label, sprite }: { label: string; sprite: 'run' | 'idle' }) {
  const frames = sprite === 'idle' ? IDLE_FRAMES : RUN_FRAMES;
  const palette = sprite === 'idle' ? IDLE_PALETTE : RUN_PALETTE;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), FRAME_INTERVAL_MS);
    return () => clearInterval(t);
  }, []);
  const frame = frames[tick % frames.length]!;
  return (
    <Box flexDirection="row">
      <Box flexDirection="column" marginRight={2}>
        <SixelImage bitmap={frame} palette={palette} />
      </Box>
      <Box alignItems="center">
        <Text color="yellow" bold>{label}</Text>
      </Box>
    </Box>
  );
}

// Plain throbber for the no-sixel path. Ignores `sprite` — no art, just the
// braille cycle and the label.
function PikaSpinnerPlain({ label }: { label: string }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), FRAME_INTERVAL_MS);
    return () => clearInterval(t);
  }, []);
  return (
    <Text color="yellow" bold>{glyphAt(tick)} {label}</Text>
  );
}

export function PikaSpinner({
  label = 'Pikachu thinking…',
  sprite = 'run',
  force,
}: PikaSpinnerProps) {
  // Cache the support check at first render — env vars don't change at
  // runtime and re-probing on every tick is wasteful. `force` overrides.
  const useSixel = useMemo(() => force
    ? force === 'sixel'
    : sixelSupported(), [force]);
  return useSixel
    ? <PikaSpinnerSixel label={label} sprite={sprite} />
    : <PikaSpinnerPlain label={label} />;
}
