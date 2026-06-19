import type { RegionMap, Rect, TeamPreviewRegions } from './types.js';

const rect = (x: number, w: number, y: number, h: number): Rect => ({ x, y, w, h });

// CALIBRATED from YouTube clips of a real Reg M-B match (two 16:9 captures — the
// game area at 1175×662 for the left panel, the user's 1422×800 grab for the
// opponent panel; both 16:9, so normalized coords are comparable).
//   VALIDATED: left name column + the top 3 rows read correctly via OCR; the
//     opponent panel was located on the right edge and its 6 sprites identified
//     (Azumarill / Staraptor / Arcanine / Florges / Sylveon / Gholdengo).
//   ESTIMATED: exact per-row y for the lower rows + item offsets — the LAYOUT is
//     right; the pixels get nudged against real dongle footage (game fills the
//     frame cleanly, no browser chrome). The earlier bug was cropping the game at
//     width 1175 and clipping the opponent panel, which lives at x≈0.83–1.0.
export const CHAMPIONS_TEAM_PREVIEW: TeamPreviewRegions = {
  label: 'champions-team-preview (youtube-calibrated — refine on dongle)',
  myTeam: Array.from({ length: 6 }, (_, i) => {
    const y = 0.322 + i * 0.131;                                   // name top, ~0.131 row spacing
    return { name: rect(0.070, 0.163, y, 0.045), item: rect(0.085, 0.150, y + 0.066, 0.038) };
  }),
  oppTeam: Array.from({ length: 6 }, (_, i) => ({
    sprite: rect(0.833, 0.060, 0.137 + i * 0.1375, 0.105),         // right-edge sprite, ~0.1375 spacing
  })),
  oppName: rect(0.830, 0.150, 0.100, 0.050),
};

/** Resolve a normalized Rect to integer pixel bounds for a given frame size. */
export function toPixels(r: Rect, width: number, height: number): { x: number; y: number; w: number; h: number } {
  return { x: Math.round(r.x * width), y: Math.round(r.y * height), w: Math.round(r.w * width), h: Math.round(r.h * height) };
}

// PLACEHOLDER layout for a Champions doubles battle. Coordinates are normalized
// [0,1] and are GUESSES for shape only — CALIBRATE against a real screenshot:
// drop a 1080p capture in fixtures/, measure each box, and replace these numbers.
// The structure (which regions exist) is final; the values are the switch-day work.
const TODO: Rect = { x: 0, y: 0, w: 0, h: 0 };

export const CHAMPIONS_DOUBLES_PLACEHOLDER: RegionMap = {
  label: 'champions-doubles-PLACEHOLDER',
  battleText: { x: 0.08, y: 0.80, w: 0.84, h: 0.16 },     // bottom log box (rough)
  moveMenu: [TODO, TODO, TODO, TODO],                     // 4 move slots when choosing
  slots: [
    // Opponent mons usually top, mine bottom — rough guesses, calibrate.
    { side: 'opp',  index: 0, name: { x: 0.55, y: 0.10, w: 0.30, h: 0.05 }, hpBar: { x: 0.55, y: 0.16, w: 0.30, h: 0.02 }, statusIcon: TODO },
    { side: 'opp',  index: 1, name: { x: 0.15, y: 0.22, w: 0.30, h: 0.05 }, hpBar: { x: 0.15, y: 0.28, w: 0.30, h: 0.02 }, statusIcon: TODO },
    { side: 'mine', index: 0, name: { x: 0.10, y: 0.58, w: 0.30, h: 0.05 }, hpBar: { x: 0.10, y: 0.64, w: 0.30, h: 0.02 }, statusIcon: TODO },
    { side: 'mine', index: 1, name: { x: 0.55, y: 0.66, w: 0.30, h: 0.05 }, hpBar: { x: 0.55, y: 0.72, w: 0.30, h: 0.02 }, statusIcon: TODO },
  ],
};
