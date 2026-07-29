// Lower a GameAction (engine intent) into an InputAction sequence for the
// Champions doubles battle menu.
//
// ⚠ CALIBRATION REQUIRED. The Champions doubles battle-menu layout has NOT been
// verified against the real game — every sequence below is a BEST-GUESS using
// generic Pokémon battle-UI conventions. `MENU_NAV_CALIBRATED` is false; the
// dry-run prints a warning and any future live-send path must refuse to send
// uncalibrated input. Calibration is a data edit of this map, confirmed by
// observation (the vision side can watch the cursor). Keep the sequences
// declarative so calibrating is editing tables, not logic.
import type { Button, GameAction, InputAction, TargetRef } from './types.js';

/** Flip to true only once each sequence below is verified on the real UI. */
export const MENU_NAV_CALIBRATED = false;

const tap = (button: Button, holdMs?: number): InputAction => ({ kind: 'press', button, holdMs });
const repeat = (button: Button, n: number): InputAction[] =>
  Array.from({ length: Math.max(0, n) }, () => tap(button));

const DIR_BUTTON: Record<'up' | 'down' | 'left' | 'right', Button> = {
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
};

// GUESS: in doubles the target cursor opens on the first foe (o1); Right hops to
// the second foe, Down crosses to the ally row.
const TARGET_NAV: Record<TargetRef, InputAction[]> = {
  o1: [],
  o2: [tap('Right')],
  m1: [tap('Down')],
  m2: [tap('Down'), tap('Right')],
};

/** Reject a slot that isn't a whole number in range. The battle-test probe found
 *  every one of these accepted silently and turned into the WRONG press:
 *  `benchSlot: 0` clamped to zero Downs and so picked party member 1; `slot: 9`
 *  emitted eight Downs into a four-move list; a fractional slot emitted
 *  `Math.max(0, 1.7)` presses. A wrong press on a live console is worse than a
 *  refusal, so these throw. */
function checkSlot(name: string, v: number, min: number, max: number): number {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}], got ${v}`);
  }
  return v;
}

/** The largest party position a switch can target (6 mons, minus the active). */
const MAX_BENCH_SLOT = 5;

function lowerMove(slot: number, target?: TargetRef): InputAction[] {
  checkSlot('move slot', slot, 1, 4);
  // GUESS: the move list opens with the cursor on move 1; Down steps down it.
  const seq: InputAction[] = [...repeat('Down', slot - 1), tap('A')];
  // Doubles prompts for a target after the move is chosen.
  if (target) seq.push(...TARGET_NAV[target], tap('A'));
  else seq.push(tap('A')); // accept the default target
  return seq;
}

function lowerSwitch(benchSlot: number): InputAction[] {
  checkSlot('benchSlot', benchSlot, 1, MAX_BENCH_SLOT);
  // GUESS: open the Pokémon/switch screen, step to the benchSlot-th party
  // member, confirm the pick + the swap.
  return [tap('Y'), ...repeat('Down', benchSlot - 1), tap('A'), tap('A')];
}

function lowerMega(): InputAction[] {
  // GUESS: the Champions Mega toggle on the move screen (a modifier press before
  // confirming the attack). Placeholder until calibrated.
  return [tap('R')];
}

/** Lower a GameAction into the controller InputAction sequence. */
export function lowerGameAction(a: GameAction): InputAction[] {
  switch (a.kind) {
    case 'move': return lowerMove(a.slot, a.target);
    case 'switch': return lowerSwitch(a.benchSlot);
    case 'mega': return lowerMega();
    case 'confirm': return [tap('A')];
    case 'back': return [tap('B')];
    case 'cursor': return repeat(DIR_BUTTON[a.dir], checkSlot('cursor times', a.times ?? 1, 0, 20));
  }
}

/**
 * THE SAFETY INTERLOCK. Until now "an uncalibrated sequence must never be sent"
 * lived only in a README sentence and a boolean nobody consulted — the dry-run
 * printed a warning and every other path was free to send. This is the function
 * a live backend calls before the first frame, so the rule is enforced in code.
 *
 * `menuNav` is a best-guess at the Champions doubles UI. Sending a guessed
 * sequence to a real console does not fail safely: presses land on whatever the
 * cursor happens to be over, mid-battle, with a turn timer running.
 */
export function assertSendable(opts?: { force?: boolean }): void {
  if (MENU_NAV_CALIBRATED || opts?.force) return;
  throw new Error(
    'refusing to send: menuNav is NOT calibrated against the real Champions UI ' +
    '(MENU_NAV_CALIBRATED = false), so every sequence is a best-guess and the presses would ' +
    'land on whatever the cursor is over. Calibrate the tables in menuNav.ts against the game ' +
    '(the vision side can watch the cursor), or pass { force: true } for a deliberate ' +
    'calibration run on a screen where a wrong press is harmless.',
  );
}

/** Human-readable one-token description of an InputAction (for the dry-run). */
export function describeInput(a: InputAction): string {
  switch (a.kind) {
    case 'press': return a.holdMs ? `${a.button}(${a.holdMs}ms)` : a.button;
    case 'hold': return `${a.button}↓`;
    case 'release': return `${a.button}↑`;
    case 'tilt': return `${a.stick}-stick(${a.x},${a.y},${a.ms}ms)`;
    case 'wait': return `wait ${a.ms}ms`;
  }
}
