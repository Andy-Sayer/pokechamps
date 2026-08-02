// Launch the TUI COMPILED instead of via tsx — `npm run start:fast`.
//
// Why this exists: profiling (2026-08-01, docs/notes/compiled-run.md) showed
// ~28% of live-search CPU going to tsx's `keepNames` transform — esbuild's
// `__name` helper re-decorating the closures inside resolveTurn at every one
// of ~1.5M node expansions. Plain esbuild (keepNames off, the default) doesn't
// pay it: the search runs ~1.7× faster wall-clock, which is a full extra
// deepening tier inside the battle turn timer.
//
// What it does, in order:
//   1. esbuild-bundles packages/tui/src/cli.tsx → dist/dev/tui.dev.mjs
//      (same flags as the shipped bundle in bundle-tui.mjs, minus the data
//      copy + tarball — this is a LOCAL launcher, not a distribution).
//      Rebuild is a few hundred ms, so edit → relaunch stays instant.
//   2. Pins POKECHAMPS_DATA_DIR to <repo>/data so data resolution can't
//      drift no matter where the bundle sits (see resolveDataDir()).
//   3. Spawns `node --enable-source-maps dist/dev/tui.dev.mjs` with stdio
//      inherited — the sourcemap keeps stack traces pointing at real .ts/.tsx
//      lines, so crash reports stay as readable as under tsx.
//
// When to use which launcher:
//   npm start       — tsx, zero build step. Fine for UI work; search is slower.
//   npm run start:fast — this file. Use for real matches: the always-on
//                     search gets the compiled speedup.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(repoRoot, 'dist', 'dev', 'tui.dev.mjs');
mkdirSync(dirname(outfile), { recursive: true });

const shim = [
  "import { createRequire as __pcCreateRequire } from 'node:module';",
  'const require = __pcCreateRequire(import.meta.url);',
].join('\n');

const t0 = Date.now();
await build({
  entryPoints: [join(repoRoot, 'packages', 'tui', 'src', 'cli.tsx')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  jsx: 'automatic',
  jsxImportSource: 'react',
  sourcemap: true,
  // Same two runtime accommodations as the shipped bundle (bundle-tui.mjs):
  // Ink's optional devtools import stubbed out; @pkmn/sim left external (the
  // /exact oracle lazy-imports it — Node resolves it from the repo's
  // node_modules by walking up from dist/dev/).
  alias: { 'react-devtools-core': join(repoRoot, 'scripts', 'stub-react-devtools.mjs') },
  external: ['@pkmn/sim'],
  banner: { js: shim },
  legalComments: 'none',
  logLevel: 'warning',
});
console.log(`[start:fast] compiled in ${Date.now() - t0}ms → ${outfile}`);

const child = spawn(process.execPath, ['--enable-source-maps', outfile], {
  stdio: 'inherit',
  env: { ...process.env, POKECHAMPS_DATA_DIR: join(repoRoot, 'data') },
});
child.on('exit', code => process.exit(code ?? 0));
