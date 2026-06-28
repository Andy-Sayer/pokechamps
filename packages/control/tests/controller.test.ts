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
