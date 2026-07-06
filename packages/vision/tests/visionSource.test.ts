import { describe, test, expect } from 'vitest';
import { readFrame, runVision } from '../src/visionSource.js';
import { StaticFrameGrabber } from '../src/frameGrabber.js';
import { CHAMPIONS_DOUBLES_PLACEHOLDER } from '../src/regions.js';
import type { Frame, Rect } from '../src/types.js';
import type { OcrReader, OcrOptions } from '../src/ocr.js';

const frame: Frame = { width: 1920, height: 1080, data: new Uint8ClampedArray(1920 * 1080 * 4), ts: 7 };

// Fake OCR keyed on the digit PSM the reader passes: opp uses PSM 8, mine PSM 7.
// The name read (non-digits) returns a species — a real command/nameplate frame always
// shows the name, which is the nameplate-PRESENCE signal HP now gates on (no name = no
// plate = cinematic → null HP). Without it the HP would (correctly) be gated to null.
class FakeHpOcr implements OcrReader {
  async read(_f: Frame, _r: Rect, opts: OcrOptions = {}): Promise<string> {
    if (opts.mode !== 'digits') return 'Pikachu';     // nameplate name present
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

// The FREEZE fix. tesseract.js #325: a failed recognize hangs the worker forever, so every
// subsequent read hangs → the whole live loop wedges with NO error. runVision must time out the
// frame, reset the OCR, and keep rolling. This proves that recovery deterministically.
class RecoverableHangOcr implements OcrReader {
  hangUntilReset = false;
  resets = 0;
  async read(): Promise<string> {
    if (this.hangUntilReset) return new Promise<string>(() => { /* never resolves — the wedged worker */ });
    return 'Pikachu';
  }
  async reset(): Promise<void> { this.resets++; this.hangUntilReset = false; }
}

describe('runVision — self-heals a hung OCR worker', () => {
  test('times out the wedged frame, resets the worker, and keeps processing later frames', async () => {
    const frames: Frame[] = Array.from({ length: 12 }, (_, i) => ({ width: 1920, height: 1080, data: new Uint8ClampedArray(1920 * 1080 * 4), ts: i }));
    const ocr = new RecoverableHangOcr();
    const processed: number[] = [];
    let seen = 0;
    await runVision(
      { grabber: new StaticFrameGrabber(frames), ocr, regions: CHAMPIONS_DOUBLES_PLACEHOLDER },
      () => {},
      {
        frameTimeoutMs: 30,
        onFrame: fr => { processed.push(fr.ts); if (++seen === 2) ocr.hangUntilReset = true; }, // wedge after 2 good frames
        onError: () => {},
      },
    );
    expect(ocr.resets).toBeGreaterThanOrEqual(1);        // recovery actually fired
    expect(processed).toContain(0);                       // rolled before the wedge
    expect(processed).toContain(1);
    expect(processed.some(ts => ts >= 6)).toBe(true);     // AND kept rolling after it — no permanent freeze
  });

  test('watchdog fires when a frame is stuck mid-processing (last-resort respawn signal)', async () => {
    const frames: Frame[] = [{ width: 1920, height: 1080, data: new Uint8ClampedArray(1920 * 1080 * 4), ts: 0 }];
    const hangOcr: OcrReader = { async read() { return new Promise<string>(() => { /* never resolves */ }); } };
    let wedged = false;
    await Promise.race([
      runVision({ grabber: new StaticFrameGrabber(frames), ocr: hangOcr, regions: CHAMPIONS_DOUBLES_PLACEHOLDER }, () => {},
        { frameTimeoutMs: 10_000, watchdogMs: 60, onWedge: () => { wedged = true; } }),   // timeout > watchdog → watchdog wins
      new Promise(r => setTimeout(r, 400)),
    ]);
    expect(wedged).toBe(true);
  });

  test('watchdog fires on persistent fast-error churn (reset never recovers)', async () => {
    let i = 0;
    const infiniteGrabber = { async next() { return { width: 1920, height: 1080, data: new Uint8ClampedArray(1920 * 1080 * 4), ts: i++ }; } };
    const brokenOcr: OcrReader = { async read() { throw new Error('broken worker'); }, async reset() { /* doesn't recover */ } };
    let wedged = false;
    await Promise.race([
      runVision({ grabber: infiniteGrabber, ocr: brokenOcr, regions: CHAMPIONS_DOUBLES_PLACEHOLDER }, () => {},
        { frameTimeoutMs: 1000, watchdogMs: 60, resetAfter: 2, onWedge: () => { wedged = true; } }),
      new Promise(r => setTimeout(r, 500)),
    ]);
    expect(wedged).toBe(true);
  });

  test('watchdog does NOT fire on a paused feed (no frames arriving is healthy)', async () => {
    const pausedGrabber = { async next() { return new Promise<Frame | null>(() => { /* never yields */ }); } };
    const ocr: OcrReader = { async read() { return ''; } };
    let wedged = false;
    await Promise.race([
      runVision({ grabber: pausedGrabber, ocr, regions: CHAMPIONS_DOUBLES_PLACEHOLDER }, () => {},
        { watchdogMs: 60, onWedge: () => { wedged = true; } }),
      new Promise(r => setTimeout(r, 400)),
    ]);
    expect(wedged).toBe(false);
  });
});
