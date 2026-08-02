# Running compiled — why, how, and the gotchas

> 2026-08-01. Companion to [`search-perf-chess-research.md`](search-perf-chess-research.md).
> User-approved on two conditions, both met: the process is documented here,
> and the edit → relaunch cycle stays fast (esbuild compiles the whole TUI in
> **~200-500ms**).

## Why compiled is 1.7× faster

`npm start` runs the TUI through **tsx**, which transforms TypeScript with
esbuild's `keepNames: true`. That setting wraps every function definition in a
`__name(fn, "name")` helper (a `defineProperty` call) so `fn.name` survives
minification. We never minify — but the helper still runs, and `resolveTurn`
(the search's turn resolver) defines ~20 inner closures **per invocation**.
At ~1.5M node expansions per deep search that is ~30M `defineProperty` calls:
**~28% of all search CPU**, measured by `--cpu-prof` on `search-bench.ts`.

Plain esbuild defaults `keepNames` **off**, and since we don't minify,
function names and stack traces are unaffected. Same profile also caught
`loadFormat()` re-reading the format JSON per damage calc (now memoized in
source — that fix helps both launchers).

Measured effect (live turn-1 bench, 7950X): depth 3 in **57s vs 94s**; the
production widening probe reaches **depth 3 instead of depth 2** inside its
9s budget.

## The launchers

| Command | Runtime | Use when |
|---|---|---|
| `npm start` | tsx (no build step) | UI development, quick checks |
| `npm run start:fast` | esbuild bundle → node | **Real matches** — the always-on search gets the 1.7× |

`start:fast` = [`scripts/start-compiled.mjs`](../../scripts/start-compiled.mjs):

1. Bundles `packages/tui/src/cli.tsx` → `dist/dev/tui.dev.mjs` with the same
   flags as the shipped-distribution bundler (`scripts/bundle-tui.mjs`):
   `platform=node, format=esm, jsx=automatic`, Ink's optional
   `react-devtools-core` aliased to a stub, `@pkmn/sim` external (the `/exact`
   oracle lazy-imports it; Node resolves it from the repo `node_modules` by
   walking up from `dist/dev/`).
2. Emits a **sourcemap** and launches with `node --enable-source-maps`, so
   crash stack traces still point at real `.ts`/`.tsx` lines.
3. Pins `POKECHAMPS_DATA_DIR=<repo>/data` in the child env so data resolution
   cannot drift regardless of where the bundle sits.

There is no watch mode: each `start:fast` run recompiles from scratch
(~200-500ms) — after editing code, quit the TUI and rerun. No stale-bundle
hazard, nothing to clean.

## Gotchas this migration already hit (read before touching data loading)

Bundling moves `import.meta.url` to the bundle file, which breaks any module
that derives a data path from its own source location. Four runtime modules
did exactly that (`pikalytics.ts`, `typechart.ts`, `storage.ts`,
`pikalyticsFetch.ts`) — under any bundle, Pikalytics priors silently vanished
and the **type chart loaded empty** (every matchup neutral). Fixed by routing
all of them through `data.ts`'s probed `dataDirPath()` (env override → source
tree → bundle-adjacent → cwd). Validated by `search-bench`: the bundled run
now reproduces the source-tree run's scores and node counts exactly.

**Rule going forward: never `join(import.meta.url-derived dir, ...)` to reach
`data/` or any repo path — always go through `dataDirPath()`.** The probing
resolver is the only path-resolution that survives all three run shapes
(source tsx, local `start:fast` bundle, shipped tarball bundle).

Scripts (`packages/*/src/scripts/**`, `scripts/*.mjs`) are exempt — they run
from the source tree by definition.

## Verifying a runtime change didn't alter behavior

`search-bench.ts` doubles as the equivalence check: run it under both
runtimes; scores and node counts must match exactly (they are deterministic).
The gauntlet scenario needs no live data; the live scenario also exercises
Pikalytics priors + the format file, so it catches data-path regressions like
the ones above.

```
npx tsx packages/core/src/scripts/search-bench.ts --depth 2
npx esbuild packages/core/src/scripts/search-bench.ts --bundle --platform=node \
  --format=esm --target=node22 --outfile=dist/dev/bench.mjs \
  --banner:js="import { createRequire as R } from 'node:module'; const require = R(import.meta.url);"
node dist/dev/bench.mjs --depth 2
```
