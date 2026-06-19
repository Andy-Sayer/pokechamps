// The live loop: per-frame reads in, ratifiable TurnProposals out. It ties the
// pieces together — dedupe the banner across the frames it persists, parse each NEW
// banner to an event, feed the tracker (roster + segmentation), snapshot HP from the
// slot reads, and close a turn at a boundary, attaching the settled HP as damage.
//
//   FrameRead ─▶ [dedupe banner] ─▶ parseBanner ─▶ BattleTracker ─▶ TurnProposal
//                       └─ no-banner run = move-select GAP ─▶ flush a no-residual turn
//
// Two boundary signals, both handled: a residual→action transition inside the tracker
// (turns WITH weather/Leftovers), and the move-select GAP — a run of no-banner frames
// — which flushes a turn that had no residual. HP comes from the slot reads (opp % via
// the nameplate OCR upstream); the latest settled value before a boundary is the
// post-turn remaining HP%.
//
// `gapFrames` is the one capture-timing knob: long enough to clear a mid-turn
// animation lull, short enough to catch the real move-select pause. Tune on a live
// stream; the default suits ~5 fps. Everything else is deterministic + unit-tested.

import type { FrameRead, SlotRead, SlotRef, TurnProposal } from './types.js';
import { parseBanner } from './bannerParse.js';
import { BattleTracker } from './track.js';
import type { Roster } from './assemble.js';

const refOf = (s: Pick<SlotRead, 'side' | 'index'>): SlotRef =>
  s.side === 'mine' ? (s.index === 0 ? 'm1' : 'm2') : (s.index === 0 ? 'o1' : 'o2');
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const isBannerText = (t: string) => t.length > 5 && /[a-z]{3}/i.test(t);

export interface StateMachineOpts {
  /** No-banner frames that mark the move-select gap (turn boundary). Default 8. */
  gapFrames?: number;
  /** No-banner frames after which the banner is considered cleared (so a later repeat
   *  re-fires). Default 2 — tolerates a 1-frame flicker. */
  clearFrames?: number;
  confidence?: number;
}

export class BattleStateMachine {
  private tracker: BattleTracker;
  private lastBanner = '';
  private noBannerRun = 0;
  private lastHp: Partial<Record<SlotRef, number>> = {};
  private gapFrames: number;
  private clearFrames: number;
  private conf: number;

  constructor(leads: Partial<Roster> = {}, opts: StateMachineOpts = {}) {
    this.tracker = new BattleTracker(leads);
    this.gapFrames = opts.gapFrames ?? 8;
    this.clearFrames = opts.clearFrames ?? 2;
    this.conf = opts.confidence ?? 0.9;
  }

  /** Feed one frame's read; returns a TurnProposal when a turn completes, else null. */
  feed(read: FrameRead): TurnProposal | null {
    for (const s of read.slots) {
      if (s.hpFraction != null) this.lastHp[refOf(s)] = Math.max(0, Math.min(100, Math.round(s.hpFraction * 100)));
    }
    const text = (read.battleText ?? '').trim();

    if (isBannerText(text)) {
      this.noBannerRun = 0;
      if (norm(text) === norm(this.lastBanner)) return null;        // same banner, still showing
      this.lastBanner = text;
      const lines = this.tracker.feed(parseBanner(text), this.lastHp);
      return lines ? this.propose(lines, read.ts) : null;
    }

    // no banner this frame — count toward the move-select gap
    this.noBannerRun++;
    if (this.noBannerRun >= this.clearFrames) this.lastBanner = '';
    if (this.noBannerRun === this.gapFrames) {
      const lines = this.tracker.flushPending(this.lastHp);
      if (lines) return this.propose(lines, read.ts);
    }
    return null;
  }

  /** Close the final in-progress turn (call at match end). */
  finish(): TurnProposal | null {
    const lines = this.tracker.flushPending(this.lastHp);
    return lines ? this.propose(lines, 0) : null;
  }

  private propose(lines: string[], ts: number): TurnProposal {
    return { lines, confidence: this.conf, notes: [], frameTs: ts };
  }
}
