// The Controller sequences high-level inputs into a timed ControllerState
// stream on a backend. Timing (taps, gaps) lives here, not in the backend: a
// "tap A" = assert A-held, wait holdMs, assert A-released, wait a gap so the
// next press is distinct. `sleep` is injectable so tests + the dry-run run
// instantly; `emitted` is the deterministic record of every asserted step.
//
// SAFETY: a neutral watchdog. close() (and neutral()) always release everything
// + center the sticks, so a crash or abort never leaves a button/stick jammed.
import { neutralState, type Button, type ControllerState, type ControllerStep, type InputAction, type StickName } from './types.js';
import type { OutputBackend } from './backend.js';
import { describeState } from './protocol.js';

const DEFAULT_TAP_MS = 80; // a tap the Switch reliably registers
const DEFAULT_GAP_MS = 80; // neutral gap between inputs so presses stay distinct

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Controller {
  private readonly backend: OutputBackend;
  private readonly sleep: Sleep;
  private held = new Set<Button>();
  private leftStick = { x: 0, y: 0 };
  private rightStick = { x: 0, y: 0 };
  /** Deterministic record of every asserted step (for the dry-run + tests). */
  readonly emitted: ControllerStep[] = [];

  constructor(opts: { backend: OutputBackend; sleep?: Sleep }) {
    this.backend = opts.backend;
    this.sleep = opts.sleep ?? realSleep;
  }

  async connect(): Promise<void> { await this.backend.connect(); }

  private snapshot(): ControllerState {
    return { buttons: new Set(this.held), leftStick: { ...this.leftStick }, rightStick: { ...this.rightStick } };
  }

  private async emit(durationMs: number): Promise<void> {
    const state = this.snapshot();
    this.emitted.push({ state, durationMs });
    await this.backend.sendState(state);
    if (durationMs > 0) await this.sleep(durationMs);
  }

  async tap(button: Button, holdMs = DEFAULT_TAP_MS): Promise<void> {
    this.held.add(button); await this.emit(holdMs);
    this.held.delete(button); await this.emit(DEFAULT_GAP_MS);
  }
  async hold(button: Button): Promise<void> { this.held.add(button); await this.emit(0); }
  async release(button: Button): Promise<void> { this.held.delete(button); await this.emit(DEFAULT_GAP_MS); }
  async tilt(stick: StickName, x: number, y: number, ms: number): Promise<void> {
    const s = stick === 'left' ? this.leftStick : this.rightStick;
    s.x = x; s.y = y; await this.emit(ms);
    s.x = 0; s.y = 0; await this.emit(DEFAULT_GAP_MS);
  }
  async wait(ms: number): Promise<void> { await this.emit(ms); }

  /** Run a lowered InputAction sequence (from menuNav.lowerGameAction). */
  async run(actions: InputAction[]): Promise<void> {
    for (const a of actions) {
      switch (a.kind) {
        case 'press': await this.tap(a.button, a.holdMs); break;
        case 'hold': await this.hold(a.button); break;
        case 'release': await this.release(a.button); break;
        case 'tilt': await this.tilt(a.stick, a.x, a.y, a.ms); break;
        case 'wait': await this.wait(a.ms); break;
      }
    }
  }

  /** Neutral watchdog: release every button + center both sticks. */
  async neutral(): Promise<void> {
    const n = neutralState();
    this.held = n.buttons; this.leftStick = n.leftStick; this.rightStick = n.rightStick;
    await this.emit(0);
  }

  async close(): Promise<void> { await this.neutral(); await this.backend.close(); }

  /** Human-readable timeline of the emitted steps (deterministic). */
  transcript(): string {
    let t = 0;
    const lines: string[] = [];
    for (const step of this.emitted) {
      lines.push(`${String(t).padStart(5)}ms  ${describeState(step.state)}  (${step.durationMs}ms)`);
      t += step.durationMs;
    }
    return lines.join('\n');
  }
}
