// Bundle the Ink TUI into a single distributable a friend can run with a bare
// `node tui.mjs` — no npm install, no monorepo checkout.
//
// Output (under dist/):
//   dist/tui/tui.mjs            — the bundled CLI (esbuild, ESM, node target)
//   dist/tui/data/              — the editable game-data JSON (species, moves…)
//   dist/pokechamps-tui.tar.gz  — the two above, tarred for the download route
//
// Why a tarball and not a lone .mjs: data.ts reads data/*.json at runtime for
// damage/species/format lookups (the server is storage-only). The bundle finds
// that dir via resolveDataDir() in packages/core/src/domain/data.ts, which
// probes `<bundleDir>/data` — so the tarball lays them out side by side.
//
// The TUI pulls in zero native modules (better-sqlite3 is server-only), so a
// flat single-file bundle is safe. Run with: npm run bundle:tui
import { build } from 'esbuild';
import { rmSync, mkdirSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'dist');
const bundleDir = join(distDir, 'tui');
const entry = join(repoRoot, 'packages', 'tui', 'src', 'cli.tsx');
const dataSrc = join(repoRoot, 'data');

// Clean previous output so stale files never ship.
rmSync(bundleDir, { recursive: true, force: true });
mkdirSync(bundleDir, { recursive: true });

// Some transitive CJS deps reach for `require` at runtime even in an ESM
// output. Re-create it from import.meta.url so the bundle is self-contained.
// We deliberately do NOT shim __dirname/__filename here: data.ts declares its
// own `const __dirname` from import.meta.url, and a top-level banner const of
// the same name collides ("Identifier '__dirname' has already been declared").
const shim = [
  "import { createRequire as __pcCreateRequire } from 'node:module';",
  'const require = __pcCreateRequire(import.meta.url);',
].join('\n');

await build({
  entryPoints: [entry],
  outfile: join(bundleDir, 'tui.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  jsx: 'automatic',
  jsxImportSource: 'react',
  // Ink statically imports react-devtools-core but only uses it when DEV=true,
  // which the shipped bundle never sets. Alias it to a no-op stub so esbuild
  // can bundle Ink without that optional dep present at runtime.
  alias: { 'react-devtools-core': join(repoRoot, 'scripts', 'stub-react-devtools.mjs') },
  // @pkmn/sim (the whole Showdown engine, used only by the opt-in /exact
  // oracle) stays OUT of the bundle: simBridge lazy-imports it and degrades to
  // "exact engine unavailable" when missing. A bundle user can `npm i
  // @pkmn/sim` next to tui.mjs to enable /exact.
  external: ['@pkmn/sim'],
  // Keep node builtins external (node: prefix handled automatically).
  banner: { js: `#!/usr/bin/env node\n${shim}` },
  legalComments: 'none',
  logLevel: 'info',
});

// Ship the editable game data next to the bundle. resolveDataDir() looks for
// species.json here.
if (!existsSync(join(dataSrc, 'species.json'))) {
  console.error(`\n[bundle-tui] data/species.json not found at ${dataSrc}. Run \`npm run refresh-data\` first.`);
  process.exit(1);
}
cpSync(dataSrc, join(bundleDir, 'data'), { recursive: true });

// Tar it up for the server download route. tar ships with Windows 10+, macOS,
// and Linux, so this works cross-platform without a node tar dep.
const tarball = join(distDir, 'pokechamps-tui.tar.gz');
rmSync(tarball, { force: true });
// --force-local (Windows only): GNU tar otherwise reads the `C:` in a Windows
// path as a remote rsync host and fails. macOS/Linux paths have no drive colon.
const tarArgs = process.platform === 'win32' ? ['--force-local'] : [];
execFileSync('tar', [...tarArgs, '-czf', tarball, '-C', distDir, 'tui'], { stdio: 'inherit' });

// SHA-256 checksum so a downloader can verify integrity (and reproduce the
// build to confirm authenticity — see SHARE.md). Written in the sha256sum
// format `<hex>  <filename>` so `sha256sum -c pokechamps-tui.tar.gz.sha256`
// works directly.
const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');
const checksumFile = `${tarball}.sha256`;
writeFileSync(checksumFile, `${digest}  ${basename(tarball)}\n`);

console.log(`\n[bundle-tui] wrote ${join(bundleDir, 'tui.mjs')}`);
console.log(`[bundle-tui] wrote ${tarball}`);
console.log(`[bundle-tui] wrote ${checksumFile}`);
console.log(`[bundle-tui] sha256: ${digest}`);
console.log('[bundle-tui] friend runs:  tar xzf pokechamps-tui.tar.gz && node tui/tui.mjs');
