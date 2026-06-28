// Output backends: where a ControllerState stream actually goes. Swappable
// exactly like @pokechamps/vision's input sources — the Controller doesn't care
// whether it's driving a mock recorder or a real serial microcontroller.
import type { ControllerState } from './types.js';
import { encodeState, describeState } from './protocol.js';

export interface OutputBackend {
  readonly name: string;
  connect(): Promise<void>;
  /** Assert a controller state now; the device holds it until the next call. */
  sendState(state: ControllerState): Promise<void>;
  close(): Promise<void>;
}

/** Records every asserted state (+ its wire frame) instead of touching
 *  hardware. Powers the dry-run surface and the tests; deterministic (no wall
 *  clock — timing lives in the Controller's emitted-step log). */
export class MockBackend implements OutputBackend {
  readonly name = 'mock';
  readonly log: { state: ControllerState; frame: Uint8Array; desc: string }[] = [];
  private connected = false;

  async connect(): Promise<void> { this.connected = true; }
  async sendState(state: ControllerState): Promise<void> {
    if (!this.connected) throw new Error('MockBackend.sendState() before connect()');
    this.log.push({ state, frame: encodeState(state), desc: describeState(state) });
  }
  async close(): Promise<void> { this.connected = false; }
}

/** Real backend over a serial-driven controller MCU. STUB until hardware is
 *  wired (software-first scaffold) — the interface is real so the rest of the
 *  package is built against it, but connect() refuses with an actionable
 *  message rather than pretending. The firmware-specific frame encoder
 *  (protocol.ts) and the lazy `serialport` import land here at that time. */
export class SerialBackend implements OutputBackend {
  readonly name = 'serial';
  constructor(_opts: { path: string; firmware: 'pabotbase2' | 'wired'; baudRate?: number }) {}
  async connect(): Promise<void> {
    throw new Error(
      'SerialBackend is not wired yet (software-first scaffold). To enable: attach a ' +
      'serial controller MCU (ESP32 + Pokémon Automation PABotBase2, or a wired RP2040/AVR), ' +
      'run `npm i serialport`, implement the firmware frame encoder in protocol.ts, and ' +
      'finish connect()/sendState() here. See docs/notes/future-directions.md §2.',
    );
  }
  async sendState(): Promise<void> { throw new Error('SerialBackend not connected'); }
  async close(): Promise<void> {}
}
