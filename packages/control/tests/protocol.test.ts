// protocol: ControllerState ↔ generic wire frame + the human description. The
// frame layout is a placeholder (firmware-specific encoders come with the
// SerialBackend), but its invariants are pinned so a later real encoder is a
// deliberate, test-visible change.
import { describe, test, expect } from 'vitest';
import { encodeState, describeState, neutralState, type Button, type ControllerState } from '../src/index.js';

function state(buttons: Button[], lx = 0, ly = 0): ControllerState {
  return { buttons: new Set(buttons), leftStick: { x: lx, y: ly }, rightStick: { x: 0, y: 0 } };
}

describe('protocol.encodeState', () => {
  test('neutral = no buttons, centered sticks (128)', () => {
    expect([...encodeState(neutralState())]).toEqual([0, 0, 0, 128, 128, 128, 128]);
  });

  test('A is bit 0 of the button mask', () => {
    const frame = encodeState(state(['A']));
    expect(frame[0]! & 0b1).toBe(1);
  });

  test('stick extremes map to 0 and 255, clamped', () => {
    expect(encodeState(state([], 1, -1))[3]).toBe(255);  // LX = +1 -> 255
    expect(encodeState(state([], 1, -1))[4]).toBe(0);    // LY = -1 -> 0
    expect(encodeState(state([], 5, 0))[3]).toBe(255);   // overshoot clamps
  });

  test('frame is 7 bytes (3 mask + 4 stick)', () => {
    expect(encodeState(neutralState())).toHaveLength(7);
  });
});

describe('protocol.describeState', () => {
  test('neutral renders as (neutral)', () => {
    expect(describeState(neutralState())).toBe('(neutral)');
  });
  test('buttons + stick render together', () => {
    expect(describeState(state(['A'], 1, 0))).toBe('A L(1.0,0.0)');
  });
});
