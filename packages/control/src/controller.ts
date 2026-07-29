// The Controller sequences high-level inputs into a timed ControllerState
// stream on a backend. Timing (taps, gaps) lives here, not in the backend: a
// "tap A" = assert A-held, wait holdMs, assert A-released, wait a gap so the
// next press is distinct. `sleep` is injectable so tests + the dry-run run
// instantly; `emitted` is the deterministic record of every asserted step.
//
// Note the MCU, not this class, streams frames at the console's poll rate: both
// supported firmwares latch the last state and report it continuously, so sparse
// state assertions are correct AND cheaper than pumping the serial line. Hold
// times only have to clear the poll interval, which on Switch 2 is not constant —
// Pokémon Automation measured wired polling varying between 125 Hz and 62.5 Hz,
// so 80 ms is ~5 polls at the worst case rather than the ~10 a Switch 1 gives.
//
// SAFETY: a neutral watchdog. close() (and neutral()) always release everything
// + center the sticks, so a crash or abort never leaves a button/stick jammed.
import { neutralState, type Button, type ControllerState, type ControllerStep, type InputAction, type StickName } from './types.js';
import type { OutputBackend } from './backend.js';
import { describeState } from './protocol.js';

const DEFAULT_TAP_MS = 80; // a tap the Switch reliably registers (≥5 polls worst case)
const DEFAULT_GAP_MS = 80; // neutral gap between inputs so presses stay distinct

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Controller {
  private readonly backend: OutputBackend;
  private readonly sleep: Sleep;
  private held = new Set<Button>();
  private leftStick = { x: 0, y: 0 };
  private rightStick = { x: 0, y: 0 };
  private closed = false;
  /** Serialises every public mutation. Without it two concurrent tap() calls
   *  interleave their held-set writes and emit a frame with BOTH buttons down —
   *  the battle-test probe produced exactly `A | A+B | B | (neutral)` from
   *  `Promise.all([tap('A'), tap('B')])`. On a battle menu that is a garbage
   *  input, and the caller has no way to see it happened. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Errors swallowed by the neutral watchdog, kept for reporting. */
  readonly suppressed: Error[] = [];
  /** Deterministic record of every asserted step (for the dry-run + tests). */
  readonly emitted: ControllerStep[] = [];

  constructor(opts: { backend: OutputBackend; sleep?: Sleep }) {
    this.backend = opts.backend;
    this.sleep = opts.sleep ?? realSleep;
  }

  /** Run `fn` with exclusive access to the controller state. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);   // a failed predecessor must not block the queue
    this.queue = run.catch(() => {});
    return run;
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

  private assertOpen(): void {
    if (this.closed) throw new Error('Controller is closed — create a new one rather than reusing it after close()');
  }

  async tap(button: Button, holdMs = DEFAULT_TAP_MS): Promise<void> {
    return this.exclusive(async () => {
      this.assertOpen();
      this.held.add(button); await this.emit(holdMs);
      this.held.delete(button); await this.emit(DEFAULT_GAP_MS);
    });
  }
  async hold(button: Button): Promise<void> {
    return this.exclusive(async () => { this.assertOpen(); this.held.add(button); await this.emit(0); });
  }
  /** Release a held button. Releasing one that is NOT held is a no-op: emitting
   *  an identical frame plus an 80 ms gap for nothing both wastes turn time and
   *  makes the transcript lie about what was sent. */
  async release(button: Button): Promise<void> {
    return this.exclusive(async () => {
      this.assertOpen();
      if (!this.held.delete(button)) return;
      await this.emit(DEFAULT_GAP_MS);
    });
  }
  async tilt(stick: StickName, x: number, y: number, ms: number): Promise<void> {
    return this.exclusive(async () => {
      this.assertOpen();
      for (const [n, v] of [['x', x], ['y', y]] as const) {
        if (!Number.isFinite(v)) throw new Error(`tilt ${stick}.${n} is ${v}`);
        if (v < -1 || v > 1) throw new Error(`tilt ${stick}.${n}=${v} out of range [-1,1]`);
      }
      const s = stick === 'left' ? this.leftStick : this.rightStick;
      s.x = x; s.y = y; await this.emit(ms);
      s.x = 0; s.y = 0; await this.emit(DEFAULT_GAP_MS);
    });
  }
  async wait(ms: number): Promise<void> {
    return this.exclusive(async () => { this.assertOpen(); await this.emit(ms); });
  }

  /** Run a lowered InputAction sequence (from menuNav.lowerGameAction) as ONE
   *  exclusive unit, so a concurrent caller cannot splice its presses into the
   *  middle of a menu sequence. */
  async run(actions: InputAction[]): Promise<void> {
    return this.exclusive(async () => {
      this.assertOpen();
      for (const a of actions) {
        switch (a.kind) {
          case 'press':
            this.held.add(a.button); await this.emit(a.holdMs ?? DEFAULT_TAP_MS);
            this.held.delete(a.button); await this.emit(DEFAULT_GAP_MS);
            break;
          case 'hold': this.held.add(a.button); await this.emit(0); break;
          case 'release': if (this.held.delete(a.button)) await this.emit(DEFAULT_GAP_MS); break;
          case 'tilt': {
            const s = a.stick === 'left' ? this.leftStick : this.rightStick;
            s.x = a.x; s.y = a.y; await this.emit(a.ms);
            s.x = 0; s.y = 0; await this.emit(DEFAULT_GAP_MS);
            break;
          }
          case 'wait': await this.emit(a.ms); break;
        }
      }
    });
  }

  /**
   * Neutral watchdog: release every button + center both sticks.
   *
   * THIS MUST NOT THROW. It is the one call that runs when things are already
   * going wrong — a dropped USB device, an aborted run, a crash handler — and the
   * probe caught the original version propagating the backend's EIO, which meant
   * a mid-sequence unplug skipped `backend.close()` entirely. Local state is
   * cleared first so it is correct even if the wire send fails, and the error is
   * recorded on `suppressed` rather than discarded.
   *
   * Deliberately NOT queued: as the emergency stop it has to preempt a sequence
   * that is mid-flight or wedged, which is exactly when the queue is unavailable.
   * Orderly shutdown goes through close(), which drains the queue first.
   */
  async neutral(): Promise<void> {
    const n = neutralState();
    this.held = n.buttons; this.leftStick = n.leftStick; this.rightStick = n.rightStick;
    try { await this.emit(0); } catch (e) { this.suppressed.push(e as Error); }
  }

  /** Orderly shutdown: drains any in-flight sequence, then always attempts BOTH
   *  the neutral release and the backend close even if the first one fails.
   *  Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.exclusive(async () => {
      if (this.closed) return;
      await this.neutral();
      this.closed = true;
      try { await this.backend.close(); } catch (e) { this.suppressed.push(e as Error); }
    });
  }

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
