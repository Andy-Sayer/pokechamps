import { describe, test, expect } from 'vitest';
import { readFrame } from '../src/visionSource.js';
import { CHAMPIONS_DOUBLES_PLACEHOLDER } from '../src/regions.js';
import type { Frame, Rect } from '../src/types.js';
import type { OcrReader, OcrOptions } from '../src/ocr.js';

const frame: Frame = { width: 1920, height: 1080, data: new Uint8ClampedArray(1920 * 1080 * 4), ts: 7 };

// Fake OCR keyed on the digit PSM the reader passes: opp uses PSM 8, mine PSM 7.
class FakeHpOcr implements OcrReader {
  async read(_f: Frame, _r: Rect, opts: OcrOptions = {}): Promise<string> {
    if (opts.mode !== 'digits') return '';            // names/banner — irrelevant here
    return opts.psm === 7 ? '117/175' : '52%';        // mine cur/max ; opp percent
  }
}

describe('readFrame — HP from the nameplate number', () => {
  test('prefers the digit read over the bar; maps opp%→fraction, mine cur/max→fraction', async () => {
    const fr = await readFrame(frame, { grabber: null as never, ocr: new FakeHpOcr(), regions: CHAMPIONS_DOUBLES_PLACEHOLDER });
    for (const s of fr.slots) {
      if (s.side === 'opp') expect(s.hpFraction).toBeCloseTo(0.52, 5);
      else expect(s.hpFraction).toBeCloseTo(117 / 175, 5);
    }
    expect(fr.ts).toBe(7);
  });

  test('falls back to the bar when the number is unreadable', async () => {
    const blank: OcrReader = { async read() { return ''; } };
    const fr = await readFrame(frame, { grabber: null as never, ocr: blank, regions: CHAMPIONS_DOUBLES_PLACEHOLDER });
    // all-zero frame → bar fraction is 0 (not the number), i.e. the digit path didn't win
    for (const s of fr.slots) expect(s.hpFraction === null || s.hpFraction === 0).toBe(true);
  });
});
