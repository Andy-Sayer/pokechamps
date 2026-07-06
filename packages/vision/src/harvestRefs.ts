// Grow the sprite-ref table from the user's CONFIRMED opponent picks — ground-truth labels,
// so the read self-improves with use (fewer manual keys over time). Live-harvested refs get a
// `-live` id so they COEXIST with the curated VOD refs (never clobber them); both map to the
// same species name, so the matcher just gains coverage. Only legal, panel-present frames.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFrame } from './decode.js';
import { cropRegion } from './visionSource.js';
import { CHAMPIONS_TEAM_PREVIEW, CHAMPIONS_OPP_PANEL_BG, insetRect } from './regions.js';
import { colorHistogram, quadrantHistogram, type ColorHistRef } from './colorHist.js';
import { detectPanel, DEFAULT_LIVE_TAP } from './oppTeamRead.js';
import type { Rect } from './types.js';
import { dataDirPath, toId, isLegalSpecies, getSpecies } from '@pokechamps/core/domain/data.js';

const BINS = 4;
const SNAP = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/live/chooser-frame.png');

/** Freeze the current live frame so the SAME frame that's read can be harvested on confirm
 *  (latest.png keeps changing). Returns the frozen path (falls back to the tap if copy fails). */
export function snapshotLiveFrame(tap: string = DEFAULT_LIVE_TAP): string {
  try { copyFileSync(tap, SNAP); return SNAP; } catch { return tap; }
}

/** Harvest a sprite ref for each confirmed (species-set) slot from a preview frame. Upserts a
 *  `<id>-live` ref per species. Returns the species harvested. No-op if not a preview screen. */
export async function harvestConfirmedRefs(framePath: string, confirmed: (string | null)[]): Promise<string[]> {
  const frame = await loadFrame(framePath);
  const panel = detectPanel(frame);
  if (!panel.present) return [];
  const ins = panel.ins;
  const refsPath = join(dataDirPath(), 'sprite-refs.json');
  const store = existsSync(refsPath) ? JSON.parse(readFileSync(refsPath, 'utf8')) as { bins?: number; refs: (ColorHistRef & { verified?: boolean })[] } : { bins: BINS, refs: [] };
  const refs = store.refs;
  const byId = new Map(refs.map(r => [r.id, r] as const));
  const harvested: string[] = [];
  CHAMPIONS_TEAM_PREVIEW.oppTeam.forEach((o, i) => {
    const name = confirmed[i];
    if (!name?.trim()) return;
    const baseId = toId(name);
    if (!isLegalSpecies(baseId)) return;                       // a legal opponent only
    const rect = ins ? insetRect(o.sprite as Rect, ins) : (o.sprite as Rect);
    const c = cropRegion(frame, rect);
    const opts = { bins: BINS, bgColor: CHAMPIONS_OPP_PANEL_BG, darkThreshold: 55 };
    const hist = colorHistogram(c.data, c.width, c.height, opts).map(v => +v.toFixed(5));
    const quad = quadrantHistogram(c.data, c.width, c.height, opts).map(v => +v.toFixed(5));
    const canonical = (getSpecies(baseId) as { name?: string } | undefined)?.name ?? name;
    const id = `${baseId}-live`;
    const ref = { id, name: canonical, hist, quad, verified: true };
    const ex = byId.get(id);
    if (ex) Object.assign(ex, ref); else { refs.push(ref); byId.set(id, ref); }
    harvested.push(canonical);
  });
  if (harvested.length) writeFileSync(refsPath, JSON.stringify({ bins: store.bins ?? BINS, refs }) + '\n');
  return harvested;
}
