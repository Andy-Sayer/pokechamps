// Wire encoding for a ControllerState + a human-readable description.
//
// `encodeState` produces a PLACEHOLDER generic frame: a 3-byte button mask (bit
// order = ALL_BUTTONS) + 4 stick bytes (LX, LY, RX, RY; 0..255, 128 = center).
// The REAL frame layout is firmware-specific and added with the SerialBackend
// when hardware is wired — Pokémon Automation PABotBase2 has its own
// request/ack binary protocol; a wired RP2040/AVR sketch (asottile /
// switch-fightstick lineage) takes a simpler byte stream. This generic form
// exists so the MockBackend + dry-run have something concrete to show and so
// the encode is testable without a device. See docs/notes/future-directions.md §2.
import { ALL_BUTTONS, type Button, type ControllerState, type StickPos } from './types.js';

const BIT: Record<Button, number> = Object.fromEntries(
  ALL_BUTTONS.map((b, i) => [b, i]),
) as Record<Button, number>;

/** Map an axis in [-1, 1] to a byte 0..255 with 0 -> 128 (center). */
function axisByte(v: number): number {
  const clamped = Math.max(-1, Math.min(1, v));
  return Math.round((clamped + 1) * 127.5);
}

/** Encode a state to the placeholder generic frame (7 bytes). */
export function encodeState(s: ControllerState): Uint8Array {
  let mask = 0;
  for (const b of s.buttons) mask |= 1 << BIT[b];
  return new Uint8Array([
    mask & 0xff, (mask >> 8) & 0xff, (mask >> 16) & 0xff,
    axisByte(s.leftStick.x), axisByte(s.leftStick.y),
    axisByte(s.rightStick.x), axisByte(s.rightStick.y),
  ]);
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
