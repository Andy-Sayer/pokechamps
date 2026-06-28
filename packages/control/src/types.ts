// Canonical controller + battle-action vocabulary for the OUTPUT adapter — the
// mirror of @pokechamps/vision's INPUT side. The vision adapter turns the
// screen into canonical turn-log lines; this package turns a canonical battle
// intent (GameAction) into the controller input the Switch sees.
//
//   GameAction  --menuNav.ts-->  InputAction[]  --controller.ts-->  ControllerState stream  --backend-->  device
//
// A ControllerState is one Nintendo Switch Pro-Controller report snapshot: the
// set of currently-held buttons + stick positions. The device backend streams
// these at the controller report rate; "press A for 80ms" is just asserting
// A-held, waiting, then asserting A-released (timing lives in the Controller).

export type Button =
  | 'A' | 'B' | 'X' | 'Y'
  | 'L' | 'R' | 'ZL' | 'ZR'
  | 'Plus' | 'Minus' | 'Home' | 'Capture'
  | 'LClick' | 'RClick'
  | 'Up' | 'Down' | 'Left' | 'Right'; // Dpad

/** Stable bit order for protocol encoding; also the canonical button list. */
export const ALL_BUTTONS: readonly Button[] = [
  'A', 'B', 'X', 'Y', 'L', 'R', 'ZL', 'ZR',
  'Plus', 'Minus', 'Home', 'Capture', 'LClick', 'RClick',
  'Up', 'Down', 'Left', 'Right',
];

export type StickName = 'left' | 'right';

/** Stick position; each axis in [-1, 1], (0,0) = centered. */
export interface StickPos { x: number; y: number }

/** One Pro-Controller report snapshot: held buttons + both stick positions. */
export interface ControllerState {
  buttons: Set<Button>;
  leftStick: StickPos;
  rightStick: StickPos;
}

/** A controller state asserted for a duration (ms). A run is a list of these. */
export interface ControllerStep { state: ControllerState; durationMs: number }

export const CENTER: StickPos = { x: 0, y: 0 };

export function neutralState(): ControllerState {
  return { buttons: new Set<Button>(), leftStick: { ...CENTER }, rightStick: { ...CENTER } };
}

// --- Input primitives: what menuNav lowers a GameAction into; the Controller
//     runs them, producing the ControllerState stream. -----------------------
export type InputAction =
  | { kind: 'press'; button: Button; holdMs?: number }  // tap: hold then release
  | { kind: 'hold'; button: Button }                    // press and keep held
  | { kind: 'release'; button: Button }                 // release a held button
  | { kind: 'tilt'; stick: StickName; x: number; y: number; ms: number }
  | { kind: 'wait'; ms: number };

// --- Engine-facing battle intent. Doubles target refs mirror the turn-log
//     vocabulary (o1/o2 = foe slots, m1/m2 = my slots). -----------------------
export type TargetRef = 'o1' | 'o2' | 'm1' | 'm2';

export type GameAction =
  | { kind: 'move'; slot: 1 | 2 | 3 | 4; target?: TargetRef }
  | { kind: 'switch'; benchSlot: number } // 1-based position in the switch list
  | { kind: 'mega' }
  | { kind: 'confirm' }
  | { kind: 'back' }
  | { kind: 'cursor'; dir: 'up' | 'down' | 'left' | 'right'; times?: number };
