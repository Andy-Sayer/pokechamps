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

// Champions doubles battle layout (command/FIGHT phase). Normalized [0,1].
// CALIBRATED on a real 1080p dongle match (command-live.png, 2026-06-20):
//   VERIFIED: battleText banner; both opp HP-% boxes; both my absolute-HP boxes.
//   MEASURED (good, refine later): per-slot name + hpBar boxes. HP CONVENTION — opp
//     shows a PERCENT ("100%", read via oppHpText), mine an ABSOLUTE "cur/max" (read
//     via myHpText); pixel hpBar is the cross-check. Layout: opp plates TOP-RIGHT,
//     mine BOTTOM-LEFT. statusIcon + moveMenu still TODO. Opp species ICON for
//     appearance-match lives in the nameplate (~slot0 x0.62 w0.043 / slot1 x0.85
//     w0.037, y0.035 h0.069) — see colorHist.
const TODO: Rect = { x: 0, y: 0, w: 0, h: 0 };

export const CHAMPIONS_DOUBLES_PLACEHOLDER: RegionMap = {
  label: 'champions-doubles (calibrated 2026-06-20 dongle)',
  // CALIBRATED on the 2026-06-20 live dongle match (find-banner.ts over seq frames):
  // banner is white, LEFT-anchored at x≈304px (0.158), text rows ≈808..836px (peak
  // y815), right edge grows with length to ≈1418px on the longest lines. Box tightened
  // to the text band so animation flashes / empty strip don't trip the OCR gate.
  battleText: { x: 0.150, y: 0.739, w: 0.630, h: 0.040 },  // px x288 y798 w1210 h43
  moveMenu: [TODO, TODO, TODO, TODO],                     // 4 move slots when choosing
  // CALIBRATED on command-live.png (2026-06-20 dongle match): opp plates cluster
  // TOP-RIGHT (slot0 left of slot1), mine BOTTOM-LEFT (slot0 left of slot1). name =
  // species text box; hpBar = the green→red fill bar (readHpFraction) — its right
  // (100%) extent is approximate until refined against a damaged bar.
  slots: [
    { side: 'opp',  index: 0, name: { x: 0.599, y: 0.046, w: 0.156, h: 0.037 }, hpBar: { x: 0.652, y: 0.096, w: 0.124, h: 0.0185 }, statusIcon: TODO },
    { side: 'opp',  index: 1, name: { x: 0.810, y: 0.046, w: 0.156, h: 0.037 }, hpBar: { x: 0.860, y: 0.100, w: 0.124, h: 0.0185 }, statusIcon: TODO },
    { side: 'mine', index: 0, name: { x: 0.078, y: 0.869, w: 0.146, h: 0.037 }, hpBar: { x: 0.090, y: 0.921, w: 0.160, h: 0.0185 }, statusIcon: TODO },
    { side: 'mine', index: 1, name: { x: 0.287, y: 0.866, w: 0.146, h: 0.037 }, hpBar: { x: 0.301, y: 0.919, w: 0.160, h: 0.0185 }, statusIcon: TODO },
  ],
  // Opponent HP-% readouts (white digits over the bar) — VERIFIED on command-live.png:
  // both read a clean "100%", o2 shifted left so its leading "1" is no longer clipped.
  oppHpText: [
    { x: 0.6865, y: 0.1167, w: 0.0781, h: 0.0370 },  // o1 — px x1318 y126 w150 h40
    { x: 0.8922, y: 0.1185, w: 0.0807, h: 0.0370 },  // o2 — px x1713 y128 w155 h40
  ],
  // My HP readouts — ABSOLUTE "cur/max" digits on the bottom plates — VERIFIED
  // ("155/155" and "194/207" read clean).
  myHpText: [
    { x: 0.1172, y: 0.9380, w: 0.1120, h: 0.0444 },  // m1 — px x225 y1013 w215 h48
    { x: 0.3359, y: 0.9380, w: 0.1172, h: 0.0444 },  // m2 — px x645 y1013 w225 h48
  ],
};
