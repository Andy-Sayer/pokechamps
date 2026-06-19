import type { RegionMap, Rect, TeamPreviewRegions } from './types.js';

const rect = (x: number, w: number, y: number, h: number): Rect => ({ x, y, w, h });

// CALIBRATED on a real Reg M-B match captured FULLSCREEN at 1920×1080 (game fills
// the frame, no browser chrome — same shape the HDMI dongle will hand us, so these
// normalized coords transfer directly).
//   VERIFIED (oppTeam): the six opponent sprites sit at frame x≈1593..1719, card
//     centres y≈211,337,464,590,716,842 (spacing 126px). Colour-histogram matching
//     the six (Azumarill/Staraptor/Arcanine/Florges/Sylveon/Gholdengo — see
//     colorHist.ts) scored 54/54 under ±8px jitter and 6/6 cross-frame.
//   ESTIMATED (myTeam): card-1 name/item measured directly; lower rows extrapolated
//     at the same 0.1167 spacing — refine the OCR boxes against a clean dongle frame.
export const CHAMPIONS_TEAM_PREVIEW: TeamPreviewRegions = {
  label: 'champions-team-preview (fullscreen 1080p — oppTeam verified)',
  myTeam: Array.from({ length: 6 }, (_, i) => {
    const y = 0.171 + i * 0.1167;                                  // name top; fullscreen card spacing
    return { name: rect(0.065, 0.185, y, 0.037), item: rect(0.082, 0.150, y + 0.045, 0.033) };
  }),
  oppTeam: Array.from({ length: 6 }, (_, i) => ({
    sprite: rect(0.8297, 0.0656, 0.1417 + i * 0.1167, 0.1074),     // verified sprite box
  })),
  oppName: rect(0.800, 0.170, 0.105, 0.040),
};

/** Champions opponent-panel background (dark magenta). Mask this out before
 *  colour-histogram matching the opponent sprites (the sprite sits on this panel). */
export const CHAMPIONS_OPP_PANEL_BG: readonly [number, number, number] = [131, 6, 55];

/** Opponent sprite crop boxes (integer px) for a frame of the given size. */
export function opponentSpriteBoxes(width: number, height: number) {
  return CHAMPIONS_TEAM_PREVIEW.oppTeam.map((s) => toPixels(s.sprite, width, height));
}

/** Resolve a normalized Rect to integer pixel bounds for a given frame size. */
export function toPixels(r: Rect, width: number, height: number): { x: number; y: number; w: number; h: number } {
  return { x: Math.round(r.x * width), y: Math.round(r.y * height), w: Math.round(r.w * width), h: Math.round(r.h * height) };
}

// Champions doubles battle layout. Normalized [0,1]. PARTIALLY CALIBRATED on a
// real 1080p match:
//   VERIFIED: battleText — the bottom message banner ("X used Y!", "X has Mega
//     Evolved into Mega X!", etc.); OCR'd at conf 94 (white text, left-aligned).
//   TODO: per-slot name/hpBar boxes still measured roughly — opp nameplates are
//     top-right, mine bottom-left. HP CONVENTION: the opponent's HP shows as a
//     PERCENT number on the nameplate ("100%"); mine shows as an ABSOLUTE number
//     ("162"). So damage is read by OCR'ing the per-slot HP delta (pixel hpBar is a
//     cross-check). Opp species ICON for appearance-match lives in the nameplate
//     (~slot0 x0.62 w0.043 / slot1 x0.85 w0.037, y0.035 h0.069) — see colorHist.
const TODO: Rect = { x: 0, y: 0, w: 0, h: 0 };

export const CHAMPIONS_DOUBLES_PLACEHOLDER: RegionMap = {
  label: 'champions-doubles (battleText verified; slots rough)',
  battleText: { x: 0.140, y: 0.737, w: 0.600, h: 0.055 },  // VERIFIED bottom banner
  moveMenu: [TODO, TODO, TODO, TODO],                     // 4 move slots when choosing
  slots: [
    // Opponent mons usually top, mine bottom — rough guesses, calibrate.
    { side: 'opp',  index: 0, name: { x: 0.55, y: 0.10, w: 0.30, h: 0.05 }, hpBar: { x: 0.55, y: 0.16, w: 0.30, h: 0.02 }, statusIcon: TODO },
    { side: 'opp',  index: 1, name: { x: 0.15, y: 0.22, w: 0.30, h: 0.05 }, hpBar: { x: 0.15, y: 0.28, w: 0.30, h: 0.02 }, statusIcon: TODO },
    { side: 'mine', index: 0, name: { x: 0.10, y: 0.58, w: 0.30, h: 0.05 }, hpBar: { x: 0.10, y: 0.64, w: 0.30, h: 0.02 }, statusIcon: TODO },
    { side: 'mine', index: 1, name: { x: 0.55, y: 0.66, w: 0.30, h: 0.05 }, hpBar: { x: 0.55, y: 0.72, w: 0.30, h: 0.02 }, statusIcon: TODO },
  ],
};
