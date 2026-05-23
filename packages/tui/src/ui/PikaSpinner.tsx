// PikaSpinner — dispatches to a sixel-bitmap renderer in terminals that
// support it (Windows Terminal Preview ≥1.22, WezTerm, iTerm2, etc.) and
// falls back to a chibi half-block ASCII Pikachu elsewhere.
//
// Two sprite sets are available via the `sprite` prop:
//   - 'run'  (default for active thinking): the Lord Libidan running-Pikachu
//   - 'idle' (for ambient / info displays): the BW idle stand
//
// The half-block fallback ignores `sprite` — it just runs the same chibi
// silhouette cycle. The animation cadence (~150-180ms) matches between the
// two so neither feels jarring relative to the other.
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { SixelImage } from './SixelImage.js';
import { sixelSupported } from './sixelSupport.js';
import {
  IDLE_FRAMES, IDLE_PALETTE,
  RUN_FRAMES, RUN_PALETTE,
} from './pikaSprite.js';

// Named colour helpers — keep the palette tight so the throbber reads as
// Pikachu and not a Christmas tree.
type SegColor = 'yellow' | 'red' | 'redBright' | 'white' | 'gray';

export interface PikaSeg {
  text: string;
  color?: SegColor; // omit → inherit the wrapping body colour (yellow)
}

export interface PikaFrame {
  /** Ears row — pointy `/\__/\` silhouette. */
  top: PikaSeg[];
  /** Face row — eyes + cheek dots; the part that animates. */
  mid: PikaSeg[];
  /** Chin row — round bottom of the head. */
  bot: PikaSeg[];
}

// Frame width is 11 columns (every row totals 11 code points). The ears and
// chin stay constant; the face cycles through six expressions, and sparks
// hop between sides on three of those frames so the eye is drawn into the
// silhouette rather than just to a flashing corner.
const EARS_TOP: PikaSeg[] = [{ text: '   /\\__/\\  ' }];                    // 11
const CHIN:    PikaSeg[] = [{ text: '   \\____/  ' }];                      // 11

const FACE_CALM: PikaSeg[] = [
  { text: '  (' },
  { text: '●', color: 'red' },
  { text: 'o.o' },
  { text: '●', color: 'red' },
  { text: ')  ' },
];                                                                          // 11
const FACE_WIDE: PikaSeg[] = [
  { text: '  (' },
  { text: '●', color: 'red' },
  { text: 'O.O' },
  { text: '●', color: 'red' },
  { text: ')  ' },
];                                                                          // 11
const FACE_BLINK: PikaSeg[] = [
  { text: '  (' },
  { text: '●', color: 'red' },
  { text: '-.-' },
  { text: '●', color: 'red' },
  { text: ')  ' },
];                                                                          // 11
const FACE_CHEEK_PULSE: PikaSeg[] = [
  { text: ' ' },
  { text: '◉', color: 'redBright' },
  { text: '(' },
  { text: '●', color: 'red' },
  { text: 'o.o' },
  { text: '●', color: 'red' },
  { text: ')' },
  { text: '◉', color: 'redBright' },
  { text: ' ' },
];                                                                          // 11

const EARS_SPARK_LEFT: PikaSeg[] = [
  { text: ' ' },
  { text: '⚡', color: 'white' },
  { text: ' /\\__/\\  ' },
];                                                                          // 11
const EARS_SPARK_RIGHT: PikaSeg[] = [
  { text: '   /\\__/\\ ' },
  { text: '⚡', color: 'white' },
];                                                                          // 11

export const spinnerFrames: readonly PikaFrame[] = [
  { top: EARS_TOP,         mid: FACE_CALM,         bot: CHIN }, // calm
  { top: EARS_TOP,         mid: FACE_CHEEK_PULSE,  bot: CHIN }, // cheek pulse
  { top: EARS_SPARK_LEFT,  mid: FACE_WIDE,         bot: CHIN }, // ⚡ left + eyes wide
  { top: EARS_TOP,         mid: FACE_CHEEK_PULSE,  bot: CHIN }, // cheek pulse
  { top: EARS_SPARK_RIGHT, mid: FACE_WIDE,         bot: CHIN }, // ⚡ right + eyes wide
  { top: EARS_TOP,         mid: FACE_BLINK,        bot: CHIN }, // blink
];

export const FRAME_INTERVAL_MS = 180;

// Sum the visible width of a row in Unicode code points (not UTF-16 units,
// so `⚡` counts as one column). Exported for the width-parity test.
export function segWidth(segs: readonly PikaSeg[]): number {
  let n = 0;
  for (const s of segs) n += [...s.text].length;
  return n;
}

export interface PikaSpinnerProps {
  /** Status text shown to the right of the throbber. */
  label?: string;
  /** Override the colour of unmarked body segments + label (half-block only).
   *  Sixel rendering uses the sprite's baked palette. Default 'yellow'. */
  bodyColor?: SegColor;
  /** Which sprite to show (sixel mode only). 'run' = active loading,
   *  'idle' = ambient/info. Default 'run'. */
  sprite?: 'run' | 'idle';
}

function renderRow(segs: readonly PikaSeg[], bodyColor: SegColor): React.ReactElement {
  return (
    <Text color={bodyColor}>
      {segs.map((s, i) =>
        s.color
          ? <Text key={i} color={s.color} bold={s.color === 'red' || s.color === 'redBright'}>{s.text}</Text>
          : <React.Fragment key={i}>{s.text}</React.Fragment>,
      )}
    </Text>
  );
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

// Half-block ASCII fallback. Used when sixel isn't supported (or
// POKECHAMPS_SIXEL=0 is set). Ignores `sprite` — same chibi silhouette
// either way.
function PikaSpinnerHalfBlock({ label, bodyColor }: { label: string; bodyColor: SegColor }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), FRAME_INTERVAL_MS);
    return () => clearInterval(t);
  }, []);
  const frame = frameAt(tick);
  return (
    <Box flexDirection="row">
      <Box flexDirection="column" marginRight={2}>
        {renderRow(frame.top, bodyColor)}
        {renderRow(frame.mid, bodyColor)}
        {renderRow(frame.bot, bodyColor)}
      </Box>
      <Box alignItems="center">
        <Text color={bodyColor} bold>{label}</Text>
      </Box>
    </Box>
  );
}

export function PikaSpinner({
  label = 'Pikachu thinking…',
  bodyColor = 'yellow',
  sprite = 'run',
}: PikaSpinnerProps) {
  // Cache the support check at first render — env vars don't change at
  // runtime and re-probing on every tick is wasteful.
  const useSixel = useMemo(() => sixelSupported(), []);
  return useSixel
    ? <PikaSpinnerSixel label={label} sprite={sprite} />
    : <PikaSpinnerHalfBlock label={label} bodyColor={bodyColor} />;
}

// Pure helper so tests can assert the cycle without mounting React.
export function frameAt(tick: number): PikaFrame {
  return spinnerFrames[tick % spinnerFrames.length]!;
}
