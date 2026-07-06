// The orchestrator: grab a frame → read its regions → feed the state machine →
// on a settled turn, emit a parser-ready TurnProposal for the TUI to confirm.
// The deterministic primitives (readHpFraction, matchSpecies, emitTurnLog) are
// ready; what's stubbed is the glue that needs a real Frame + OCR engine.
import type { Frame, FrameRead, RegionMap, TurnProposal, Rect } from './types.js';
import type { FrameGrabber } from './frameGrabber.js';
import type { OcrReader } from './ocr.js';
import { readHpFractionGated } from './hpBar.js';
import { parseHpNumber, parseAbsHp } from './hpRead.js';
import { matchSpecies } from './fuzzyMatch.js';
import { toPixels } from './regions.js';
import { BattleStateMachine } from './stateMachine.js';
import type { Roster } from './assemble.js';

export interface VisionDeps {
  grabber: FrameGrabber;
  ocr: OcrReader;
  regions: RegionMap;
}

/** Crop a normalized region out of a frame into a tight RGBA buffer. */
export function cropRegion(frame: Frame, r: { x: number; y: number; w: number; h: number }): { data: Uint8ClampedArray; width: number; height: number } {
  const { x, y, w, h } = toPixels(r, frame.width, frame.height);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const src = ((y + row) * frame.width + x) * 4;
    out.set(frame.data.subarray(src, src + w * 4), row * w * 4);
  }
  return { data: out, width: w, height: h };
}

/** My "cur/max" HP digits are fragile at small (GameShare-inset) scales — the
 *  italic text garbles and the best OCR upscale VARIES per frame (one mon reads
 *  at ×5, another only at ×4). Try a few upscales and accept the first SANE parse
 *  (cur ≤ max, max in a plausible L50 HP range), so a per-region scale quirk can't
 *  poison the read. Falls through to null (→ bar fallback) when none are sane. */
export async function readAbsHpRobust(ocr: OcrReader, frame: Frame, region: Rect): Promise<{ cur: number; max: number } | null> {
  for (const scale of [4, 5, 3]) {
    const abs = parseAbsHp(await ocr.read(frame, region, { mode: 'digits', psm: 7, scale }));
    if (abs && abs.cur <= abs.max && abs.max >= 1 && abs.max <= 999) return abs;
  }
  return null;
}

/** Read one frame into a FrameRead: HP from the nameplate NUMBER (preferred) with the
 *  bar as fallback, plus name/text OCR. The bar carries an overlaid number + a skew, so
 *  the digit read is the game's own exact value: opp shows a PERCENT (`oppHpText`), mine
 *  an ABSOLUTE "cur/max" (`myHpText`). Falls back to the bar fraction when the number is
 *  unreadable (mid-animation), so a frame is never worse off than the bar alone. */
export async function readFrame(frame: Frame, deps: VisionDeps): Promise<FrameRead> {
  const { regions } = deps;
  const slots = await Promise.all(regions.slots.map(async sr => {
    const bar = cropRegion(frame, sr.hpBar);
    const barFraction = readHpFractionGated(bar.data, bar.width, bar.height);

    // Nameplate number: opp = percent (PSM 8, single word); mine = cur/max (PSM 7, line).
    let numFraction: number | null = null;
    if (sr.side === 'opp' && regions.oppHpText) {
      const pct = parseHpNumber(await deps.ocr.read(frame, regions.oppHpText[sr.index], { mode: 'digits', psm: 8 }));
      if (pct != null) numFraction = Math.max(0, Math.min(100, pct)) / 100;
    } else if (sr.side === 'mine' && regions.myHpText) {
      const abs = await readAbsHpRobust(deps.ocr, frame, regions.myHpText[sr.index]);
      if (abs) numFraction = Math.max(0, Math.min(1, abs.cur / abs.max));
    }

    const speciesRaw = (await deps.ocr.read(frame, sr.name)).trim();
    const m = speciesRaw ? matchSpecies(speciesRaw) : null;
    // Nameplate present iff real NAME text is at the slot. During move execution (the
    // cinematic view) the plates are gone → name is empty and any HP read is arena
    // garbage, so report null HP. This is the fix for the "no nameplate → 100%/0%"
    // poisoning that wrecked damage + target inference.
    const plate = speciesRaw.replace(/[^a-z]/gi, '').length >= 3;
    return {
      side: sr.side, index: sr.index,
      species: m && m.score >= 0.6 ? m.value : null,
      speciesRaw, speciesConfidence: m?.score ?? 0,
      hpFraction: plate ? (numFraction ?? barFraction) : null, status: null,
    };
  }));
  const battleText = (await deps.ocr.read(frame, regions.battleText)).trim();
  return { ts: frame.ts, slots, battleText };
}

/** Live loop: grab → read → feed → propose. Stops when the grabber drains or
 *  `opts.stop()` returns true. Each completed turn calls `onProposal` with the
 *  canonical turn-log lines for the TUI to confirm/edit before committing. Seed
 *  `opts.leads` (the two active mons per side from team preview) so slots resolve
 *  from turn 1. */
const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms).unref?.())]);

export async function runVision(
  deps: VisionDeps,
  onProposal: (p: TurnProposal) => void,
  opts: { stop?: () => boolean; leads?: Partial<Roster>; onFrame?: (fr: FrameRead, raw: Frame) => void; onError?: (e: Error, consecutive: number) => void; onProgress?: () => void; onWedge?: () => void; frameTimeoutMs?: number; resetAfter?: number; watchdogMs?: number } = {},
): Promise<void> {
  const sm = new BattleStateMachine(opts.leads ?? {});
  let consecErrors = 0;
  let n = 0;
  const stage = process.env.VISION_STAGE ? (s: string) => process.stderr.write(`[stage] ${Date.now()} f${n} ${s}\n`) : () => {};

  // WATCHDOG: fires when the loop is ACTIVE (frames arriving) but making NO forward progress —
  // covering BOTH a single stuck frame (async hang; the event loop is still free so this interval
  // runs) AND persistent fast-erroring churn that the per-frame timeout+reset can't recover.
  // `grabsSinceProgress` is reset to 0 on every SUCCESSFUL frame, and a paused feed grabs nothing,
  // so a healthy idle wait never trips it. onWedge is the last resort → the parent respawns clean.
  let lastProgress = Date.now();
  let grabsSinceProgress = 0;
  const wdMs = opts.watchdogMs ?? 15000;
  const wd = opts.onWedge ? setInterval(() => {
    if (grabsSinceProgress > 0 && Date.now() - lastProgress > wdMs) opts.onWedge!();
  }, Math.min(3000, wdMs)) : null;   // poll no coarser than the window itself
  wd?.unref?.();

  try {
    for (;;) {
      if (opts.stop?.()) break;
      stage('grab:start');
      const frame = await deps.grabber.next();   // idle-waiting here is HEALTHY (no grab, no trip)
      stage('grab:done');
      if (!frame) break;
      n++;
      grabsSinceProgress++;                       // a frame arrived → the loop is active
      // A single bad frame (OCR hiccup, torn image, hung worker) must NOT kill the watch — catch
      // + skip. The timeout guards against a hang that would otherwise stall the loop forever.
      try {
        stage('read:start');
        const fr = await withTimeout(readFrame(frame, deps), opts.frameTimeoutMs ?? 4000, 'frame read');
        stage('read:done');
        opts.onFrame?.(fr, frame);   // instrumentation hook (see read-live --debug)
        stage('feed');
        const proposal = sm.feed(fr);
        if (proposal) onProposal(proposal);
        consecErrors = 0;
        lastProgress = Date.now();               // real progress → the watchdog is satisfied
        grabsSinceProgress = 0;
        opts.onProgress?.();
      } catch (e) {
        opts.onError?.(e as Error, ++consecErrors);
        // Repeated errors ⇒ the OCR worker likely hung/crashed (its queue is blocked — see
        // tesseract.js #325). Reset it so the watch recovers instead of timing out forever.
        if (consecErrors >= (opts.resetAfter ?? 2) && deps.ocr.reset) { try { await deps.ocr.reset(); } catch { /* keep going */ } consecErrors = 0; }
        await new Promise(r => setTimeout(r, 100));   // error backoff: don't hot-spin; lets the watchdog macrotask fire
      }
    }
  } finally {
    if (wd) clearInterval(wd);
  }
  const last = sm.finish();            // flush the final in-progress turn
  if (last) onProposal(last);
}
