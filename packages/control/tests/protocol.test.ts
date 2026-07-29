// protocol: ControllerState ↔ generic wire frame + the human description. The
// frame layout is a placeholder (firmware-specific encoders come with the
// SerialBackend), but its invariants are pinned so a later real encoder is a
// deliberate, test-visible change.
import { describe, test, expect } from 'vitest';
import {
  encodeState, describeState, neutralState, encodeWiredUart, crc8, hatValue, validateState,
  getCodec, EncodeError, WIRED_UART, type Button, type ControllerState,
} from '../src/index.js';

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

  test('stick extremes map to 0 and 255; out of range is REFUSED, not clamped', () => {
    expect(encodeState(state([], 1, -1))[3]).toBe(255);  // LX = +1 -> 255
    expect(encodeState(state([], 1, -1))[4]).toBe(0);    // LY = -1 -> 0
    // Silently clamping an out-of-range axis turns a caller's bug into a full stick
    // deflection that looks intentional on the wire. The last gate before a console
    // sees the input refuses instead.
    expect(() => encodeState(state([], 5, 0))).toThrow(EncodeError);
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

// EVERY TEST BELOW IS A BUG THE BATTLE-TEST PROBE FOUND IN THE FIRST ENCODER.
// Each one had a silent, wrong output rather than an error — the failure mode that
// matters most here, because the output is button presses on someone's console.
describe('protocol: states that must never reach the wire', () => {
  test('an unknown button is refused — it used to press A', () => {
    // `1 << BIT[b]` with an unmapped name is `1 << undefined` === 1 === bit 0 === A.
    // In a battle menu a stray A confirms whatever the cursor is on.
    const s = neutralState();
    (s.buttons as Set<string>).add('Turbo');
    expect(() => encodeState(s)).toThrow(/unknown button/);
    expect(() => encodeState(s)).toThrow(/would silently press A/);
  });

  test('NaN and Infinity axes are refused — they used to encode as full deflection', () => {
    expect(() => encodeState(state([], NaN, 0))).toThrow(/is NaN/);
    expect(() => encodeState(state([], 0, Infinity))).toThrow(/is Infinity/);
  });

  test('opposing d-pad directions are refused — a hat cannot express them', () => {
    expect(() => encodeState(state(['Up', 'Down']))).toThrow(/Up\+Down/);
    expect(() => encodeState(state(['Left', 'Right']))).toThrow(/Left\+Right/);
    // ...but genuine diagonals are fine.
    expect(() => encodeState(state(['Up', 'Right']))).not.toThrow();
  });

  test('validateState accepts every legal single button', () => {
    for (const b of ['A', 'B', 'X', 'Y', 'L', 'R', 'ZL', 'ZR', 'Home', 'Capture'] as Button[]) {
      expect(() => validateState(state([b]))).not.toThrow();
    }
  });
});

// The wired-uart frame is a REAL published format (switch-fightstick /
// UARTSwitchCon lineage), so these pin the actual bytes a device would receive.
describe('protocol.encodeWiredUart', () => {
  test('neutral frame: no buttons, hat centered (8), sticks at 128', () => {
    const f = encodeWiredUart(neutralState());
    expect(f).toHaveLength(9);
    expect([...f.subarray(0, 8)]).toEqual([0, 0, 8, 128, 128, 128, 128, 0]);
    expect(f[8]).toBe(crc8(f.subarray(0, 8)));
  });

  test('button bits follow the published order (Y=bit0 … ZR=bit7)', () => {
    expect(encodeWiredUart(state(['Y']))[0]).toBe(0x01);
    expect(encodeWiredUart(state(['B']))[0]).toBe(0x02);
    expect(encodeWiredUart(state(['A']))[0]).toBe(0x04);
    expect(encodeWiredUart(state(['X']))[0]).toBe(0x08);
    expect(encodeWiredUart(state(['ZR']))[0]).toBe(0x80);
    expect(encodeWiredUart(state(['Minus']))[1]).toBe(0x01);
    expect(encodeWiredUart(state(['Capture']))[1]).toBe(0x20);
  });

  test('the d-pad is a hat value, not four bits', () => {
    expect(hatValue(new Set())).toBe(8);
    expect(encodeWiredUart(state(['Up']))[2]).toBe(0);
    expect(encodeWiredUart(state(['Right']))[2]).toBe(2);
    expect(encodeWiredUart(state(['Down']))[2]).toBe(4);
    expect(encodeWiredUart(state(['Left']))[2]).toBe(6);
    expect(encodeWiredUart(state(['Down', 'Right']))[2]).toBe(3);
    expect(encodeWiredUart(state(['Up', 'Left']))[2]).toBe(7);
    // A d-pad press must NOT leak into the button mask.
    expect(encodeWiredUart(state(['Up'])).subarray(0, 2)).toEqual(new Uint8Array([0, 0]));
  });

  test('stick Y inverts: our +1 is UP, the wire 255 is DOWN', () => {
    expect(encodeWiredUart(state([], 0, 1))[4]).toBe(0);     // y=+1 (up)   -> 0
    expect(encodeWiredUart(state([], 0, -1))[4]).toBe(255);  // y=-1 (down) -> 255
    expect(encodeWiredUart(state([], 1, 0))[3]).toBe(255);   // x=+1 (right) -> 255
  });

  test('CRC8 is avr-libc _crc8_ccitt_update (poly 0x07, seed 0)', () => {
    expect(crc8([])).toBe(0);
    expect(crc8([0x00])).toBe(0x00);
    // Worked by hand from the algorithm: 0x01 -> eight shifts with the 0x07 poly.
    expect(crc8([0x01])).toBe(0x07);
    expect(crc8([0x02])).toBe(0x0e);
    // The CRC covers bytes 0..7 and changes when any of them does.
    const a = encodeWiredUart(state(['A']));
    const b = encodeWiredUart(state(['B']));
    expect(a[8]).not.toBe(b[8]);
  });

  test('a frame the firmware would reject is never produced', () => {
    const s = neutralState(); s.buttons.add('Up'); s.buttons.add('Down');
    expect(() => encodeWiredUart(s)).toThrow(EncodeError);
  });
});

describe('protocol codec registry', () => {
  test('wired-uart reports the published 9-byte / 19200-baud shape', () => {
    const c = getCodec('wired-uart');
    expect(c.frameBytes).toBe(9);
    expect(c.baudRate).toBe(19200);
    expect(WIRED_UART.handshake).toEqual([0xff, 0x33, 0xcc]);
    expect(WIRED_UART.packetAck).toBe(0x90);
  });

  test('pabotbase2 refuses rather than guessing a framing it does not know', () => {
    expect(() => getCodec('pabotbase2').encode(neutralState())).toThrow(/not implemented/);
  });

  test('an unknown firmware id is refused', () => {
    expect(() => getCodec('nope' as never)).toThrow(EncodeError);
  });
});
