import type { Frame, Rect } from './types.js';

/** Reads text from a frame region. Deterministic OCR is the primary path; an
 *  LLM-vision fallback stays opt-in / default-off (matches the project's AI
 *  posture — no LLM in the hot loop). */
export interface OcrReader {
  read(frame: Frame, region: Rect): Promise<string>;
}

/** No-op OCR for wiring the pipeline before the real engine is in. */
export class StubOcrReader implements OcrReader {
  async read(): Promise<string> { return ''; }
}

// TODO(ocr): TesseractOcrReader — lazy-import `tesseract.js` (the chosen in-stack
// engine) so the dep loads only when OCR is actually used. Crop `region`
// (normalized → pixels), upscale + binarize for the pixel font, then recognize.
// Tune page-seg mode + a per-region char whitelist (digits for HP numbers, the
// name font for labels) on real Champions screenshots — accuracy lives in that
// tuning, which needs captured frames.
