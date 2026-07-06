// Read the PLAYER's bring off the team-select ("Select N Pokémon") screen, so the app can
// populate the 4 brought mons with zero typing (kills the mistype class of bug). Key idea:
// the player's team is already KNOWN (loaded), and the left column shows the six in fixed
// TEAM ORDER — so we only need to detect WHICH POSITIONS are selected (badged), then map
// index→known species. No sprite ID needed.
//
// Signals on the screen:
//   - each selected card gets a NUMBER BADGE (1..4) overlaid (calibration: badgeBox below)
//   - the "N/4 · Done" counter (bottom-left) = how many are selected (cross-check)
// Layout-aware via the shared `ins` (GameShare inset), like the sprite/type reads.
import { playerSpriteBoxes, type ScreenInset } from './regions.js';
import type { Frame } from './types.js';

/** Per-card SELECTION-BADGE box, relative to the card sprite box. The numbered badge sits
 *  in a corner of the card. CALIBRATE against a real selected frame (see markerScore). */
function badgeBox(card: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
  // Placeholder: top-left corner of the card, ~40% of the card. Tighten with a selected frame.
  return { x: card.x - Math.round(card.w * 0.15), y: card.y - Math.round(card.h * 0.05), w: Math.round(card.w * 0.5), h: Math.round(card.h * 0.5) };
}

/** How "selected" a card looks: fraction of its badge box that is a bright, non-card-blue
 *  marker (the numbered badge is a bright overlay on the blue card). CALIBRATE the threshold
 *  + colour against a real selected frame. */
function markerScore(frame: Frame, box: { x: number; y: number; w: number; h: number }): number {
  const { width, data } = frame;
  let hit = 0, tot = 0;
  for (let y = Math.max(0, box.y); y < box.y + box.h && y < frame.height; y++) {
    for (let x = Math.max(0, box.x); x < box.x + box.w && x < width; x++) {
      const o = (y * width + x) * 4; const r = data[o]!, g = data[o + 1]!, b = data[o + 2]!;
      tot++;
      // Bright + not the blue-purple card bg [68,53,197] → likely a badge overlay.
      if (Math.min(r, g, b) > 150) hit++;
    }
  }
  return tot ? hit / tot : 0;
}

export interface BringSelection {
  selected: number[];   // 0-based indices of selected cards, in card order (top→bottom)
  markerScores: number[]; // per-card marker score (for calibration/debug)
}

/** Detect which of the six player cards are selected. `threshold` is the marker-score cut;
 *  calibrate against a frame with a known selection. Pass GAMESHARE inset for a screen-share. */
export function readBringSelection(frame: Frame, opts: { ins?: ScreenInset; threshold?: number } = {}): BringSelection {
  const { ins, threshold = 0.15 } = opts;
  const cards = playerSpriteBoxes(frame.width, frame.height, ins);   // inset-aware card boxes
  const markerScores = cards.map(card => markerScore(frame, badgeBox(card)));
  const selected = markerScores.map((s, i) => [s, i] as const).filter(([s]) => s >= threshold).map(([, i]) => i);
  return { selected, markerScores };
}
