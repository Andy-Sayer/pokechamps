// Team-summary importer: OCR the in-game Team summary screens into PokemonSet[].
// The screen has two pages (L/R toggle) that together carry a complete set for all
// six mons — a full team import from two frames, replacing the Showdown paste:
//   "Moves & More" — species, ability, held item, the 4 moves.
//   "Stats"        — all six FINAL stats + the 0-32 stat-point investment printed
//                    next to each stat, and nature ARROWS (red-up / blue-down icons
//                    on the boosted/dropped stat labels).
// Reference frames: fixtures/team-summary-moves.png / team-summary-stats.png
// (1080p direct HDMI, calibration basis for the region grid below).
//
// Trust model: every OCR'd field is fuzzy-matched against its LEGAL candidate set
// (species → ability slots → learnset → legal items), then the stats page is
// VERIFIED: recompute each stat from base+SP+nature at L50 and compare with the
// OCR'd final stat. A mismatch tries IV0 (common tanked Atk/Spe), then re-solving
// the SP from the final stat; what can't be reconciled becomes a warning, never a
// silent guess.

import type { Frame, Rect } from './types.js';
import type { OcrReader } from './ocr.js';
import { cropRegion } from './visionSource.js';
import { matchSpecies, bestMatch } from './fuzzyMatch.js';
import {
  getSpecies, getItem, getNature, getLearnset, listItems, isLegalItem, loadFormat, toId,
} from '@pokechamps/core/domain/data.js';
import { evFromSp } from '@pokechamps/core/domain/pikalytics.js';
import type { PokemonSet, Stats, StatID } from '@pokechamps/core/domain/types.js';

// ---------- region grid (calibrated on the 1080p fixtures) ----------

const PX = (x: number, y: number, w: number, h: number): Rect => ({ x: x / 1920, y: y / 1080, w: w / 1920, h: h / 1080 });
const CARD_X = [185, 985] as const;
const CARD_Y = [292, 510, 728] as const;

/** Card i (0..5) → its top-left in px. Cards run L,R per row: 1=TL 2=TR 3=ML … */
const cardOrigin = (i: number): { cx: number; cy: number } => ({ cx: CARD_X[i % 2]!, cy: CARD_Y[Math.floor(i / 2)]! });

export const nameRect = (i: number): Rect => { const { cx, cy } = cardOrigin(i); return PX(cx + 75, cy + 10, 280, 44); };
const abilityRect = (i: number): Rect => { const { cx, cy } = cardOrigin(i); return PX(cx + 88, cy + 58, 260, 38); };
const itemRect = (i: number): Rect => { const { cx, cy } = cardOrigin(i); return PX(cx + 80, cy + 100, 340, 44); };
const moveRect = (i: number, k: number): Rect => { const { cx, cy } = cardOrigin(i); return PX(cx + 495, cy + 12 + k * 45, 255, 40); };

/** Stats page: rows 0..2, left block = HP/Atk/Def, right = SpA/SpD/Spe. */
const STAT_ORDER: StatID[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
export const statRects = (i: number, s: number): { label: Rect; value: Rect; sp: Rect } => {
  const { cx, cy } = cardOrigin(i);
  const right = s >= 3;
  const y = cy + 58 + (s % 3) * 45;
  return right
    ? { label: PX(cx + 425, y, 165, 38), value: PX(cx + 570, y, 100, 38), sp: PX(cx + 654, y, 92, 38) }
    : { label: PX(cx + 80, y, 155, 38), value: PX(cx + 200, y, 105, 38), sp: PX(cx + 286, y, 92, 38) };
};

// ---------- nature arrows (red-up = boosted, blue-down = dropped) ----------

/** Detect the boost arrow icon inside a stat-label crop. Measured on the 1080p
 *  fixture: the UP arrow is pink-red ≈(235,110,145), DOWN is light cyan ≈(150,215,230).
 *  The GREEN channel is the discriminator that keeps the purple card bg ≈(130,115,190)
 *  out of "down" (purple has b-r high too, but g≈r; the cyan arrow has g-r ≈ +65) and
 *  white text out of both (r=g=b). Returns 'up' | 'down' | null. */
export function detectArrow(c: { data: Uint8ClampedArray; width: number; height: number }): 'up' | 'down' | null {
  let red = 0, blue = 0;
  for (let p = 0; p < c.data.length; p += 4) {
    const r = c.data[p]!, g = c.data[p + 1]!, b = c.data[p + 2]!;
    if (r > 190 && r - g > 70 && g < 170) red++;
    else if (b > 190 && g > 180 && g - r > 40) blue++;
  }
  const min = Math.max(12, c.data.length / 4 / 400);   // scale-invariant floor vs stray pixels
  if (red >= min && red > blue * 2) return 'up';
  if (blue >= min && blue > red * 2) return 'down';
  return null;
}

// ---------- nature resolution ----------

const NATURE_NAMES = [
  'Adamant', 'Bashful', 'Bold', 'Brave', 'Calm', 'Careful', 'Docile', 'Gentle', 'Hardy', 'Hasty',
  'Impish', 'Jolly', 'Lax', 'Lonely', 'Mild', 'Modest', 'Naive', 'Naughty', 'Quiet', 'Quirky',
  'Rash', 'Relaxed', 'Sassy', 'Serious', 'Timid',
] as const;

/** plus/minus stat pair → nature name (via the data layer, not a hardcoded table). */
export function natureFor(plus: StatID | null, minus: StatID | null): string | null {
  if (!plus && !minus) return 'Serious';
  if (!plus || !minus || plus === minus) return null;
  for (const n of NATURE_NAMES) {
    const d = getNature(n) as { plus?: string; minus?: string } | undefined;
    if (d?.plus === plus && d?.minus === minus) return n;
  }
  return null;
}

const natureMods = (name: string): { plus: StatID | null; minus: StatID | null } => {
  const d = getNature(name) as { plus?: StatID; minus?: StatID } | undefined;
  return { plus: d?.plus ?? null, minus: d?.minus ?? null };
};

// ---------- stat math (L50, the Champions format level) ----------

/** Final stat from base/IV/EV/nature at the format level. */
export function computeStat(stat: StatID, base: number, iv: number, ev: number, nature: string, level = loadFormat().level): number {
  const core = Math.floor((2 * base + iv + Math.floor(ev / 4)) * level / 100);
  if (stat === 'hp') return core + level + 10;
  const { plus, minus } = natureMods(nature);
  const mod = plus === stat ? 1.1 : minus === stat ? 0.9 : 1;
  return Math.floor((core + 5) * mod);
}

// ---------- OCR readers ----------

export interface SummaryMovesCard { species: string | null; speciesRaw: string; ability: string | null; item: string | null; moves: string[]; }
export interface SummaryStatsCard { species: string | null; speciesRaw: string; stats: (number | null)[]; sp: (number | null)[]; arrows: ('up' | 'down' | null)[]; }

const digits = (s: string): number | null => { const m = s.replace(/[^0-9]/g, ''); return m ? parseInt(m, 10) : null; };

let itemNamesCache: string[] | null = null;
function legalItemNames(): string[] {
  if (!itemNamesCache) {
    itemNamesCache = listItems()
      .filter(id => isLegalItem(id))
      .map(id => (getItem(id) as { name?: string } | undefined)?.name ?? id);
  }
  return itemNamesCache;
}

/** Read the "Moves & More" page: per card species, ability, item, 4 moves. */
export async function readSummaryMoves(frame: Frame, ocr: OcrReader): Promise<SummaryMovesCard[]> {
  const out: SummaryMovesCard[] = [];
  for (let i = 0; i < 6; i++) {
    const speciesRaw = (await ocr.read(frame, nameRect(i), { psm: 7 })).trim();
    const spMatch = speciesRaw ? matchSpecies(speciesRaw) : null;
    const species = spMatch && spMatch.score >= 0.55 ? spMatch.value : null;

    let ability: string | null = null;
    const abilityRaw = (await ocr.read(frame, abilityRect(i), { psm: 7 })).trim();
    if (species && abilityRaw) {
      const slots = (getSpecies(species) as { abilities?: Record<string, string> } | undefined)?.abilities ?? {};
      const m = bestMatch(abilityRaw, Object.values(slots));
      if (m && m.score >= 0.5) ability = m.value;
    }

    let item: string | null = null;
    const itemRaw = (await ocr.read(frame, itemRect(i), { psm: 7 })).trim();
    if (itemRaw.replace(/[^a-z]/gi, '').length >= 3) {
      const m = bestMatch(itemRaw, legalItemNames());
      if (m && m.score >= 0.6) item = m.value;
    }

    const moves: string[] = [];
    if (species) {
      const learnset = getLearnset(species);
      for (let k = 0; k < 4; k++) {
        const raw = (await ocr.read(frame, moveRect(i, k), { psm: 7 })).trim();
        if (raw.replace(/[^a-z]/gi, '').length < 3) continue;      // empty move slot
        const m = bestMatch(raw, learnset);
        if (m && m.score >= 0.5 && !moves.includes(m.value)) moves.push(m.value);
      }
    }
    out.push({ species, speciesRaw, ability, item, moves });
  }
  return out;
}

/** Read the "Stats" page: per card the six final stats, six SP values, nature arrows. */
export async function readSummaryStats(frame: Frame, ocr: OcrReader): Promise<SummaryStatsCard[]> {
  const out: SummaryStatsCard[] = [];
  for (let i = 0; i < 6; i++) {
    const speciesRaw = (await ocr.read(frame, nameRect(i), { psm: 7 })).trim();
    const spMatch = speciesRaw ? matchSpecies(speciesRaw) : null;
    const stats: (number | null)[] = [], sp: (number | null)[] = [], arrows: ('up' | 'down' | null)[] = [];
    for (let s = 0; s < 6; s++) {
      const r = statRects(i, s);
      // PSM 7 (single line), not 8: the digit run next to the SP bar reads reliably as
      // a line; single-word mode returned "" / clipped digits on the same crops.
      stats.push(digits(await ocr.read(frame, r.value, { mode: 'digits', psm: 7 })));
      sp.push(digits(await ocr.read(frame, r.sp, { mode: 'digits', psm: 7 })));
      arrows.push(s === 0 ? null : detectArrow(cropRegion(frame, r.label)));   // HP never has an arrow
    }
    out.push({ species: spMatch && spMatch.score >= 0.55 ? spMatch.value : null, speciesRaw, stats, sp, arrows });
  }
  return out;
}

// ---------- assembly + verification ----------

export interface TeamSummaryResult { team: PokemonSet[]; warnings: string[]; }

/** Pair the two pages (by species, card-index fallback), resolve nature from the
 *  arrows, convert SP→EV, and VERIFY every stat by recomputation — auto-repairing
 *  IV0 and misread SP where the final stat pins them exactly. */
export function assembleTeamSummary(moves: SummaryMovesCard[], stats: SummaryStatsCard[]): TeamSummaryResult {
  const warnings: string[] = [];
  const team: PokemonSet[] = [];
  const level = loadFormat().level;

  for (let i = 0; i < 6; i++) {
    const mv = moves[i];
    if (!mv?.species) { warnings.push(`card ${i + 1}: species unreadable ("${mv?.speciesRaw ?? ''}") — slot skipped`); continue; }
    const species = mv.species;
    // Pair by species first — a stats card in the same position whose name disagrees
    // usually means one page's name OCR failed, so fall back to the index.
    let st = stats.find(s => s.species && toId(s.species) === toId(species));
    if (!st) { st = stats[i]; if (st?.species) warnings.push(`${species}: stats page card ${i + 1} reads "${st.species}" — paired by position`); }

    // Nature from the arrows (positions 1..5 = atk..spe). No arrows at all reads as a
    // neutral nature — but that's also what a detection FAILURE looks like, so a
    // no-arrow 'Serious' is only kept if the stat verification below agrees with it.
    let nature: string | null = null;
    let arrowsFound = false;
    if (st) {
      const upIdx = st.arrows.findIndex(a => a === 'up'), downIdx = st.arrows.findIndex(a => a === 'down');
      arrowsFound = upIdx >= 0 || downIdx >= 0;
      nature = natureFor(STAT_ORDER[upIdx] ?? null, STAT_ORDER[downIdx] ?? null);
      if (arrowsFound && !nature) warnings.push(`${species}: nature arrows unresolved (+${STAT_ORDER[upIdx] ?? '?'} -${STAT_ORDER[downIdx] ?? '?'})`);
    }

    const base = (getSpecies(species) as { baseStats?: Stats } | undefined)?.baseStats;
    const evs: Stats = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
    const ivs: Stats = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };

    if (st && base) {
      // Natures fully consistent with every readable (stat, SP) pair at IV31.
      const fits = NATURE_NAMES.filter(n =>
        STAT_ORDER.every((k, s) => st!.stats[s] == null || st!.sp[s] == null ||
          computeStat(k, base[k], 31, evFromSp(st!.sp[s]!), n, level) === st!.stats[s]));
      // A resolved arrow PAIR is strong evidence — keep it. Resolve from stats when
      // the arrows gave nothing, or when their no-arrow 'Serious' contradicts them.
      if (!nature || (!arrowsFound && fits.length && !fits.includes(nature as typeof NATURE_NAMES[number]))) {
        if (fits.length >= 1) {
          if (nature && !fits.includes(nature as typeof NATURE_NAMES[number])) warnings.push(`${species}: no arrows but stats reject ${nature} — took ${fits[0]}`);
          else if (fits.length > 1) warnings.push(`${species}: nature ambiguous (${fits.join('/')}) — took ${fits[0]}`);
          nature = fits[0]!;
        }
      }
      nature ??= 'Serious';

      STAT_ORDER.forEach((k, s) => {
        const readStat = st!.stats[s], readSp = st!.sp[s];
        let spVal = readSp;
        if (spVal == null || spVal > 32) {
          // SP unreadable → solve it from the final stat (unique in 0..32 when the stat read is good).
          const fits = readStat == null ? [] :
            Array.from({ length: 33 }, (_, v) => v).filter(v => computeStat(k, base[k], 31, evFromSp(v), nature!, level) === readStat);
          if (fits.length === 1) { spVal = fits[0]!; warnings.push(`${species} ${k}: SP unreadable — solved ${spVal} from stat ${readStat}`); }
          else { spVal = 0; warnings.push(`${species} ${k}: SP unreadable (stat ${readStat ?? '?'}) — defaulted 0`); }
        }
        evs[k] = evFromSp(spVal);
        if (readStat != null) {
          if (computeStat(k, base[k], 31, evs[k], nature!, level) === readStat) return;      // verified ✓
          if (computeStat(k, base[k], 0, evs[k], nature!, level) === readStat) { ivs[k] = 0; return; }  // tanked IV (Atk/Spe tricks)
          const fits = Array.from({ length: 33 }, (_, v) => v).filter(v => computeStat(k, base[k], 31, evFromSp(v), nature!, level) === readStat);
          if (fits.length === 1) { evs[k] = evFromSp(fits[0]!); warnings.push(`${species} ${k}: SP ${spVal} inconsistent with stat ${readStat} — corrected to ${fits[0]}`); return; }
          warnings.push(`${species} ${k}: stat ${readStat} does not match SP ${spVal} ${nature} (expected ${computeStat(k, base[k], 31, evs[k], nature!, level)})`);
        }
      });
    } else if (!st) warnings.push(`${species}: no stats card — EVs/nature defaulted`);

    if (!mv.ability) warnings.push(`${species}: ability unreadable`);
    if (mv.moves.length < 4) warnings.push(`${species}: only ${mv.moves.length}/4 moves read`);

    team.push({
      species, level,
      item: mv.item ?? undefined,
      ability: mv.ability ?? undefined,
      nature: nature ?? 'Serious',
      evs, ivs,
      moves: mv.moves,
    });
  }
  return { team, warnings };
}
