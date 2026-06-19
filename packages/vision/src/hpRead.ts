// Read the opponent's HP as a PERCENT from the nameplate number (e.g. "100%").
// The opp readout is the key inference signal — the solver back-solves spreads from
// how much our moves take off it. We OCR the digits rather than measure the bar fill
// because the bar carries an overlaid number and a parallelogram skew; the digit is
// the game's own exact value.
//
// The catch: the white digits sit on a BRIGHT coloured HP bar, so a plain brightness
// threshold merges them. They ARE distinguishable by being WHITE (all channels high)
// vs the saturated bar — so we isolate "min(r,g,b) high" before OCR. Verified on a
// real frame: slot-A read "100" with a digit whitelist.
//
// Pure primitives here (binarize + parse) are unit-tested; the async reader takes an
// injected `ocrDigits` so it's testable without the tesseract model. My-side HP shows
// as an ABSOLUTE number (needs the mon's max HP to get a %) — deferred; opp % first.

import type { Frame, Rect, RegionMap, SlotRef } from './types.js';
import { toPixels } from './regions.js';

/** RGBA → binary (white digits → black on white) by isolating near-white pixels. */
export function binarizeWhiteDigits(
  pixels: Uint8ClampedArray | number[], width: number, height: number, threshold = 160,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    const isWhite = Math.min(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) > threshold;
    const v = isWhite ? 0 : 255;                 // digits black, everything else white
    out[i] = out[i + 1] = out[i + 2] = v; out[i + 3] = 255;
  }
  return out;
}

/** Parse an OCR'd HP readout to an integer (digits only). "100%"→100, "82"→82, ""→null. */
export function parseHpNumber(text: string): number | null {
  const digits = text.replace(/[^0-9]/g, '');
  if (!digits) return null;
  return parseInt(digits, 10);
}

const clampPct = (n: number) => Math.max(0, Math.min(100, n));

/** Crop a normalized rect out of a Frame as a tight RGBA buffer. */
function crop(frame: Frame, r: Rect): { pixels: Uint8ClampedArray; w: number; h: number } {
  const { x, y, w, h } = toPixels(r, frame.width, frame.height);
  const x0 = Math.max(0, x), y0 = Math.max(0, y);
  const x1 = Math.min(frame.width, x + w), y1 = Math.min(frame.height, y + h);
  const cw = Math.max(0, x1 - x0), ch = Math.max(0, y1 - y0);
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let ry = 0; ry < ch; ry++)
    for (let rx = 0; rx < cw; rx++) {
      const s = ((y0 + ry) * frame.width + (x0 + rx)) * 4, d = (ry * cw + rx) * 4;
      out[d] = frame.data[s]!; out[d + 1] = frame.data[s + 1]!; out[d + 2] = frame.data[s + 2]!; out[d + 3] = 255;
    }
  return { pixels: out, w: cw, h: ch };
}

/** OCR the digits of an isolated HP crop. Injected so the reader is model-free testable. */
export type DigitOcr = (pixels: Uint8ClampedArray, width: number, height: number) => Promise<string>;

/** Read the two opponent HP percents from a settled frame, via the RegionMap's
 *  `oppHpText` boxes → white-isolate → OCR → clamp 0..100. Slots map left→o1, right→o2. */
export async function readOpponentHpPercents(
  frame: Frame, ocrDigits: DigitOcr, region: RegionMap,
): Promise<Partial<Record<SlotRef, number>>> {
  const boxes = region.oppHpText;
  if (!boxes) return {};
  const out: Partial<Record<SlotRef, number>> = {};
  const refs: SlotRef[] = ['o1', 'o2'];
  for (let i = 0; i < boxes.length && i < 2; i++) {
    const c = crop(frame, boxes[i]!);
    if (!c.w || !c.h) continue;
    const text = await ocrDigits(binarizeWhiteDigits(c.pixels, c.w, c.h), c.w, c.h);
    const n = parseHpNumber(text);
    if (n != null) out[refs[i]!] = clampPct(n);
  }
  return out;
}
