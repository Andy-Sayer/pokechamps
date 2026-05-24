# CLAUDE.md

Guidance for Claude Code when working in this repo.

Longer-form notes live in [`docs/notes/`](docs/notes/README.md) — battle syntax, speed inference brackets, dual-forme predictions, spread modifier, roadmap. Read those when touching the related code; update them alongside the change.

## What this is

Node TUI assistant for Pokémon Champions doubles:

1. Pick 4-of-6 to bring vs. the opponent's 6.
2. Log moves + damage turn-by-turn during a manual match.
3. Infer opponent EV spreads/items/natures from observed damage and predict damage ranges for my moves.

**Format**: Regulation Set M-A (Apr 8 – Jun 17, 2026) — 186 legal species, 117 legal items, **Mega Evolution** (not Tera), item + species clauses on, one mega per battle. Allow-lists live in `data/format.champions.json`. `PokemonSet` has no mega flag — a held mega stone is sufficient signal at the **team validation** layer. For **in-battle damage calcs**, the mega gimmick's `resolveSpecies({set, active})` hook only swaps the base forme for the mega forme name (e.g. Charizard + Charizardite Y -> `Charizard-Mega-Y`) when `active === true`. Pre-mega (stone held, not yet activated) uses base-forme stats. After `/mega` is logged, `applyMegaAction` remaps candidate species names directly. See [`docs/notes/dual-forme-predictions.md`](docs/notes/dual-forme-predictions.md).

## Commands

- `npm install`
- `npm start` — launch the TUI
- `npm run typecheck` — `tsc --noEmit`
- `npm run refresh-data` — dump `@pkmn/dex` into `data/*.json`. Preserves `format.champions.json`.
- `npm run validate-format` — confirm every id in the format allow-lists resolves in `@pkmn/dex`. Run after hand-editing the format file.
- `npx tsx packages/core/src/scripts/smoketest.ts` — forward damage + inverse inference sanity check.
- `npm test` — vitest suite. Also verify against Pikalytics calc and the smoketest for damage changes.

## Architecture

**Monorepo layout.** npm workspaces under `packages/`: `core` (domain logic, inference, damage, match engine, data scripts, AI wrapper), `tui` (Ink CLI — the primary surface), `server` (optional remote mode), `web` (read-only viewer). Paths below are relative to those packages; core lives at `packages/core/src/`, the TUI at `packages/tui/src/`.

**Data (`packages/core/src/domain/data.ts`, `packages/core/src/scripts/refresh-data.ts`).** Game data is dumped from `@pkmn/dex` into editable JSON under `data/`. Always read via `getSpecies/getMove/getItem/getAbility/getNature` — never import from `@pkmn/dex` elsewhere, or you bypass the editable layer. `loadFormat()` / `isLegalSpecies()` / `isLegalItem()` / `searchLegalSpecies()` consume `format.champions.json`.

**Damage (`packages/core/src/domain/damage.ts`).** Thin wrapper around `@smogon/calc`'s `calculate()`. Do not reimplement the formula. `damageRange()` is the public entry.

**Inference (`packages/core/src/domain/inference.ts`).** Inverse solver. Enumerates a coarse EV grid (`[0,4,84,124,156,196,252]` on HP/Def/SpD) × common defensive natures × common items; keeps combos whose forward damage range contains the observed value. Each new `DamageObservation` narrows the candidate set. Coarse on purpose — exhaustive search is too slow for live use.

**Bring (`packages/core/src/domain/bring.ts`).** Scores all 15 brings on offense / defense / speed / roles. Unknown opponent spreads fall back to `defaultOpponentSet()`; once inference populates `OpponentEntry.candidates`, `resolvedOpponentSet()` uses the top one.

**AI (`packages/core/src/ai/`).** Anthropic SDK wrapper using `claude-opus-4-7`, with `cache_control: ephemeral` on the static team/opponent context. `explainBring()` and `narrateInference()` are called on demand from the TUI and no-op gracefully without `ANTHROPIC_API_KEY`.

**TUI (`packages/tui/src/cli.tsx`, `packages/tui/src/ui/`).** Ink 7 + React 19. Route reducer: `menu → pick-team → opponent → bring → battle`. Team input is paste-based via `TeamPaste.tsx` (`parseShowdownTeam()`); a per-field form was rejected as a UX regression. `OpponentInput.tsx` is species-only at preview, with autocomplete filtered to the Champions legal list; items/abilities/moves are learned later from battle observations. `BattleScreen.tsx` runs forward damage for every (my mon, opp mon, move) triple and accepts a single-line turn log `m1 > Astral Barrage > o2 > 67`; on submit it updates `OpponentEntry.candidates` via the inference solver.

**Gimmicks (`packages/core/src/domain/gimmicks/`).** Mega / Tera / Z-Move / Dynamax sit behind a pluggable `Gimmick` interface so each regulation set can swap one in. The registry in `index.ts` is keyed by `format.champions.json`'s `gimmick` field; `activeGimmick()` resolves it lazily and the rest of the engine (Showdown parse/format, `@smogon/calc` enrichment, inference variants, battle UI, validation, AI prompt summaries) dispatches through optional hooks. Today only `mega` is implemented; the other ids fall back to `noneGimmick`. See `packages/core/src/domain/gimmicks/README.md` for the add-a-gimmick recipe.

**Storage (`packages/core/src/domain/storage.ts`).** Teams in `data/my-teams/<name>.json` as `PokemonSet[]`. Match snapshots in `matches/<id>.json` (gitignored); press `s` in BattleScreen to snapshot.

## Conventions

- Imports use `.js` extensions even from `.ts` files — required for `moduleResolution: bundler` + ESM. Don't drop them.
- Stat keys are lowercase `hp/atk/def/spa/spd/spe`. Don't import `StatID` from `@smogon/calc`; use our own type.
- Showdown export is the canonical team format; `PokemonSet` matches it field-for-field.
- Windows Terminal's bracketed-paste handling is unreliable for Ink, so `TeamPaste.tsx` accumulates keystrokes via `useInput` in addition to `usePaste`. Confirm key is **Ctrl+S** to avoid colliding with pasted text.
