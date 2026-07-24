// Startup batch harvest of archived opponent team-sheets — the app-owned version of
// the "pick up the manually-keyed captures" routine. Spawned as a detached child
// (the serve/watcher pattern) so decoding PNGs can never jank the Ink render; the
// `.harvested.json` markers make repeat runs near-instant. Best-effort: any failure
// is silent (the batch is a safety net — Ctrl+D confirms already harvest live).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../../vision/scripts/harvest-all-sheets.ts', import.meta.url));

let ran = false;

/** Run once per app launch; calls `onDone` with a short human note when refs were
 *  actually added (silent otherwise — routine no-op sweeps shouldn't chatter). */
export function startupSheetHarvest(onDone: (note: string) => void): void {
  if (ran) return;
  ran = true;
  let total = 0;
  try {
    const p = spawn(process.execPath, ['--import', 'tsx', SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'] });
    p.unref();
    (p.stdout as { unref?: () => void } | null)?.unref?.();
    if (p.stdout) createInterface({ input: p.stdout }).on('line', line => {
      const m = line.match(/^Total refs upserted: (\d+)/);
      if (m) total = parseInt(m[1]!, 10);
    });
    p.on('exit', code => {
      if (code === 0 && total > 0) onDone(`⌁ harvested ${total} sprite ref(s) from archived team sheets`);
    });
    p.on('error', () => { /* best-effort */ });
  } catch { /* best-effort */ }
}
