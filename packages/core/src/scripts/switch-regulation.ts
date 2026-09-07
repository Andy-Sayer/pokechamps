// Switch-day runner: everything in the regulation runbook that does NOT need a
// human, in order, stopping at the first failure.
//
//   npx tsx packages/core/src/scripts/switch-regulation.ts [--with-tests] [--skip-refresh]
//
// The runbook (docs/notes/regulation-m-c.md) has eight steps, but only three of
// them need judgement: pasting the in-game roster, pinning the newly-published
// mega abilities, and repointing Pikalytics. The other five are mechanical, and
// doing them by hand at 19:00 on switch-day is how a step gets skipped. This
// runs them, and gates the "ready" verdict on regulation-readiness exiting 0.
//
// It deliberately does NOT do the three judgement steps — it prints them as a
// pre-flight checklist and asks you to confirm they are done, because a green
// run over a stale roster is worse than no run at all.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const WITH_TESTS = process.argv.includes('--with-tests');
const SKIP_REFRESH = process.argv.includes('--skip-refresh');

interface Step { name: string; cmd: string; args: string[]; why: string }

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const steps: Step[] = [
  ...(SKIP_REFRESH ? [] : [{
    name: 'refresh-data', cmd: npm, args: ['run', 'refresh-data'],
    why: 'pull the updated dex; re-applies every MEGA_ABILITY_OVERRIDES pin to data/species.json',
  }]),
  { name: 'validate-format', cmd: npm, args: ['run', 'validate-format'],
    why: 'every id in the allow-lists resolves' },
  { name: 'tactics-catalog', cmd: 'npx', args: ['tsx', 'packages/core/src/scripts/tactics-catalog.ts'],
    why: 'regenerate the combo catalog over the new legal lists' },
  { name: 'smoketest', cmd: 'npx', args: ['tsx', 'packages/core/src/scripts/smoketest.ts'],
    why: 'forward damage + inverse inference still sane' },
  ...(WITH_TESTS ? [{ name: 'test', cmd: npm, args: ['test'], why: 'full suite' }] : []),
  { name: 'regulation-readiness', cmd: 'npx', args: ['tsx', 'packages/core/src/scripts/regulation-readiness.ts'],
    why: 'THE GATE — exits 1 on any blocker' },
];

console.log('Manual steps this does NOT do — confirm they are done first:');
console.log('  1. stage the in-game roster   npx tsx packages/core/src/scripts/stage-roster.ts --mode replace');
console.log('  2. pin newly-published mega abilities in MEGA_ABILITY_OVERRIDES (gimmicks/mega.ts)');
console.log('     — ONE table now; refresh-data derives data/species.json from it. Drop the forme');
console.log('       from MEGA_ABILITY_UNREVEALED in the same edit, and emulate in damage.ts if custom.');
console.log('  3. repoint CHAMPIONS_PIKA_FORMAT (domain/data.ts + server pikalytics/cache.ts)\n');

let failed: string | null = null;
for (const s of steps) {
  console.log(`\n${'='.repeat(70)}\n>>> ${s.name} — ${s.why}\n${'='.repeat(70)}`);
  const r = spawnSync(s.cmd, s.args, { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) { failed = s.name; break; }
}

console.log(`\n${'='.repeat(70)}`);
if (failed) {
  console.log(`STOPPED at "${failed}" (exit != 0). Fix it and re-run${failed !== 'refresh-data' ? ' (add --skip-refresh to save a minute)' : ''}.`);
  process.exit(1);
}
console.log(`all ${steps.length} mechanical steps green.`);
console.log('Still to do by hand: re-run the gauntlet once real usage data exists');
console.log('  npx tsx packages/core/src/scripts/mb-team-check.ts TalonFlameAndyBoy.json');
console.log('and, while any mega ability is still unrevealed, the sensitivity envelope:');
console.log('  npx tsx packages/core/src/scripts/mc-ability-sensitivity.ts');
