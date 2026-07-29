// Wire encoding for a ControllerState, plus a human-readable description.
//
// Two real encoders and one stub live here, behind a `FirmwareCodec` seam:
//
//   'debug'      — the generic 7-byte form the MockBackend + dry-run show. Not a
//                  device format; it exists so the transcript is concrete and so
//                  encoding is testable with no MCU attached.
//   'wired-uart' — the REAL 9-byte UART packet of the switch-fightstick /
//                  UARTSwitchCon firmware lineage (Pico / RP2040 / ATmega32u4),
//                  spec'd at https://github.com/nullstalgia/UARTSwitchCon.
//                  Fully implemented: the format is published and fixed, so it
//                  can be written and tested before any hardware exists.
//   'pabotbase2' — Pokémon Automation's ESP32 firmware. Declared, NOT written:
//                  its framing is a versioned request/ack protocol with its own
//                  handshake, and guessing would produce code that looks finished
//                  and isn't. It throws with a pointer instead.
//
// THE D-PAD IS A HAT, NOT FOUR BITS. Every real Switch report encodes the d-pad
// as one 0-8 hat value, so "Up and Down held together" is not merely wrong, it is
// unrepresentable. The previous generic encoder gave each direction its own bit
// and emitted that impossible state happily; `validateState` now rejects it.
import { ALL_BUTTONS, type Button, type ControllerState, type StickPos } from './types.js';

const BIT: Record<Button, number> = Object.fromEntries(
  ALL_BUTTONS.map((b, i) => [b, i]),
) as Record<Button, number>;

/** Thrown for any state that could not be put on the wire faithfully. Encoding is
 *  the last gate before a console sees the input, so it fails loudly rather than
 *  sending something the caller did not mean. */
export class EncodeError extends Error {}

/**
 * Reject states that cannot be encoded honestly. Every check here is a bug the
 * battle-test probe found in the first encoder, and each one produced a silent,
 * WRONG output rather than an error:
 *   • an unknown button name -> `1 << undefined` === 1 === bit 0 === **A**. A
 *     stray button name therefore pressed A, which in a battle menu confirms
 *     whatever the cursor sits on. The worst failure mode in the package.
 *   • NaN / Infinity on a stick axis -> clamped to byte 0, i.e. FULL DEFLECTION.
 *   • Up+Down (or Left+Right) together -> not representable as a hat.
 */
export function validateState(s: ControllerState): void {
  for (const b of s.buttons) {
    if (!(b in BIT)) throw new EncodeError(`unknown button ${JSON.stringify(b)} (would silently press A)`);
  }
  if (s.buttons.has('Up') && s.buttons.has('Down')) throw new EncodeError('d-pad Up+Down held together is not representable');
  if (s.buttons.has('Left') && s.buttons.has('Right')) throw new EncodeError('d-pad Left+Right held together is not representable');
  for (const [name, p] of [['left', s.leftStick], ['right', s.rightStick]] as const) {
    for (const axis of ['x', 'y'] as const) {
      const v = p[axis];
      if (!Number.isFinite(v)) throw new EncodeError(`${name}Stick.${axis} is ${v} (would encode as full deflection)`);
      if (v < -1 || v > 1) throw new EncodeError(`${name}Stick.${axis}=${v} out of range [-1,1]`);
    }
  }
}

/** Map an axis in [-1, 1] to a byte 0..255 with 0 -> 128 (center). */
function axisByte(v: number): number {
  const clamped = Math.max(-1, Math.min(1, v));
  return Math.round((clamped + 1) * 127.5);
}

/** The 0-8 hat value for the held d-pad directions. 8 = centered. */
export function hatValue(buttons: ReadonlySet<Button>): number {
  const up = buttons.has('Up'), down = buttons.has('Down');
  const left = buttons.has('Left'), right = buttons.has('Right');
  if (up && right) return 1;
  if (down && right) return 3;
  if (down && left) return 5;
  if (up && left) return 7;
  if (up) return 0;
  if (right) return 2;
  if (down) return 4;
  if (left) return 6;
  return 8;
}

/** Encode a state to the generic debug frame (7 bytes). Validated first. */
export function encodeState(s: ControllerState): Uint8Array {
  validateState(s);
  let mask = 0;
  for (const b of s.buttons) mask |= 1 << BIT[b]!;
  return new Uint8Array([
    mask & 0xff, (mask >> 8) & 0xff, (mask >> 16) & 0xff,
    axisByte(s.leftStick.x), axisByte(s.leftStick.y),
    axisByte(s.rightStick.x), axisByte(s.rightStick.y),
  ]);
}

// --- wired-uart (switch-fightstick / UARTSwitchCon lineage) -----------------
// 9 bytes @ 19200 baud, the firmware acking 0x90 per packet:
//   0: buttons MSB  Y B A X L R ZL ZR      (bit 0 = Y)
//   1: buttons LSB  Minus Plus LClick RClick Home Capture SL SR
//   2: HAT (0-8, 8 = centered)
//   3..6: LX LY RX RY  (0..255, 128 = center)
//   7: vendor byte (unused, 0)
//   8: CRC8, poly 0x07, seeded 0, over bytes 0..7
// Y-DOWN IS POSITIVE ON THE WIRE. Switch reports use screen coordinates (255 =
// stick pushed down) while our StickPos y is +1 = UP, so the Y axes invert here.
const UART_MSB: readonly Button[] = ['Y', 'B', 'A', 'X', 'L', 'R', 'ZL', 'ZR'];
const UART_LSB: readonly Button[] = ['Minus', 'Plus', 'LClick', 'RClick', 'Home', 'Capture'];

/** CRC8 as avr-libc's `_crc8_ccitt_update`: XOR in, 8 shifts, poly 0x07. */
export function crc8(bytes: ArrayLike<number>): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    let data = (crc ^ bytes[i]!) & 0xff;
    for (let bit = 0; bit < 8; bit++) {
      data = (data & 0x80) ? ((data << 1) ^ 0x07) & 0xff : (data << 1) & 0xff;
    }
    crc = data;
  }
  return crc;
}

export function encodeWiredUart(s: ControllerState): Uint8Array {
  validateState(s);
  let msb = 0, lsb = 0;
  UART_MSB.forEach((b, i) => { if (s.buttons.has(b)) msb |= 1 << i; });
  UART_LSB.forEach((b, i) => { if (s.buttons.has(b)) lsb |= 1 << i; });
  const f = new Uint8Array(9);
  f[0] = msb; f[1] = lsb; f[2] = hatValue(s.buttons);
  f[3] = axisByte(s.leftStick.x);  f[4] = axisByte(-s.leftStick.y);
  f[5] = axisByte(s.rightStick.x); f[6] = axisByte(-s.rightStick.y);
  f[7] = 0;
  f[8] = crc8(f.subarray(0, 8));
  return f;
}

/** UARTSwitchCon "vanilla" handshake: master sends 0xFF/0x33/0xCC, firmware
 *  replies 0xFF/0xCC/0x33, then 0x90 per accepted packet. Exposed so the serial
 *  backend and its tests agree on one definition. */
export const WIRED_UART = {
  baudRate: 19200,
  handshake: [0xff, 0x33, 0xcc] as const,
  expectedReplies: [0xff, 0xcc, 0x33] as const,
  packetAck: 0x90,
  packetBytes: 9,
} as const;

// --- codec registry ---------------------------------------------------------
export type FirmwareId = 'debug' | 'wired-uart' | 'pabotbase2';

export interface FirmwareCodec {
  readonly id: FirmwareId;
  readonly frameBytes: number;
  readonly baudRate: number;
  encode(s: ControllerState): Uint8Array;
}

const CODECS: Record<FirmwareId, FirmwareCodec> = {
  debug: { id: 'debug', frameBytes: 7, baudRate: 0, encode: encodeState },
  'wired-uart': { id: 'wired-uart', frameBytes: WIRED_UART.packetBytes, baudRate: WIRED_UART.baudRate, encode: encodeWiredUart },
  pabotbase2: {
    id: 'pabotbase2', frameBytes: 0, baudRate: 115200,
    encode() {
      throw new EncodeError(
        'pabotbase2 framing is not implemented. Pokémon Automation\'s ESP32 firmware speaks a ' +
        'versioned request/ack protocol (seqnum + checksum + per-command opcodes), not a raw ' +
        'state frame — it has to be ported from the ComputerControl source against real ' +
        'hardware, not guessed. Use firmware "wired-uart" (Pico / RP2040 / ATmega32u4) meanwhile.',
      );
    },
  },
};

export function getCodec(id: FirmwareId): FirmwareCodec {
  const c = CODECS[id];
  if (!c) throw new EncodeError(`unknown firmware ${JSON.stringify(id)}`);
  return c;
}

function describeStick(name: string, p: StickPos): string {
  return p.x || p.y ? `${name}(${p.x.toFixed(1)},${p.y.toFixed(1)})` : '';
}

/** Human-readable one-liner for a state, e.g. "A+Right" or "(neutral)". */
export function describeState(s: ControllerState): string {
  const parts: string[] = [];
  if (s.buttons.size) parts.push([...s.buttons].join('+'));
  const l = describeStick('L', s.leftStick); if (l) parts.push(l);
  const r = describeStick('R', s.rightStick); if (r) parts.push(r);
  return parts.length ? parts.join(' ') : '(neutral)';
}
