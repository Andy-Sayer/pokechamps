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

/** Champions PLAYER-card background (blue-purple). The streamer's own six sit on this
 *  card (left column) with their NAMES printed — so player-side refs are auto-labelled
 *  (zero-guess) and fill gaps the opponent side is slow to surface. Mask this out the
 *  same way we mask the opp panel, so a player-built ref (blue bg removed) still matches
 *  an opponent query (magenta bg removed): both reduce to creature-only histograms. */
export const CHAMPIONS_PLAYER_CARD_BG: readonly [number, number, number] = [68, 53, 197];

/** The bright-green highlight drawn on the CURRENTLY-SELECTED player card (the focused
 *  row is green, not blue). Mask this as a 2nd bg so a highlighted row's ref isn't
 *  poisoned with green. Measured on a CybertronVGC preview (row0 selected ≈ 183,253,7). */
export const CHAMPIONS_PLAYER_HIGHLIGHT_BG: readonly [number, number, number] = [185, 251, 30];

/** Player-side sprite crop boxes (the streamer's team, right end of each name-card).
 *  CALIBRATED on a fullscreen 1080p CybertronVGC preview (frame_00234): sprite sits at
 *  x≈495px, box ≈105×100px, card centres 120px apart (y_top = 0.167 + i·0.111 verified
 *  against Grimmsnarl row1 + Eelektross row4). Facecam covers only x<0.16, so all six
 *  right-column sprites are clear. */
export function playerSpriteBoxes(width: number, height: number) {
  return Array.from({ length: 6 }, (_, i) =>
    toPixels({ x: 0.258, y: 0.167 + i * 0.111, w: 0.055, h: 0.093 }, width, height));
}

/** The centre "Select 4 Pokémon / to send into battle." text — present ONLY on the
 *  team-preview screen. OCR this (white text) to locate previews in a VOD frame dump,
 *  so harvest doesn't hunt them by timestamp. Generous box tolerates per-source shift. */
export const TEAM_PREVIEW_TEXT: Rect = { x: 0.33, y: 0.18, w: 0.25, h: 0.14 };

/** Opponent sprite crop boxes (integer px) for a frame of the given size. */
export function opponentSpriteBoxes(width: number, height: number) {
  return CHAMPIONS_TEAM_PREVIEW.oppTeam.map((s) => toPixels(s.sprite, width, height));
}

/** The two type-icon boxes for each opponent card (top-right of the card, measured on
 *  a 1080p frame). Colour-hist match these vs a fixed 18-icon ref set to get the type
 *  combo → dossier species shortlist. [slot][0|1] top→bottom. */
export function typeIconBoxes(width: number, height: number): { a: ReturnType<typeof toPixels>; b: ReturnType<typeof toPixels> }[] {
  return Array.from({ length: 6 }, (_, i) => {
    const y = 158 / 1080 + i * 0.1167;
    return {
      a: toPixels({ x: 1784 / 1920, y, w: 48 / 1920, h: 48 / 1080 }, width, height),
      b: toPixels({ x: 1834 / 1920, y, w: 48 / 1920, h: 48 / 1080 }, width, height),
    };
  });
}

/** Resolve a normalized Rect to integer pixel bounds for a given frame size. */
export function toPixels(r: Rect, width: number, height: number): { x: number; y: number; w: number; h: number } {
  return { x: Math.round(r.x * width), y: Math.round(r.y * height), w: Math.round(r.w * width), h: Math.round(r.h * height) };
}

/** A shared-screen inset (e.g. Switch 2 GameShare): the shared game is shrunk by
 *  `scale` and offset to (x, y), all NORMALIZED to the capture frame. */
export interface ScreenInset { x: number; y: number; scale: number }

/** MEASURED 2026-06-28 on a live GameShare dongle frame (scripts/share-border.ts):
 *  the shared screen is an exact 5/6 (0.8333) CENTRED inset of the 1920×1080
 *  capture — a 1600×900 region with symmetric 160px L/R + 90px T/B borders. */
export const GAMESHARE_INSET: ScreenInset = { x: 160 / 1920, y: 90 / 1080, scale: 5 / 6 };

const insetRect = (r: Rect, ins: ScreenInset): Rect => ({
  x: ins.x + r.x * ins.scale, y: ins.y + r.y * ins.scale, w: r.w * ins.scale, h: r.h * ins.scale,
});

/** Remap a full-frame RegionMap into a shrunk inset (GameShare). Every box is
 *  scaled + offset by the inset, so the SAME calibration drives a GameShare feed
 *  with no re-measuring — just `insetRegionMap(map)` when the share is detected. */
export function insetRegionMap(map: RegionMap, ins: ScreenInset = GAMESHARE_INSET): RegionMap {
  const R = (r: Rect) => insetRect(r, ins);
  return {
    label: `${map.label} [gameshare ${ins.scale.toFixed(3)}@${(ins.x * 100).toFixed(1)},${(ins.y * 100).toFixed(1)}%]`,
    battleText: R(map.battleText),
    moveMenu: map.moveMenu.map(R) as [Rect, Rect, Rect, Rect],
    slots: map.slots.map(s => ({ ...s, name: R(s.name), hpBar: R(s.hpBar), statusIcon: R(s.statusIcon) })),
    oppHpText: map.oppHpText ? [R(map.oppHpText[0]), R(map.oppHpText[1])] : undefined,
    myHpText: map.myHpText ? [R(map.myHpText[0]), R(map.myHpText[1])] : undefined,
  };
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
