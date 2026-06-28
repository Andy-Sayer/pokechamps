# @pokechamps/control

The **output adapter** — the mirror of [`@pokechamps/vision`](../vision). Vision
reads the Switch screen → canonical turn-log lines (INPUT). This package takes a
canonical battle intent and turns it into Nintendo Switch controller input
(OUTPUT), to close the perceive → decide → act loop. The engine/parser stay
untouched, exactly as on the vision side.

```
GameAction --menuNav--> InputAction[] --Controller--> ControllerState stream --backend--> device
```

## Status: software-first scaffold

No controller hardware is wired yet. What works today:

- **Action vocabulary + controller model** (`types.ts`, `controller.ts`) — buttons
  / sticks / a timed `ControllerState` stream, `tap`/`hold`/`tilt`/`run`, and a
  **neutral watchdog** (`close()`/`neutral()` always release everything so a
  crash never jams an input).
- **`MockBackend`** (`backend.ts`) — records every asserted state + wire frame
  instead of touching hardware. Powers the dry-run and the tests.
- **Dry-run** (`scripts/dry-run.ts`) — the **confirm-before-press** surface:
  print the exact input sequence a real send *would* produce; sends nothing.

```
npx tsx packages/control/scripts/dry-run.ts --move 1 --target o2
npx tsx packages/control/scripts/dry-run.ts --switch 3
npx tsx packages/control/scripts/dry-run.ts --mega
```

## Why a microcontroller, not the PC's Bluetooth

The Switch accepts wireless controllers as a **Bluetooth *Classic* HID
*peripheral*** (HID-over-L2CAP, not BLE). **Windows' Bluetooth stack can't be a
Classic-HID peripheral** (host-role + BLE-peripheral only), so the PC can't
impersonate a Pro Controller directly. The path is a **serial-driven
microcontroller that IS the controller**, driven from Node over USB serial:

- **Recommended:** ESP32-WROOM running [Pokémon Automation PABotBase2](https://pokemonautomation.github.io/)
  (wireless Pro Controller; confirmed Switch 1 **and** 2).
- **Fallback (Switch 1, ~1ms):** a wired RP2040/Pico or ATmega32u4.

`SerialBackend` (`backend.ts`) is the stubbed seam: it implements the
`OutputBackend` interface but `connect()` throws an actionable message until the
firmware frame encoder (`protocol.ts`) + the lazy `serialport` import are added.
Full research + rationale: [`docs/notes/future-directions.md`](../../docs/notes/future-directions.md) §2.

## ⚠ Two safety gates before any live send

1. **`menuNav` is NOT calibrated.** Every sequence in `menuNav.ts` is a
   best-guess at the Champions doubles battle UI (`MENU_NAV_CALIBRATED = false`).
   Verify each against the real game (the vision side can watch the cursor)
   before trusting it — the dry-run exists so a human eyeballs the sequence first.
2. **ToS / ban-risk.** Scripted input in **online ranked** play violates
   Nintendo's terms and risks an account/console ban. Default mode is
   **confirm-before-press** (a human triggers the send). Keep full automation to
   **offline/practice**, or stay suggest-only for ranked.

## Deferred (named, not built)

Real `SerialBackend` + firmware frame encoders (need hardware) · `menuNav`
calibration · wiring the live endgame-search recommendation → `GameAction` · the
full auto closed-loop (act → verify-by-vision) behind a flag.
