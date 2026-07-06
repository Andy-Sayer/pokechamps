// Type-icon reader: classify each opponent card's type-colour square(s) → a type combo.
// The 18 type icons are flat, saturated colour squares (white glyph on a type-colour
// fill), so we sample the FILL colour (excluding the white glyph + magenta card bg) and
// nearest-match it to a fixed 18-colour palette. Far more tractable than 208 sprites, and
// the combo narrows the opponent to a handful via the dossier (see bringRecommend).
//
// Palette HARVESTED from the live game 2026-07-05 (team-builder type-display + move icons,
// self-labelled by type name / move type — scripts/_type-anchors.ts). All 18 measured; the
// clean saturated move-icon value is used over the glyph-washed type-display value (Dragon,
// Flying, Dark, Fairy). Layout-aware via the shared `ins` (GameShare inset), like sprites.
import { typeIconBoxes, type ScreenInset } from './regions.js';
import type { Frame } from './types.js';

export type PkType =
  | 'Normal' | 'Fire' | 'Water' | 'Electric' | 'Grass' | 'Ice' | 'Fighting' | 'Poison'
  | 'Ground' | 'Flying' | 'Psychic' | 'Bug' | 'Rock' | 'Ghost' | 'Dragon' | 'Dark' | 'Steel' | 'Fairy';

export const TYPE_COLORS: Record<PkType, readonly [number, number, number]> = {
  Normal: [154, 157, 154], Fire: [220, 38, 34], Water: [34, 125, 233], Electric: [242, 190, 0],
  Grass: [59, 157, 37], Ice: [58, 211, 247], Fighting: [247, 126, 0], Poison: [138, 62, 197],
  Ground: [138, 77, 27], Flying: [124, 181, 233], Psychic: [235, 61, 112], Bug: [139, 158, 19],
  Rock: [171, 166, 123], Ghost: [105, 61, 105], Dragon: [75, 94, 216], Dark: [75, 61, 60],
  Steel: [93, 157, 179], Fairy: [233, 110, 235],
};

const CARD: [number, number, number] = [131, 6, 55];   // opponent-panel magenta
const near = (a: readonly number[], b: readonly number[], t: number) =>
  Math.abs(a[0]! - b[0]!) < t && Math.abs(a[1]! - b[1]!) < t && Math.abs(a[2]! - b[2]!) < t;
const sat = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b);

/** Median FILL colour of an icon box (excludes white glyph, dark, and magenta card bg).
 *  Returns null when too little fill is present (an empty box = single-type / no icon). */
function sampleFill(frame: Frame, box: { x: number; y: number; w: number; h: number }): [number, number, number] | null {
  const { width, data } = frame;
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const o = (y * width + x) * 4; const r = data[o]!, g = data[o + 1]!, b = data[o + 2]!;
      const white = r > 200 && g > 200 && b > 200;                 // the type glyph
      const black = Math.max(r, g, b) < 28;                        // gaps
      // Keep the type-colour fill — INCLUDING low-saturation greys (Dark/Steel/Normal/Rock).
      // Only drop glyph white, black gaps, and the magenta card background.
      if (white || black || near([r, g, b], CARD, 45)) continue;
      rs.push(r); gs.push(g); bs.push(b);
    }
  }
  // A real icon square fills most of the box; a stray-pixel (empty) box does not.
  if (rs.length < box.w * box.h * 0.30) return null;
  const med = (a: number[]) => a.sort((p, q) => p - q)[Math.floor(a.length / 2)]!;
  return [med(rs), med(gs), med(bs)];
}

/** Max colour distance for a box to count as a real type icon (vs sprite-edge bleed). */
const MAX_TYPE_DIST = 55;

const d2 = (a: readonly number[], b: readonly number[]) => (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2;

/** Nearest type by colour + its distance (lower = better; ~<70 is a confident match). */
export function classifyTypeColor(rgb: readonly [number, number, number]): { type: PkType; dist: number } {
  let best: PkType = 'Normal', bd = Infinity;
  for (const t of Object.keys(TYPE_COLORS) as PkType[]) { const d = Math.sqrt(d2(rgb, TYPE_COLORS[t])); if (d < bd) { bd = d; best = t; } }
  return { type: best, dist: bd };
}

export interface SlotTypes { types: PkType[]; dists: number[] }   // left→right (canonical); [] if no icon

/** Read all six opponent cards' type combos, each as its types in left→right (canonical)
 *  order: box `a` (left) = first type of a dual; box `b` (right) = the single/last type.
 *  An empty box (single-type mon's left slot) yields no type. Pass GAMESHARE inset for a
 *  screen-share. */
export function readTypeIcons(frame: Frame, ins?: ScreenInset): SlotTypes[] {
  return typeIconBoxes(frame.width, frame.height, ins).map(({ a, b }) => {
    const types: PkType[] = [], dists: number[] = [];
    for (const box of [a, b]) {          // a=left (dual's 1st type) then b=right (single/last)
      const f = sampleFill(frame, box);
      if (!f) continue;
      const c = classifyTypeColor(f);
      // A real type icon lands near an anchor (verified d≤33); a sprite-edge/shadow bleeding
      // into an empty box lands far (d≈88). Cut off between → single types stay single.
      if (c.dist > MAX_TYPE_DIST) continue;
      types.push(c.type); dists.push(Math.round(c.dist));
    }
    return { types, dists };
  });
}
