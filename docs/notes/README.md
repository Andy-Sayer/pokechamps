# PokeChamps notes

Long-form notes that don't belong in CLAUDE.md (which stays a tight, always-loaded project guide). Each file here covers one topic in enough depth to onboard a new contributor — or a fresh Claude session.

- [battle-syntax.md](battle-syntax.md) — every action / state line / slash command the BattleScreen parser accepts
- [speed-inference-brackets.md](speed-inference-brackets.md) — how `effectivePriority` decides which action pairs generate speed signals (Quick Claw, Prankster, Gale Wings, Triage, Stall, pivot switches)
- [dual-forme-predictions.md](dual-forme-predictions.md) — pre-mega base + post-mega display contract; `resolveSpecies(active)` semantics
- [spread-modifier.md](spread-modifier.md) — auto `isSpread` for `allAdjacent` / `allAdjacentFoes` targets
- [champions-custom-data.md](champions-custom-data.md) — the format-custom audit: 4 custom abilities, their handling, 0 custom moves
- [regulation-m-b.md](regulation-m-b.md) — Reg M-B (June 17 → Sept 2): confirmed facts (Mega Raichu X/Y), tactics implications, and the switch-day runbook
- [roadmap-2026-06.md](roadmap-2026-06.md) — **the current month plan**: time-boxed June execution roadmap (per-move cells, Hail-Mary outs, inference backward half, sim oracle + replay ingest, deploy validation)
- [roadmap.md](roadmap.md) — strategic pillar-grouped backlog + the J north-star (end-to-end replay validation); the month plan above is the near-term cut of this
- [mechanics-coverage.md](mechanics-coverage.md) — full audit of every move/ability/item/weather/terrain across the 3 layers (calc / live engine / lookahead) + the prioritized gap backlog; the single source of truth for "what's left to model"
- [sim-divergences.md](sim-divergences.md) — the EMPIRICAL gap list: where our search disagrees with the real `@pkmn/sim` engine, measured by the diff-harness (run `npx tsx packages/core/src/scripts/sim-diff-report.ts`)
- [vision-plan.md](vision-plan.md) — the @pokechamps/vision live turn-read plan: what's shipped (capture, banner grammar, HP-number OCR — validated on a YouTube VOD) and the prioritized integration roadmap (consolidate OCR → number-based HP read → settle-gating → self-damage reconciler)
- [future-directions.md](future-directions.md) — exploratory, not-yet-scheduled: (1) historic game data → a purpose-trained model (built on the J replay-ingest pipeline + match snapshots + vision capture; opt-in, not an LLM); (2) programmatic Switch control to close the perceive→decide→act loop — with the Bluetooth/MCU research (Windows can't be a BT-Classic HID peripheral → a serial-driven microcontroller is the path; ESP32+PABotBase2 recommended)

Update these alongside the code that backs them. A note that disagrees with the code is worse than no note at all.
