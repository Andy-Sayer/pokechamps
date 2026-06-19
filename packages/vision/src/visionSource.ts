// The orchestrator: grab a frame → read its regions → feed the state machine →
// on a settled turn, emit a parser-ready TurnProposal for the TUI to confirm.
// The deterministic primitives (readHpFraction, matchSpecies, emitTurnLog) are
// ready; what's stubbed is the glue that needs a real Frame + OCR engine.
import type { Frame, FrameRead, RegionMap, TurnProposal } from './types.js';
import type { FrameGrabber } from './frameGrabber.js';
import type { OcrReader } from './ocr.js';
import { readHpFraction } from './hpBar.js';
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

/** Read one frame into a FrameRead: HP fractions from the bars + name/text OCR.
 *  NOTE: opp HP is more reliable via the nameplate NUMBER (white-isolation + digit
 *  OCR — see hpRead.readOpponentHpPercents) than the bar, which carries an overlaid
 *  number; wire that in here once deps.ocr can OCR a preprocessed pixel buffer. */
export async function readFrame(frame: Frame, deps: VisionDeps): Promise<FrameRead> {
  const slots = await Promise.all(deps.regions.slots.map(async sr => {
    const bar = cropRegion(frame, sr.hpBar);
    const hpFraction = readHpFraction(bar.data, bar.width, bar.height);
    const speciesRaw = (await deps.ocr.read(frame, sr.name)).trim();
    const m = speciesRaw ? matchSpecies(speciesRaw) : null;
    return {
      side: sr.side, index: sr.index,
      species: m && m.score >= 0.6 ? m.value : null,
      speciesRaw, speciesConfidence: m?.score ?? 0,
      hpFraction, status: null,
    };
  }));
  const battleText = (await deps.ocr.read(frame, deps.regions.battleText)).trim();
  return { ts: frame.ts, slots, battleText };
}

/** Live loop: grab → read → feed → propose. Stops when the grabber drains or
 *  `opts.stop()` returns true. Each completed turn calls `onProposal` with the
 *  canonical turn-log lines for the TUI to confirm/edit before committing. Seed
 *  `opts.leads` (the two active mons per side from team preview) so slots resolve
 *  from turn 1. */
export async function runVision(
  deps: VisionDeps,
  onProposal: (p: TurnProposal) => void,
  opts: { stop?: () => boolean; leads?: Partial<Roster> } = {},
): Promise<void> {
  const sm = new BattleStateMachine(opts.leads ?? {});
  for (;;) {
    if (opts.stop?.()) break;
    const frame = await deps.grabber.next();
    if (!frame) break;
    const proposal = sm.feed(await readFrame(frame, deps));
    if (proposal) onProposal(proposal);
  }
  const last = sm.finish();            // flush the final in-progress turn
  if (last) onProposal(last);
}
