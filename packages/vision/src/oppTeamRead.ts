// Reusable opponent team-preview read: identify the opponent's six from a preview frame.
// TYPE-COMBO-FIRST: read each card's type icons (18 fixed colours) → the legal species with
// that combo (a handful), then use the sprite colour-hist only to break ties / confirm. This
// makes cross-type false-positives impossible (a Steel/Fairy "Mawile" can't be returned for
// an Electric/Dark Morpeko) and turns a sparse sprite table into "pick from 1-5", not 208.
//
// LAYOUT-AWARE: works for your direct play (game fills 1080p) AND a GameShare screen-share
// (game is a 5/6 centred inset) — auto-detected, no flag.
import { loadFrame } from './decode.js';
import { CHAMPIONS_TEAM_PREVIEW, CHAMPIONS_OPP_PANEL_BG, GAMESHARE_INSET, insetRect, type ScreenInset } from './regions.js';
import { cropRegion } from './visionSource.js';
import { HistogramMatcher, loadColorHistRefs } from './colorHist.js';
import { readTypeIcons, type PkType } from './typeIcons.js';
import type { Frame, Rect } from './types.js';
import { speciesTypes } from '@pokechamps/core/domain/typechart.js';
import { loadFormat, getSpecies, toId } from '@pokechamps/core/domain/data.js';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';

export interface OppSlotRead {
  slot: number;          // 1-6
  name: string;          // best identification (sprite match iff type-consistent, or the sole
                         // type candidate, else '' → use `candidates`)
  score: number;         // sprite colour-hist confidence 0..1
  types: PkType[];       // read type combo (left→right); [] if unread
  candidates: string[];  // legal species with that exact type combo (the shortlist)
  source: 'sprite+type' | 'type-only' | 'sprite' | 'unknown';
}

export const DEFAULT_LIVE_TAP = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/live/latest.png');
export const OPP_READ_CONF = 0.7;

// --- type combo → legal species (cached) ---
let _byCombo: Map<string, string[]> | null = null;
const comboKey = (ts: readonly string[]) => ts.map(t => t.toLowerCase()).sort().join('/');
function legalByCombo(): Map<string, string[]> {
  if (_byCombo) return _byCombo;
  const m = new Map<string, string[]>();
  for (const id of loadFormat().legality.allow) {
    const sp = getSpecies(id); if (!sp) continue;
    const key = comboKey(speciesTypes(sp.name));
    if (!m.has(key)) m.set(key, []);
    if (!m.get(key)!.includes(sp.name)) m.get(key)!.push(sp.name);
  }
  _byCombo = m; return m;
}
function candidatesFor(types: PkType[]): string[] {
  return types.length ? (legalByCombo().get(comboKey(types)) ?? []) : [];
}

/** Fraction of a crop matching the opponent-panel magenta (the sprites sit on it). */
function magentaFrac(c: { data: Uint8ClampedArray | Buffer; width: number; height: number }): number {
  const [R, G, B] = CHAMPIONS_OPP_PANEL_BG;
  let mag = 0; const tot = c.data.length / 4;
  for (let p = 0; p < c.data.length; p += 4) if (Math.abs(c.data[p]! - R) < 45 && Math.abs(c.data[p + 1]! - G) < 45 && Math.abs(c.data[p + 2]! - B) < 45) mag++;
  return tot ? mag / tot : 0;
}

/** Detect the opponent panel: whether it's PRESENT at all (magenta panel behind the six
 *  sprites — else this ISN'T a team-preview screen and we must not invent mons), and if so
 *  whether it's the GameShare 5/6 inset. Measured: real preview ≈0.72 magenta, menu/battle
 *  ≈0.00, so the 0.15 gate is safe. */
export function detectPanel(frame: Frame): { present: boolean; ins?: ScreenInset } {
  let full = 0, inset = 0;
  for (const o of CHAMPIONS_TEAM_PREVIEW.oppTeam) {
    full += magentaFrac(cropRegion(frame, o.sprite as Rect));
    inset += magentaFrac(cropRegion(frame, insetRect(o.sprite as Rect, GAMESHARE_INSET)));
  }
  const n = CHAMPIONS_TEAM_PREVIEW.oppTeam.length;
  const fullF = full / n, insetF = inset / n;
  if (Math.max(fullF, insetF) < 0.15) return { present: false };
  return { present: true, ins: insetF > fullF * 1.5 ? GAMESHARE_INSET : undefined };
}

/** Is the shared screen a GameShare inset? (Only meaningful when a panel is present.) */
export function detectGameshareInset(frame: Frame): boolean { return detectPanel(frame).ins != null; }

/** Persist the last chooser read (frame + per-slot result, or the failure reason) so a read
 *  that misbehaved live can be diagnosed offline with the exact frame the user saw. Best-effort. */
export function saveChooserDebug(framePath: string, result: OppSlotRead[] | { error: string }): void {
  try {
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/chooser-debug');
    mkdirSync(dir, { recursive: true });
    copyFileSync(framePath, join(dir, 'last-frame.png'));
    writeFileSync(join(dir, 'last-read.json'), JSON.stringify(result, null, 2));
  } catch { /* best-effort — never break the read over diagnostics */ }
}

/** Directory where opponent team-sheet frames are durably archived. */
export const OPP_SHEETS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/opp-sheets');

/** Durably archive an opponent team-sheet frame under a TIMESTAMPED name (never overwritten),
 *  so its sprites can be harvested later. This is the keepable counterpart to snapshotLiveFrame /
 *  saveChooserDebug, both of which write a single slot that every read clobbers. The filename
 *  embeds the read species for at-a-glance identification, with a `<ts>.json` sidecar of the full
 *  read. Best-effort: returns the saved png path, or null on failure (never breaks the read). */
export function archiveOppSheet(framePath: string, result?: OppSlotRead[]): string | null {
  try {
    mkdirSync(OPP_SHEETS_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');           // fs-safe + sortable
    const names = (result ?? []).map(r => r.name).filter(Boolean).join('-').replace(/[^A-Za-z0-9-]/g, '').slice(0, 80);
    const base = names ? `${ts}__${names}` : ts;
    const png = join(OPP_SHEETS_DIR, `${base}.png`);
    copyFileSync(framePath, png);
    if (result) writeFileSync(join(OPP_SHEETS_DIR, `${base}.json`), JSON.stringify(result, null, 2));
    return png;
  } catch { return null; }
}

/** Read the opponent's six. For each slot: read the type combo → candidate species, sprite-
 *  match, and reconcile. `name` is the sprite match when it's type-consistent, else the sole
 *  type candidate, else '' (use `candidates`). Auto-detects direct vs GameShare layout. */
export async function readOppTeamFromFrame(path: string = DEFAULT_LIVE_TAP): Promise<OppSlotRead[]> {
  const refs = loadColorHistRefs();
  if (!refs.length) throw new Error('no data/sprite-refs.json — run scripts/bootstrap-refs.ts');
  const frame = await loadFrame(path);
  // Preview-presence gate: no opponent panel on screen → this isn't the "Select N Pokémon"
  // screen, so refuse rather than invent mons from menu/battle/arena pixels.
  const panel = detectPanel(frame);
  if (!panel.present) throw new Error('no team-preview on screen — point the capture at the "Select 4 Pokémon" screen and retry');
  const matcher = new HistogramMatcher(refs, { bgColor: CHAMPIONS_OPP_PANEL_BG });
  const ins = panel.ins;
  const typeReads = readTypeIcons(frame, ins);
  return CHAMPIONS_TEAM_PREVIEW.oppTeam.map((o, i) => {
    const rect = ins ? insetRect(o.sprite as Rect, ins) : (o.sprite as Rect);
    const c = cropRegion(frame, rect);
    const m = matcher.match(c.data, c.width, c.height);
    const spriteName = m?.name ?? '', score = m?.score ?? 0;
    const types = typeReads[i]?.types ?? [];
    const candidates = candidatesFor(types);
    const spriteAgrees = !!spriteName && types.length > 0 && comboKey(speciesTypes(spriteName)) === comboKey(types);
    let name = '', source: OppSlotRead['source'] = 'unknown';
    if (spriteAgrees) { name = spriteName; source = 'sprite+type'; }        // both agree → trust
    else if (candidates.length === 1) { name = candidates[0]!; source = 'type-only'; } // types alone pin it
    else if (types.length === 0 && spriteName) { name = spriteName; source = 'sprite'; } // no type read → sprite guess
    else if (candidates.length === 0 && spriteName) { name = spriteName; source = 'sprite'; } // NEVER BLANK: no type candidates (unread/rare combo) → the sprite's best guess beats an empty slot the user must type from scratch. Flagged 'sprite' (untrusted) so the UI prompts a check.
    // else: multiple type candidates, sprite-inconsistent → name '' , caller picks from the shortlist
    return { slot: i + 1, name, score, types, candidates, source };
  });
}
