import type { RegionMap, Rect } from './types.js';

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
