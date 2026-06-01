---
name: sync-showdown
description: Review upstream Pokémon Showdown / @pkmn / @smogon changes and apply the relevant ones to PokeChamps. Use when checking for game-data or battle-mechanic updates, bumping @pkmn/dex, @pkmn/data, @smogon/calc, or @pkmn/sim, or when the user says the calc/data feels stale or a new mechanic isn't modelled.
---

# Sync with Showdown (keep our model from drifting)

PokeChamps derives its game truth from Showdown: `@pkmn/dex` + `@pkmn/data` (data),
`@smogon/calc` (per-hit damage), and — once added — `@pkmn/sim` (the full battle
engine). Showdown ships changes (new mechanics, data fixes, balance/format updates).
This skill reviews what changed upstream and applies the relevant parts to our side,
then proves nothing broke.

**Ground truth, in priority order:** the `@pkmn/*` + `@smogon/calc` npm releases
(these track Showdown), then the `smogon/pokemon-showdown` repo (`sim/`, `data/`),
then Bulbapedia/Serebii for the human-readable rule. Never reimplement the calc.

## Procedure

### 1. Snapshot what we pin now
- Read the `@pkmn/*` and `@smogon/calc` versions in `packages/core/package.json`
  (and `@pkmn/sim` if present). Record the current installed versions
  (`npm ls @pkmn/dex @pkmn/data @smogon/calc @pkmn/sim --workspace @pokechamps/core`).

### 2. See what's newer upstream
- For each dep, compare pinned vs latest: `npm view <pkg> version` and
  `npm view <pkg> time --json` (release dates). List the gap.
- Skim the changelogs / release notes:
  - `@pkmn`: the `pkmn/ps` monorepo releases (WebFetch the package's npm page or the
    `pkmn/ps` GitHub releases).
  - `@smogon/calc`: GitHub releases for `smogon/damage-calc`.
  - Mechanics: `smogon/pokemon-showdown` commit log filtered to `sim/` and the
    current gen's `data/` (WebSearch/WebFetch the repo). Focus ONLY on things in
    scope for our format (read `data/format.champions.json`: Gen 9, Reg M-A,
    **Mega** gimmick, doubles, the legal species/items). Ignore other gens/formats.

### 3. Decide what's relevant
Map each upstream change to one of our layers (see `docs/notes/mechanics-coverage.md`,
the single source of truth for coverage):
- **Data** (species/move/item/ability numbers, learnsets, legality) → handled by a
  data refresh (step 4). Most changes are here.
- **Per-hit damage** (`@smogon/calc`) → a version bump; no code, just re-verify.
- **Multi-turn mechanic** we hand-roll in `endgameSearch.ts` (turn order, residuals,
  hazards, weather/terrain, status, boosts…) → port the rule from Showdown's `sim/`
  source and update the matching code + `mechanics-coverage.md` row. This is the
  `[[project_sim_engine_strategy]]` step-2 work.
- Anything NOT in our format's scope → note and skip.

### 4. Apply data + version changes
- Bump the dep versions in `packages/core/package.json`, `npm install`.
- `npm run refresh-data` — re-dumps `@pkmn/dex` into `data/*.json`. It PRESERVES
  `data/format.champions.json` (the hand-maintained allow-lists); confirm that file
  is unchanged in the diff.
- `npm run validate-format` — every id in the allow-lists must still resolve.
- Review the `data/*.json` diff: call out species/move/item changes that touch
  legal-for-Champions entries (those can shift inferences and recommendations).

### 5. Apply mechanic changes (if any)
- For each in-scope `sim/` change, find our counterpart (grep the mechanic name in
  `packages/core/src/domain/`), port the corrected rule, and update its
  `mechanics-coverage.md` row + test. If `@pkmn/sim` is wired as the exact-engine
  oracle, run the diff harness (our `resolveTurn` vs sim) to surface divergences
  introduced by the update.

### 6. Prove nothing broke
- `npm run typecheck`
- `npm test` (full workspace suite)
- `npx tsx packages/core/src/scripts/smoketest.ts` (forward damage + inverse inference)
- Spot-check a known damage line against the live Pikalytics calc (per CLAUDE.md).

### 7. Record
- Update `docs/notes/mechanics-coverage.md` for any coverage change.
- Note the version bumps + what changed in the commit message; if a mechanic moved
  from GAP→✅ (or a new GAP appeared), update the relevant memory.
- Commit only when the user asks (follow repo convention; branch first if on `main`).

## Notes
- Be conservative: a data refresh can silently change many numbers. Diff carefully and
  keep the change reviewable — prefer a dedicated commit for the bump, separate from
  feature work.
- If a change is large or risky (e.g. a calc major version with formula changes),
  surface it to the user with the specific lines affected rather than applying blindly.
