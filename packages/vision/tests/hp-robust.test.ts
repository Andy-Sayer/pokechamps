// readAbsHpRobust: my "cur/max" HP digits garble at small (GameShare-inset)
// scales and the best OCR upscale varies per frame, so we sweep a few scales and
// accept the first SANE parse (cur ≤ max, max in a plausible L50 range). These
// pin the real failures observed on a live frame (Espathra "202/202" only read at
// ×5, Maushold "181/181" only at ×4; other scales dropped the slash or split digits).
import { describe, test, expect } from 'vitest';
import { readAbsHpRobust } from '../src/visionSource.js';
import type { Frame, Rect } from '../src/types.js';

const frame = { ts: 0, width: 10, height: 10, data: new Uint8ClampedArray(400) } as Frame;
const region: Rect = { x: 0, y: 0, w: 1, h: 1 };
// A mock OCR returning a different string per upscale.
const ocrByScale = (byScale: Record<number, string>) =>
  ({ read: async (_f: Frame, _r: Rect, o?: { scale?: number }) => byScale[o?.scale ?? 3] ?? '' });

describe('readAbsHpRobust (multi-scale my-HP)', () => {
  test('skips a garbled scale (dropped slash → null) and accepts the next sane parse', async () => {
    const ocr = ocrByScale({ 4: '202202', 5: '202/202', 3: '' });
    expect(await readAbsHpRobust(ocr, frame, region)).toEqual({ cur: 202, max: 202 });
  });

  test('takes the first scale that parses sane', async () => {
    const ocr = ocrByScale({ 4: '181/181', 5: '1871/1571', 3: '' });
    expect(await readAbsHpRobust(ocr, frame, region)).toEqual({ cur: 181, max: 181 });
  });

  test('rejects cur > max and implausible max, keeps scanning', async () => {
    const ocr = ocrByScale({ 4: '1871/1381', 5: '9999/9999', 3: '50/50' });
    expect(await readAbsHpRobust(ocr, frame, region)).toEqual({ cur: 50, max: 50 });
  });

  test('null when every scale garbles (→ bar fallback)', async () => {
    const ocr = ocrByScale({ 4: 'xx', 5: '202202', 3: '' });
    expect(await readAbsHpRobust(ocr, frame, region)).toBeNull();
  });
});
