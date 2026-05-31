# PokeChamps notes

Long-form notes that don't belong in CLAUDE.md (which stays a tight, always-loaded project guide). Each file here covers one topic in enough depth to onboard a new contributor — or a fresh Claude session.

- [battle-syntax.md](battle-syntax.md) — every action / state line / slash command the BattleScreen parser accepts
- [speed-inference-brackets.md](speed-inference-brackets.md) — how `effectivePriority` decides which action pairs generate speed signals (Quick Claw, Prankster, Gale Wings, Triage, Stall, pivot switches)
- [dual-forme-predictions.md](dual-forme-predictions.md) — pre-mega base + post-mega display contract; `resolveSpecies(active)` semantics
- [spread-modifier.md](spread-modifier.md) — auto `isSpread` for `allAdjacent` / `allAdjacentFoes` targets
- [roadmap.md](roadmap.md) — pillar-grouped backlog with "recently shipped" + priority ordering
- [mechanics-coverage.md](mechanics-coverage.md) — full audit of every move/ability/item/weather/terrain across the 3 layers (calc / live engine / lookahead) + the prioritized gap backlog; the single source of truth for "what's left to model"

Update these alongside the code that backs them. A note that disagrees with the code is worse than no note at all.
