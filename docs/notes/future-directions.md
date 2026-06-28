# Future directions — exploratory, not yet scheduled

Forward-looking ideas captured for later. Neither is committed to a timeline;
this note exists so the intent + the research behind it isn't lost. Both move
the project toward a tighter perceive → decide → act loop on top of the existing
engine + the vision adapter.

---

## 1. Historic game data → training data for a purpose-trained model

**Idea.** Accumulate a corpus of *real* games (state → action → outcome) and use
it to train a purpose-built model for the decisions the engine currently makes
heuristically — move choice, bring selection, opponent-spread priors. This is
the concrete form of the standing AI direction: **a purpose-trained model, not
an LLM, and opt-in** (see the `feedback_ai_direction` / `feedback_pokemon_strategy`
memories — the user distrusts LLM VGC judgement; a model trained on real
outcomes is the path that respects that).

**Why now-ish.** Most of the plumbing already exists:
- **Replay ingest (J.0–J.6, shipped).** `showdownReplay.ts` parses the Showdown
  `|`-protocol into a typed `BattleTranscript`; `replayDriver.ts` walks it
  through the production `finalizeTurn`/`applyStateUpdate`; `fetch-replay.ts`
  caches a corpus under `tests/replays/`. That pipeline already turns a raw game
  into per-turn (state, actions, damage) records — exactly the shape a dataset
  needs.
- **Match snapshots.** The TUI already persists `matches/<id>.json` (press `s`).
  Our own logged Champions games are first-party training data that Showdown
  replays can't provide (Champions ≠ gen9 VGC — different mons/items/scale).
- **Vision adapter.** Once screen-reads are reliable (see `vision-plan.md`),
  *watched* games (VODs, live capture) become an automatic data source — no
  manual logging.

**Sketch of the work (when picked up):**
1. **Define the record schema** — `(observed state, legal options, chosen
   action, eventual result)` per decision point. Reuse the transcript +
   engine-state types; don't invent a parallel representation.
2. **Build the dataset exporter** — a script that walks the replay corpus +
   match snapshots (+ later, vision-captured games) and emits training rows.
   Lean on the existing driver so the "state" is exactly what the engine sees.
3. **Label quality** — Showdown replays are a *proxy* meta (gen9 VGC) and hide
   spreads; Champions first-party games are scarcer but exact. Tag the source so
   a model can weight them. The J north-star's reachability/round-trip machinery
   already reasons about hidden spreads — reuse it.
4. **Target tasks (pick one first)** — most tractable is likely an
   opponent-spread/EV prior (supervised: observed damage → spread), then
   bring/move value. Keep it **opt-in and side-by-side** with the engine, never
   an automatic override of the deterministic search.
5. **Privacy/scope** — first-party match data is the user's own; if any sharing
   or hosted training is involved, that's an explicit decision, not a default.

**Open questions:** which decision to model first (spread prior vs move/bring
value); how much Champions-native data we can realistically gather vs leaning on
the Showdown proxy; whether the model augments the leaf eval of the search or
sits beside it as an advisory. Related: pillar **H (AI)** + the **J** north-star
in [`roadmap.md`](roadmap.md); [`vision-plan.md`](vision-plan.md) for the capture
side.

---

## 2. Programmatic Switch control (Bluetooth / input injection)

**Idea.** The vision adapter is the INPUT half of the loop (read the Switch
screen). The complement is the OUTPUT half: have the program **send controller
inputs** to the Switch so it can act on the engine's recommendation — closing the
perceive → decide → act loop toward (semi-)automated play. The user specifically
flagged Bluetooth as the appealing mechanism ("super cool for the program to
control the switch using bluetooth").

### The crux: pure Windows Bluetooth can't do it

The Switch accepts wireless controllers as a **Bluetooth *Classic* (BR/EDR) HID
*peripheral*** (HID over L2CAP, control PSM `0x11` / interrupt `0x13`, a specific
SDP record — **not** BLE). Windows' Bluetooth stack only exposes the **host**
role for Classic HID (it connects *to* gamepads); its peripheral support is
**BLE-only**, which the Switch doesn't use for controllers. So "just use the
laptop's Bluetooth to impersonate a Pro Controller" is **impossible on Windows**.
**Linux/BlueZ** *can* register the custom SDP record + bind the L2CAP sockets as
a device — which is why the software tools below are all Linux. (The protocol was
reverse-engineered by dekuNukem; the controller streams input report `0x30` at
~60 Hz, so "press A" is just setting a bit in the next report — but a fussy
handshake of subcommands, SPI/calibration reads, set-report-mode, enable-IMU must
be answered fast or the Switch drops the controller.)

**Switch 2:** still accepts a *legacy* Pro Controller over BT/USB (Nintendo
confirmed back-compat; NXBT + GP2040-CE users confirm emulation works). Its own
new controllers use a different proprietary protocol with auth — but **we don't
need to crack that**; we keep impersonating an old Pro Controller.

### The three viable paths

The robust answer is a **microcontroller that is the controller**, driven by the
PC over **USB serial** (Node ↔ MCU via the [`serialport`](https://www.npmjs.com/package/serialport)
npm package). That sidesteps the Windows-BT wall entirely.

| Path | What | Switch 2? | Latency | Effort / risk |
|---|---|---|---|---|
| **A. ESP32-WROOM + PABotBase2** *(recommended)* | [Pokémon Automation](https://pokemonautomation.github.io/) firmware; emulates a **wireless** Pro Controller, PC drives it over USB serial | **Yes (1 & 2, confirmed)** | a few ms (BT) | Actively maintained, documented serial protocol; ~$8 board; must port its serial framing to TS; BT range + grip-menu reconnect quirk |
| **B. RP2040 (Pico) / Pro Micro, wired** | Minimal firmware presents a **wired USB** controller, reads 1–2 serial bytes → emits report (asottile / VinDuv lineage) | Switch 1 yes; **wired S2 unconfirmed** for hobby firmware (GP2040-CE works) | ~1 ms, deterministic | Trivial serial protocol, easiest to drive from Node; need to adapt "fixed macro" sketches to live serial |
| **C. Linux box / Pi + NXBT** | Pure software BT emulation on Linux; Node talks to it over NXBT's web API / a socket bridge | Yes (v12/community branch) | <8 ms | **No hardware/soldering**, but mainline **unmaintained** (Py 3.12 breakage), BlueZ root quirks, a 2nd machine to babysit, frail handshake |

**Recommendation:** start with **Path A (ESP32-WROOM + PABotBase2)** — best
maintenance + the only path with *confirmed* Switch 2 support, and it stays on
the Windows box via USB serial. Keep **Path B (wired Pico)** as the fallback if
sub-frame timing on a Switch 1 ever matters. Avoid emulating from Windows
directly (impossible) and `sys-botbase`/CFW routes (require a hacked console).

### Architecture (independent of the path)

- **Model it as an output adapter mirroring the vision *input* adapter** — a
  module that takes a canonical action (`move m1 > Astral Barrage > o2`,
  `switch`, menu nav) and emits the device input sequence, behind one
  `OutputAdapter` interface so the backend (serial-MCU now, NXBT later) is
  swappable. Engine/parser untouched, exactly like the vision adapter.
- **A controller is a continuous ~60 Hz state stream, not events.** "Press A" =
  set bit → hold N ms → clear. Build a `press(button, holdMs)` / `tilt(stick…)` /
  `macro([...])` layer with a **neutral/all-released watchdog** so a crash never
  jams a stick.
- **Closed-loop, not open-loop macros.** Reuse the vision side's **settle-frame
  gating**: read settled board → decide → emit input → **verify by vision** →
  retry if the screen isn't as expected. This survives dropped inputs + variable
  animation length far better than timed sequences. Log every emitted action into
  the same match record the vision side writes.

### ⚠ ToS / ban-risk (scope decision is the user's)

Scripted/automated input in **online ranked** play violates Nintendo's terms and
is a **real account/console ban risk** — qualitatively different from a turbo
controller. **Lowest-risk scope:** offline / practice / personal analysis. For
online ranked, consider keeping the loop **suggest-only** (vision reads, app
recommends, *human* presses) — the vision-read half is passive and low-risk; the
moment inputs are injected into online ranked, it crosses into ToS violation.

### Key sources

dekuNukem [Nintendo_Switch_Reverse_Engineering](https://github.com/dekuNukem/Nintendo_Switch_Reverse_Engineering)
· [NXBT](https://github.com/Brikwerk/nxbt) · [joycontrol](https://github.com/mart1nro/joycontrol)
· [Pokémon Automation / PABotBase2](https://pokemonautomation.github.io/) (ESP32, Pico W)
· [asottile/switch-microcontroller](https://github.com/asottile/switch-microcontroller)
· [GP2040-CE](https://gp2040-ce.info/) · [`serialport`](https://www.npmjs.com/package/serialport)
· Windows BT role limits: [Microsoft Learn](https://learn.microsoft.com/en-us/windows-hardware/design/component-guidelines/bluetooth)
