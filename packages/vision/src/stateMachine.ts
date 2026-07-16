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
// the nameplate OCR upstream): every read is recorded on a per-ACTION timeline (stable
// once it repeats settleFrames in a row), so each move gets the settled HP from its own
// slice of the turn — two hits into one target each carry their own damage — with the
// latest value before a boundary as the turn-final fallback.
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
  /** Consecutive identical HP reads for a value to count as SETTLED (not mid-drain
   *  animation / an OCR blip) on the per-action timeline. Default 2. */
  settleFrames?: number;
  confidence?: number;
}

export class BattleStateMachine {
  private tracker: BattleTracker;
  private lastBanner = '';
  private noBannerRun = 0;
  private lastHp: Partial<Record<SlotRef, number>> = {};
  private touched = new Set<SlotRef>();   // slots whose nameplate appeared this turn (affected mons)
  private settleRuns: Partial<Record<SlotRef, { val: number; run: number }>> = {};  // consecutive-read counter per slot
  private lastPreview = '';                // last in-progress preview emitted (dedupe partials)
  private gapFrames: number;
  private clearFrames: number;
  private settleFrames: number;
  private conf: number;

  constructor(leads: Partial<Roster> = {}, opts: StateMachineOpts = {}) {
    this.tracker = new BattleTracker(leads);
    this.gapFrames = opts.gapFrames ?? 8;
    this.clearFrames = opts.clearFrames ?? 2;
    this.settleFrames = opts.settleFrames ?? 2;
    this.conf = opts.confidence ?? 0.9;
  }

  /** Feed one frame's read; returns a TurnProposal when a turn completes, else null. */
  feed(read: FrameRead): TurnProposal | null {
    for (const s of read.slots) {
      const ref = refOf(s);
      if (s.hpFraction != null) {
        const pct = Math.max(0, Math.min(100, Math.round(s.hpFraction * 100)));
        this.lastHp[ref] = pct; this.touched.add(ref);
        // Per-action HP timeline: record EVERY read (before the banner below is processed,
        // so the sample lands in the current action's window), marking it stable once the
        // same value repeats settleFrames in a row — that filters mid-drain animation
        // frames and one-off OCR blips, and is what lets two hits into the same target
        // each get their own damage instead of one merged turn-final delta.
        const run = this.settleRuns[ref];
        if (run && run.val === pct) run.run++;
        else this.settleRuns[ref] = { val: pct, run: 1 };
        this.tracker.recordHp(ref, pct, this.settleRuns[ref]!.run >= this.settleFrames);
      }
      // Seed the roster from the per-frame species OCR so a reader that JOINED mid-battle (no
      // send-out banner / no --leads) can still resolve move banners to a slot. Only fills UNKNOWN
      // slots (seedActive is a no-op otherwise), so banner-tracked switches stay authoritative.
      if (s.species && s.speciesConfidence >= 0.75) this.tracker.seedActive(ref, s.species);
    }
    const text = (read.battleText ?? '').trim();

    if (isBannerText(text)) {
      this.noBannerRun = 0;
      if (norm(text) === norm(this.lastBanner)) return null;        // same banner, still showing
      this.lastBanner = text;
      const msg = parseBanner(text);
      const lines = this.tracker.feed(msg, this.lastHp, this.touched);
      if (lines) { this.touched = new Set(); this.lastPreview = ''; return this.propose(lines, read.ts); }
      // Game over (forfeit/win/loss) → there's no NEXT turn to close the current one, and
      // the reader keeps running (no finish()). Flush the final turn now so it emits.
      if (msg.kind === 'end') {
        const flushed = this.tracker.flushPending(this.lastHp, this.touched);
        if (flushed) { this.touched = new Set(); this.lastPreview = ''; return this.propose(flushed, read.ts); }
      }
      // LIVE PREVIEW: emit the in-progress turn's lines as a PARTIAL when they change, so
      // the ratify panel shows the turn building and the user knows the reader has it.
      const preview = this.tracker.preview();
      const key = preview.join('|');
      if (preview.length && key !== this.lastPreview) {
        this.lastPreview = key;
        return { lines: preview, confidence: this.conf, notes: [], frameTs: read.ts, partial: true };
      }
      return null;
    }

    // no banner this frame — count toward the move-select gap
    this.noBannerRun++;
    if (this.noBannerRun >= this.clearFrames) this.lastBanner = '';
    if (this.noBannerRun === this.gapFrames) {
      const lines = this.tracker.flushPending(this.lastHp, this.touched);
      if (lines) { this.touched = new Set(); this.lastPreview = ''; return this.propose(lines, read.ts); }
    }
    return null;
  }

  /** Close the final in-progress turn (call at match end). */
  finish(): TurnProposal | null {
    const lines = this.tracker.flushPending(this.lastHp, this.touched);
    return lines ? this.propose(lines, 0) : null;
  }

  private propose(lines: string[], ts: number): TurnProposal {
    return { lines, confidence: this.conf, notes: [], frameTs: ts };
  }
}
