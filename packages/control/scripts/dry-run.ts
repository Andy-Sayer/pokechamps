// Confirm-before-press surface. Resolve a GameAction (from CLI flags) into the
// controller input sequence and PRINT it — nothing is sent to any device (the
// MockBackend records; SerialBackend is a stub). This is what a human reviews
// before triggering a real send once hardware + calibration are in place.
//
//   npx tsx packages/control/scripts/dry-run.ts --move 1 --target o2
//   npx tsx packages/control/scripts/dry-run.ts --switch 3
//   npx tsx packages/control/scripts/dry-run.ts --mega
import {
  Controller, MockBackend, lowerGameAction, describeInput, MENU_NAV_CALIBRATED, getCodec,
  type FirmwareId, type GameAction, type TargetRef,
} from '../src/index.js';

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (flag: string) => process.argv.includes(flag);

function parseAction(): GameAction {
  const move = arg('--move');
  if (move) return { kind: 'move', slot: Number(move) as 1 | 2 | 3 | 4, target: arg('--target') as TargetRef | undefined };
  const sw = arg('--switch');
  if (sw) return { kind: 'switch', benchSlot: Number(sw) };
  if (has('--mega')) return { kind: 'mega' };
  if (has('--back')) return { kind: 'back' };
  return { kind: 'confirm' };
}

const action = parseAction();
let inputs;
try {
  inputs = lowerGameAction(action);
} catch (e) {
  console.error(`refused: ${(e as Error).message}`);
  process.exit(1);
}

// --firmware picks which wire format to show. 'wired-uart' is a real published
// frame (switch-fightstick / UARTSwitchCon), so the bytes below are exactly what
// a device would receive — worth eyeballing, not just the button names.
const firmware = (arg('--firmware') ?? 'wired-uart') as FirmwareId;
const backend = new MockBackend();
const controller = new Controller({ backend, sleep: async () => {} }); // no real waits in a dry-run
await controller.connect();
await controller.run(inputs);
await controller.close();

console.log('# control dry-run — confirm-before-press (NOTHING is sent to a device)');
console.log(`action: ${JSON.stringify(action)}`);
if (!MENU_NAV_CALIBRATED) {
  console.log('⚠ menuNav is NOT calibrated to the real Champions UI — the sequence below is a best-guess. Verify before any live send.');
}
console.log(`\ninput sequence (${inputs.length} step${inputs.length === 1 ? '' : 's'}):`);
console.log('  ' + inputs.map(describeInput).join('  ·  '));
console.log(`\nemitted controller frames (${backend.log.length} states):`);
console.log(controller.transcript());

// The actual bytes. A live send is refused while MENU_NAV_CALIBRATED is false
// (menuNav.assertSendable), so this is a preview, not a rehearsal.
try {
  const codec = getCodec(firmware);
  console.log(`\nwire frames — firmware "${codec.id}" (${codec.frameBytes} bytes @ ${codec.baudRate} baud):`);
  for (const entry of backend.log) {
    const hex = [...codec.encode(entry.state)].map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`  ${entry.desc.padEnd(12)} ${hex}`);
  }
} catch (e) {
  console.log(`\nwire frames unavailable for firmware "${firmware}": ${(e as Error).message}`);
}
console.log(
  MENU_NAV_CALIBRATED
    ? '\nmenuNav is calibrated; a live send would be permitted.'
    : '\nA live send would be REFUSED by menuNav.assertSendable() until calibration — by design.',
);
