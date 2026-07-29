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
*peripheral*** (HID-over-L2CAP, not BLE). Windows can't be one, and the reason is
specific rather than a policy choice: HID needs L2CAP PSMs **`0x11` (control)** and
**`0x13` (interrupt)**, and the Windows Bluetooth stack **reserves both for its own
HID *host*** — no userspace app can bind them. So "impersonate a Pro Controller
from the laptop" is not a matter of finding the right API. The path is a
**serial-driven microcontroller that IS the controller**, driven from Node over
USB serial.

| Option | Link | Switch 2 | Notes |
|---|---|---|---|
| **ESP32-WROOM + PABotBase2** *(recommended)* | [setup guide](https://pokemonautomation.github.io/SetupGuide/Controllers/Controller-ESP32-WROOM.html) | yes | Wireless Pro Controller / either Joy-Con. Flash at 460800 baud; keep the board **within ~3 ft line-of-sight** and don't cluster several. Firmware is **`PABotBase2`**, not `PABotBase` — the setup guide calls the mix-up out explicitly. |
| **Pico W / RP2040 / RP2350, wired** *(implemented here)* | [setup guide](https://pokemonautomation.github.io/SetupGuide/Controllers/Controller-PicoW-USB.html) | yes | ~1 ms, deterministic, no BT range to worry about. Its UART frame is published, so `protocol.ts` implements it **today**. |
| ESP32-S3 | [setup guide](https://github.com/PokemonAutomation/ComputerControl/blob/master/Wiki/SetupGuide/Controllers/Controller-ESP32-S3.md) | yes | Wired Pro Controller over USB gadget. |
| ~~Arduino Leonardo / Uno R3 / Pro Micro / Teensy 2.0~~ | — | — | **Discontinued upstream.** Don't start here; earlier notes in this repo suggested ATmega32u4 as the fallback and that is now the dead branch. |
| sys-botbase | [setup guide](https://pokemonautomation.github.io/SetupGuide/Controllers/Controller-sys-botbase.html) | n/a | Requires a **hacked console**. Out of scope. Also note sbb2 was dropped 2026-01-01; sbb3 only. |

**Switch 2 specifics** (from Pokémon Automation's [Switch 2 notes](https://pokemonautomation.github.io/Programs/NintendoSwitch/Switch2Notes.html)):
wired polling is **no longer a constant 125 Hz** — it varies between 125 Hz and
62.5 Hz, so a hold has to clear a **16 ms** worst-case interval, not 8 ms (the
80 ms default tap is ~5 polls at worst). Relaunching a game always snaps the
profile cursor back to the **first** user profile. Two findings there land on the
**vision** side rather than this package: **Elgato capture cards wash colours out
badly on Switch 2**, and **HDR causes capture problems** — both would wreck
colour-histogram sprite matching, so if reads ever degrade after a console change,
check those before suspecting the matcher.

### What is actually built vs. stubbed

`protocol.ts` implements the **`wired-uart`** frame for real — the published
9-byte packet of the switch-fightstick / [UARTSwitchCon](https://github.com/nullstalgia/UARTSwitchCon)
lineage (19200 baud, CRC8 poly `0x07`, d-pad as a 0-8 **hat**, `0x90` ack per
packet). Because the format is fixed and public it could be written and tested
before any hardware existed, and the dry-run prints the exact bytes.

`pabotbase2` is **declared but deliberately unimplemented**: its framing is a
versioned request/ack protocol with per-command opcodes, which has to be ported
from the ComputerControl source against a real board rather than guessed. It
throws a pointer instead of producing plausible-looking wrong bytes.

`SerialBackend` is therefore down to **one missing piece — the transport**: the
lazy `serialport` import, the handshake exchange, and the write loop.

## ⚠ Two safety gates before any live send

1. **`menuNav` is NOT calibrated.** Every sequence in `menuNav.ts` is a
   best-guess at the Champions doubles battle UI (`MENU_NAV_CALIBRATED = false`).
   Verify each against the real game (the vision side can watch the cursor)
   before trusting it — the dry-run exists so a human eyeballs the sequence first.
   **This is now enforced in code, not just prose**: `assertSendable()` throws,
   and `SerialBackend.connect()` calls it *before* anything else, so the gate
   can't be forgotten by whoever finishes the transport. `{ force: true }` is the
   deliberate escape hatch for a calibration run on a harmless screen.
2. **ToS / ban-risk.** Scripted input in **online ranked** play violates
   Nintendo's terms and risks an account/console ban. Default mode is
   **confirm-before-press** (a human triggers the send). Keep full automation to
   **offline/practice**, or stay suggest-only for ranked.

## Battle-tested, not just written

The scaffold was probed adversarially (`tests/` carries every case as a
regression). Seven defects were found and fixed; all of them **failed silently
with a wrong output**, which is the failure mode that matters when the output is
button presses on someone's console:

| Defect | Why it mattered |
|---|---|
| An unknown button name encoded as `1 << undefined` = bit 0 = **A** | A stray name pressed **A**, which on a battle menu confirms whatever the cursor is on |
| `NaN` / `Infinity` on a stick axis clamped to byte 0 | Silently became a **full stick deflection** |
| `Up`+`Down` (or `Left`+`Right`) encoded happily | Physically impossible and unrepresentable as a hat — the old 4-bit d-pad hid this |
| Concurrent `tap()`s interleaved | `Promise.all([tap('A'), tap('B')])` emitted a frame with **both held**; now serialised by a queue |
| `close()` threw when the backend was dead | A mid-sequence unplug skipped `backend.close()` — the watchdog failing at the one moment it exists for |
| `benchSlot: 0`, `slot: 9`, fractional slots all accepted | Clamped to the **wrong Pokémon / wrong move** instead of refusing |
| `release()` of an unheld button emitted a frame + 80 ms gap | Wasted turn time and made the transcript claim an input that never happened |

Out-of-range and impossible states now **refuse** rather than clamp: at the last
gate before a console sees an input, a guess is worse than an error.

## Deferred (named, not built)

`SerialBackend` **transport** (the `serialport` import + handshake + write loop —
needs hardware) · `pabotbase2` framing (port from ComputerControl, don't guess) ·
`menuNav` calibration · wiring the live endgame-search recommendation →
`GameAction` · the full auto closed-loop (act → verify-by-vision) behind a flag.
