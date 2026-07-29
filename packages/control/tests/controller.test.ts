// Controller: tap/macro produce the expected ControllerState sequence on a
// MockBackend, and the neutral watchdog always restores all-released — including
// after a dangling hold and on close().
import { describe, test, expect } from 'vitest';
import { Controller, MockBackend } from '../src/index.js';

const noSleep = async () => {};
function fresh() {
  const backend = new MockBackend();
  const controller = new Controller({ backend, sleep: noSleep });
  return { backend, controller };
}

describe('Controller', () => {
  test('tap asserts the button then releases it (held → neutral)', async () => {
    const { backend, controller } = fresh();
    await controller.connect();
    await controller.tap('A');
    expect(controller.emitted).toHaveLength(2);
    expect([...controller.emitted[0]!.state.buttons]).toEqual(['A']);
    expect(controller.emitted[1]!.state.buttons.size).toBe(0);
    // backend received the same two states.
    expect(backend.log).toHaveLength(2);
    expect([...backend.log[0]!.state.buttons]).toEqual(['A']);
  });

  test('run lowers a sequence; ends neutral', async () => {
    const { controller } = fresh();
    await controller.connect();
    await controller.run([{ kind: 'press', button: 'Down' }, { kind: 'press', button: 'A' }]);
    expect(controller.emitted).toHaveLength(4); // each press = held + release
    expect(controller.emitted.at(-1)!.state.buttons.size).toBe(0);
  });

  test('close() neutralises a dangling hold (watchdog)', async () => {
    const { controller } = fresh();
    await controller.connect();
    await controller.hold('ZR'); // never released
    expect([...controller.emitted.at(-1)!.state.buttons]).toEqual(['ZR']);
    await controller.close();
    expect(controller.emitted.at(-1)!.state.buttons.size).toBe(0);
    expect(controller.emitted.at(-1)!.state.leftStick).toEqual({ x: 0, y: 0 });
  });

  test('tilt then auto-recenters the stick', async () => {
    const { controller } = fresh();
    await controller.connect();
    await controller.tilt('left', 1, 0, 100);
    expect(controller.emitted[0]!.state.leftStick).toEqual({ x: 1, y: 0 });
    expect(controller.emitted[1]!.state.leftStick).toEqual({ x: 0, y: 0 });
  });

  test('emitted states are independent snapshots (no shared mutable Set)', async () => {
    const { controller } = fresh();
    await controller.connect();
    await controller.tap('A');
    await controller.tap('B');
    // The first held-state must still read 'A' only — not mutated by later taps.
    expect([...controller.emitted[0]!.state.buttons]).toEqual(['A']);
  });
});

// BATTLE-TEST REGRESSIONS. Each of these was a live defect found by probing the
// scaffold adversarially; all three would have produced wrong or unrecoverable
// behaviour against a real console.
describe('controller: concurrency and the watchdog', () => {
  const mk = async () => {
    const backend = new MockBackend();
    const c = new Controller({ backend, sleep: async () => {} });
    await c.connect();
    return { backend, c };
  };

  test('concurrent taps do not interleave into a both-buttons-down frame', async () => {
    // Before the queue: Promise.all([tap('A'), tap('B')]) emitted A | A+B | B |
    // (neutral) — a chord nobody asked for, on a menu where it means something.
    const { backend, c } = await mk();
    await Promise.all([c.tap('A'), c.tap('B')]);
    const descs = backend.log.map(l => l.desc);
    expect(descs).not.toContain('A+B');
    expect(descs).toEqual(['A', '(neutral)', 'B', '(neutral)']);
  });

  test('a concurrent tap cannot splice itself into the middle of a run()', async () => {
    const { backend, c } = await mk();
    await Promise.all([
      c.run([{ kind: 'press', button: 'Down' }, { kind: 'press', button: 'A' }]),
      c.tap('B'),
    ]);
    const pressed = backend.log.map(l => l.desc).filter(d => d !== '(neutral)');
    expect(pressed).toEqual(['Down', 'A', 'B']);   // B lands after the sequence, never inside it
  });

  test('the neutral watchdog survives a backend that has died', async () => {
    // A serial device unplugged mid-sequence is the exact case the watchdog is
    // for. The original close() propagated the EIO and so never ran
    // backend.close(), leaving the process without cleanup.
    let closed = false;
    const dead = {
      name: 'dead', connect: async () => {},
      sendState: async () => { throw new Error('EIO: device unplugged'); },
      close: async () => { closed = true; },
    };
    const c = new Controller({ backend: dead, sleep: async () => {} });
    await c.connect();
    await expect(c.close()).resolves.toBeUndefined();
    expect(closed).toBe(true);                       // the backend still got closed
    expect(c.suppressed.map(e => e.message)).toContain('EIO: device unplugged');
  });

  test('close() is idempotent and the controller refuses reuse afterwards', async () => {
    const { c } = await mk();
    await c.close();
    await c.close();
    await expect(c.tap('A')).rejects.toThrow(/closed/);
  });

  test('releasing a button that is not held emits nothing', async () => {
    // It used to emit a duplicate frame plus an 80ms gap — wasted turn time, and
    // a transcript that claims an input that never happened.
    const { backend, c } = await mk();
    await c.release('A');
    expect(backend.log).toHaveLength(0);
  });

  test('tilt refuses a non-finite or out-of-range axis', async () => {
    const { c } = await mk();
    await expect(c.tilt('left', NaN, 0, 10)).rejects.toThrow(/NaN/);
    await expect(c.tilt('left', 2, 0, 10)).rejects.toThrow(/out of range/);
  });

  test('a failed step does not wedge the queue for later callers', async () => {
    const { backend, c } = await mk();
    await c.tilt('left', 5, 0, 10).catch(() => {});
    await c.tap('A');
    expect(backend.log.map(l => l.desc)).toEqual(['A', '(neutral)']);
  });
});
