# PokeChamps notes

Long-form notes that don't belong in CLAUDE.md (which stays a tight, always-loaded project guide). Each file here covers one topic in enough depth to onboard a new contributor — or a fresh Claude session.

- [battle-syntax.md](battle-syntax.md) — every action / state line / slash command the BattleScreen parser accepts
- [speed-inference-brackets.md](speed-inference-brackets.md) — how `effectivePriority` decides which action pairs generate speed signals (Quick Claw, Prankster, Gale Wings, Triage, Stall, pivot switches)
- [dual-forme-predictions.md](dual-forme-predictions.md) — pre-mega base + post-mega display contract; `resolveSpecies(active)` semantics
- [spread-modifier.md](spread-modifier.md) — auto `isSpread` for `allAdjacent` / `allAdjacentFoes` targets
- [champions-custom-data.md](champions-custom-data.md) — the format-custom audit: 4 custom abilities, their handling, 0 custom moves
- [regulation-m-b.md](regulation-m-b.md) — Reg M-B (June 17 → Sept 2), **the live format**: confirmed facts (Mega Raichu X/Y), tactics implications, and the switch-day runbook (complete — reusable for the next regulation)
- [roadmap.md](roadmap.md) — **start here for status**: strategic pillar-grouped backlog + the J north-star, with a current-state header (test counts, active track, top open item). The pillar prose below that header is historical.
- [roadmap-2026-06.md](roadmap-2026-06.md) — ✅ CLOSED/historical: June's time-boxed execution roadmap (per-move cells, Hail-Mary outs, inference backward half, sim oracle + replay ingest, deploy validation), all shipped by 2026-06-12
- [mechanics-coverage.md](mechanics-coverage.md) — full audit of every move/ability/item/weather/terrain across the 3 layers (calc / live engine / lookahead) + the prioritized gap backlog; the single source of truth for "what's left to model"
- [sim-divergences.md](sim-divergences.md) — the EMPIRICAL gap list: where our search disagrees with the real `@pkmn/sim` engine, measured by the diff-harness (run `npx tsx packages/core/src/scripts/sim-diff-report.ts`)
- [vision-plan.md](vision-plan.md) — the @pokechamps/vision live turn-read plan, and **the active track**: the read pipeline is built and live-validated (capture → banner grammar → number-based HP → per-action HP timeline → TUI ratify), so the doc now covers how the live loop actually runs, the P1–P9 closeout, and the short remaining list (live shakeout, `confusionHit`, sprite coverage)
- [sprite-refs-plan.md](sprite-refs-plan.md) + [harvested-vods.md](harvested-vods.md) — the opponent-sprite ref campaign: the colour-histogram method, the verified/provenance contract that gates `readOppTeam`, and the ledger of which VODs have been pulled
- [future-directions.md](future-directions.md) — exploratory, not-yet-scheduled: (1) historic game data → a purpose-trained model (built on the J replay-ingest pipeline + match snapshots + vision capture; opt-in, not an LLM); (2) programmatic Switch control to close the perceive→decide→act loop — with the Bluetooth/MCU research (Windows can't be a BT-Classic HID peripheral → a serial-driven microcontroller is the path; ESP32+PABotBase2 recommended). SEQUENCING: the Switch-control hardware half is LAST.
- [training-data-plan.md](training-data-plan.md) — the fleshed-out plan for future-directions §1: the `DecisionRecord` schema (a projection of `Match`/`SearchResult`/`BattleTranscript`), data sources (replay corpus / match snapshots / vision), the first target task (bring/outcome value — most labels), and the incremental build (types → exporter over the replay corpus → baseline model + eval → opt-in advisory wiring). **PIVOT 2026-06-28:** native simulation on the exact engine replaced replay-scraping; played-out win-rates feed the decision, with a learned value model (hybrid: model proposes, simulator disposes)
- [creator-intel-plan.md](creator-intel-plan.md) — spec for ingesting VGC content-creator videos as OPPONENT threat intelligence (recommended teams + how they're piloted, NOT for our own use): a leading meta indicator vs Pikalytics' lagging usage; LLM-free team extraction (captions + vision + legality) feeds the gauntlet, optional LLM stage extracts piloting commentary; guardrails keep it opt-in/validated/source-tagged

Also here, less central but current:

- [accuracy-roadmap.md](accuracy-roadmap.md) — the tiered damage/state/inference fidelity punch-list (historical; `unmodeled.ts` is the live truth)
- [endgame-search-plan.md](endgame-search-plan.md) — the always-on maximin search: design, budgets, explainability contract
- [tactics.md](tactics.md) — the combo/threat detectors that drive the tactics panel
- [final-team-playbook.md](final-team-playbook.md) — the M-B team (`rain-mb-final`) and how to pilot it
- [mechanics-audit-2026-06-08.md](mechanics-audit-2026-06-08.md) — the custom-mega-ability audit that produced the Dragonize / Mega Sol / Spicy Spray emulations
- [live-share-plan.md](live-share-plan.md) — share tokens + TUI spectator mode
- [ui-polish-plan.md](ui-polish-plan.md) — the TUI polish backlog

Package-level docs worth knowing: [`packages/vision/README.md`](../../packages/vision/README.md) (the input adapter), [`packages/control/README.md`](../../packages/control/README.md) (the output adapter — scaffold, no hardware), and [`packages/core/src/domain/gimmicks/README.md`](../../packages/core/src/domain/gimmicks/README.md) (the add-a-gimmick recipe).

Update these alongside the code that backs them. A note that disagrees with the code is worse than no note at all.
