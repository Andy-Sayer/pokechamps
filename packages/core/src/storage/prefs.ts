// Sticky per-user UI preferences (Theme 6 TUI polish): tiny JSON sidecar in
// the resolved data dir (source tree: repo data/; bundle: next to tui.mjs's
// data/). Best-effort by design — a read-only filesystem or corrupt file
// degrades to defaults silently; preferences are never worth an error box.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';

export interface UiPrefs {
  /** Battle grid: show the crit damage column (/crit). */
  showCrits?: boolean;
  /** Battle grid: expand all my moves per opp (/allmoves). */
  showAllMoves?: boolean;
  /** Pika sprite preview mode ('run' | 'idle' | null). */
  pikaPreview?: string | null;
  /** Battle grid: sixel sprites of the active opponents (/sprites). */
  showSprites?: boolean;
}

const FILE = 'prefs.json';

export function loadPrefs(): UiPrefs {
  try {
    const p = join(dataDirPath(), FILE);
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, 'utf8')) as UiPrefs;
  } catch {
    return {};
  }
}

export function savePrefs(patch: Partial<UiPrefs>): void {
  try {
    const merged = { ...loadPrefs(), ...patch };
    writeFileSync(join(dataDirPath(), FILE), JSON.stringify(merged, null, 2), 'utf8');
  } catch {
    /* best-effort */
  }
}
