// Output backends: where a ControllerState stream actually goes. Swappable
// exactly like @pokechamps/vision's input sources — the Controller doesn't care
// whether it's driving a mock recorder or a real serial microcontroller.
import type { ControllerState } from './types.js';
import { encodeState, describeState, getCodec, type FirmwareCodec, type FirmwareId } from './protocol.js';
import { assertSendable } from './menuNav.js';

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

/** Real backend over a serial-driven controller MCU. The frame encoding and the
 *  safety interlock are DONE (see protocol.ts / menuNav.assertSendable); what is
 *  still missing is only the transport — the lazy `serialport` import and the
 *  handshake exchange, both of which need a device on the other end to write
 *  against. connect() therefore refuses with an actionable message rather than
 *  pretending, but it refuses only AFTER the interlock, so an uncalibrated caller
 *  gets told the real reason it must not send. */
export class SerialBackend implements OutputBackend {
  readonly name = 'serial';
  private readonly codec: FirmwareCodec;
  private readonly opts: { path: string; firmware: FirmwareId; force?: boolean };

  constructor(opts: { path: string; firmware: FirmwareId; force?: boolean }) {
    this.opts = opts;
    this.codec = getCodec(opts.firmware);   // unknown firmware fails at construction
  }

  /** Encode without a device — lets the dry-run show the exact bytes a live send
   *  would put on the wire for the configured firmware. */
  frameFor(state: ControllerState): Uint8Array { return this.codec.encode(state); }

  async connect(): Promise<void> {
    assertSendable({ force: this.opts.force });   // calibration gate FIRST
    throw new Error(
      `SerialBackend transport is not implemented (firmware=${this.codec.id}, path=${this.opts.path}, ` +
      `${this.codec.baudRate} baud). Frame encoding and the safety interlock are done; what remains ` +
      'is the wire: `npm i serialport`, open the port, run the firmware handshake ' +
      '(protocol.WIRED_UART.handshake for wired-uart), then stream frames in sendState(). ' +
      'See docs/notes/future-directions.md §2.',
    );
  }
  async sendState(): Promise<void> { throw new Error('SerialBackend not connected'); }
  async close(): Promise<void> {}
}
