// menuNav: GameActions lower into sensible InputAction sequences. These pin the
// SHAPE (cursor steps + confirms), not the exact UI — the sequences are
// best-guess until calibrated (MENU_NAV_CALIBRATED stays false), and these tests
// are what a calibration edit updates alongside the map.
import { describe, test, expect } from 'vitest';
import { lowerGameAction, MENU_NAV_CALIBRATED, type InputAction, assertSendable } from '../src/index.js';

const buttons = (seq: InputAction[]): string[] =>
  seq.map(a => (a.kind === 'press' ? a.button : a.kind));

describe('menuNav.lowerGameAction', () => {
  test('move slot N steps down N-1 times then confirms', () => {
    expect(buttons(lowerGameAction({ kind: 'move', slot: 1 }))).toEqual(['A', 'A']);
    expect(buttons(lowerGameAction({ kind: 'move', slot: 3 }))).toEqual(['Down', 'Down', 'A', 'A']);
  });

  test('move with an explicit target navigates the target cursor', () => {
    expect(buttons(lowerGameAction({ kind: 'move', slot: 1, target: 'o2' }))).toEqual(['A', 'Right', 'A']);
    expect(buttons(lowerGameAction({ kind: 'move', slot: 1, target: 'm2' }))).toEqual(['A', 'Down', 'Right', 'A']);
  });

  test('switch opens the party screen and picks the slot', () => {
    expect(buttons(lowerGameAction({ kind: 'switch', benchSlot: 2 }))).toEqual(['Y', 'Down', 'A', 'A']);
  });

  test('mega / confirm / back / cursor', () => {
    expect(buttons(lowerGameAction({ kind: 'mega' }))).toEqual(['R']);
    expect(buttons(lowerGameAction({ kind: 'confirm' }))).toEqual(['A']);
    expect(buttons(lowerGameAction({ kind: 'back' }))).toEqual(['B']);
    expect(buttons(lowerGameAction({ kind: 'cursor', dir: 'down', times: 3 }))).toEqual(['Down', 'Down', 'Down']);
  });

  test('still flagged uncalibrated (no live send until verified)', () => {
    expect(MENU_NAV_CALIBRATED).toBe(false);
  });
});

describe('menuNav: bounds and the safety interlock', () => {
  test('out-of-range slots are refused, not silently mis-pressed', () => {
    // Every one of these was accepted before and turned into the WRONG press:
    // benchSlot 0 clamped to zero Downs and picked party member 1.
    expect(() => lowerGameAction({ kind: 'switch', benchSlot: 0 })).toThrow(RangeError);
    expect(() => lowerGameAction({ kind: 'switch', benchSlot: 9 })).toThrow(RangeError);
    expect(() => lowerGameAction({ kind: 'move', slot: 9 as never })).toThrow(RangeError);
    expect(() => lowerGameAction({ kind: 'move', slot: 0 as never })).toThrow(RangeError);
    expect(() => lowerGameAction({ kind: 'move', slot: 2.7 as never })).toThrow(RangeError);
    expect(() => lowerGameAction({ kind: 'cursor', dir: 'up', times: -1 })).toThrow(RangeError);
  });

  test('the legal range still works', () => {
    for (const slot of [1, 2, 3, 4] as const) {
      expect(lowerGameAction({ kind: 'move', slot })).toHaveLength(slot - 1 + 2);
    }
    for (const benchSlot of [1, 2, 3, 4, 5]) {
      expect(() => lowerGameAction({ kind: 'switch', benchSlot })).not.toThrow();
    }
  });

  test('assertSendable refuses while menuNav is uncalibrated', () => {
    // The rule used to live only in a README sentence and a boolean nobody read.
    expect(MENU_NAV_CALIBRATED).toBe(false);
    expect(() => assertSendable()).toThrow(/NOT calibrated/);
    expect(() => assertSendable({ force: true })).not.toThrow();
  });
});
