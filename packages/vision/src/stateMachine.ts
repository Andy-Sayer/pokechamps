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
  /** Consecutive no-banner frames WITH every live nameplate visible that mark the
   *  move-select gap (turn boundary). Default 24 (~10s at 2.5 reads/sec). Mid-turn
   *  animation lulls (mega cinematic, a slow move) blank the banner for up to ~15
   *  frames — the old default of 8 chopped turns mid-action (late KOs, lost damage
   *  values, mis-targeted moves; see live-test 2026-07-23). Real move-select pauses
   *  ran ≥48 frames in that match, so 24 splits the two populations with ~2× margin
   *  on each side. The plate gate adds robustness: cinematics hide the plates, the
   *  select screen shows them all. */
  gapFrames?: number;
  /** Hard boundary: no-banner frames after which the turn flushes REGARDLESS of plate
   *  visibility (a select variant that hides plates must not stall the reader forever).
   *  Default 3 × gapFrames. */
  longGapFrames?: number;
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
  private plateGapRun = 0;                 // no-banner frames with ALL live plates visible (move-select signature)
  private pairContra = { mine: 0, opp: 0 };  // consecutive frames where a side's plates read exactly SWAPPED vs roster
  // OCCUPANCY ASSERTIONS: per physical slot, the species its nameplate has shown for
  // settleFrames+ consecutive confident reads — the ground truth the TUI reconciles
  // the engine against. Kept as last-settled until a new species settles.
  private plateRuns: Partial<Record<SlotRef, { sp: string; run: number }>> = {};
  private occupancy: Partial<Record<SlotRef, string>> = {};
  private occupancyDirty = false;
  private gapFrames: number;
  private longGapFrames: number;
  private clearFrames: number;
  private settleFrames: number;
  private conf: number;

  constructor(leads: Partial<Roster> = {}, opts: StateMachineOpts = {}) {
    this.tracker = new BattleTracker(leads);
    this.gapFrames = opts.gapFrames ?? 24;
    this.longGapFrames = opts.longGapFrames ?? this.gapFrames * 3;
    this.clearFrames = opts.clearFrames ?? 2;
    this.settleFrames = opts.settleFrames ?? 2;
    this.conf = opts.confidence ?? 0.9;
  }

  /** Feed one frame's read; returns a TurnProposal when a turn completes, a live
   *  preview when the in-progress turn changes, or a lines-empty occupancy update
   *  when a plate fact settles between turns. Every emission carries `occupancy`. */
  feed(read: FrameRead): TurnProposal | null {
    this.occupancyDirty = false;
    const p = this.feedInner(read);
    if (p) { p.occupancy = { ...this.occupancy }; return p; }
    if (this.occupancyDirty) return { lines: [], confidence: this.conf, notes: [], frameTs: read.ts, partial: true, occupancy: { ...this.occupancy } };
    return null;
  }

  private feedInner(read: FrameRead): TurnProposal | null {
    for (const s of read.slots) {
      const ref = refOf(s);
      if (s.hpFraction != null) {
        const pct = Math.max(0, Math.min(100, Math.round(s.hpFraction * 100)));
        const raw = s.hpRaw ?? undefined;              // mine-side exact on-screen HP, when the digits resolved
        this.lastHp[ref] = pct; this.touched.add(ref);
        // Per-action HP timeline: record EVERY read (before the banner below is processed,
        // so the sample lands in the current action's window), marking it stable once the
        // same value repeats settleFrames in a row — that filters mid-drain animation
        // frames and one-off OCR blips, and is what lets two hits into the same target
        // each get their own damage instead of one merged turn-final delta. The raw value
        // (finer than the rounded %) is the settle key when present.
        const key = raw ?? pct;
        const run = this.settleRuns[ref];
        if (run && run.val === key) run.run++;
        else this.settleRuns[ref] = { val: key, run: 1 };
        this.tracker.recordHp(ref, pct, this.settleRuns[ref]!.run >= this.settleFrames, raw);
      }
      // Seed the roster from the per-frame species OCR so a reader that JOINED mid-battle (no
      // send-out banner / no --leads) can still resolve move banners to a slot. Only fills UNKNOWN
      // slots (seedActive is a no-op otherwise), so banner-tracked switches stay authoritative.
      if (s.species && s.speciesConfidence >= 0.75) this.tracker.seedActive(ref, s.species, s.speciesConfidence);
      // Occupancy: settle a plate fact after 3 consecutive confident reads of the
      // same species. Last-settled persists through animations (plate hidden).
      if (s.species && s.speciesConfidence >= 0.85) {
        const run = this.plateRuns[ref];
        if (run && run.sp === s.species) run.run++;
        else this.plateRuns[ref] = { sp: s.species, run: 1 };
        if (this.plateRuns[ref]!.run >= 3 && this.occupancy[ref] !== s.species) {
          this.occupancy[ref] = s.species;
          this.occupancyDirty = true;
        }
      }
    }
    // PAIR-ORDER RECONCILE: the opening double send-out banner ("sent out A and B!")
    // lists the pair in an arbitrary order, but the nameplate INDEX is ground truth.
    // If both of a side's plates read confidently and show exactly the roster pair
    // SWAPPED, for 2 consecutive frames, swap the roster (+ recorded refs) — only
    // before anything was emitted; after that the engine already believes the old
    // mapping and a silent swap would desync it. (Seen live: every opp HP read crossed
    // for a whole match.)
    for (const side of ['mine', 'opp'] as const) {
      const pair = read.slots.filter(s => s.side === side).sort((a, b) => a.index - b.index);
      const roster = this.tracker.getRoster();
      const [rA, rB] = side === 'mine' ? [roster.m1, roster.m2] : [roster.o1, roster.o2];
      const confident = pair.length === 2 && pair.every(s => s.species && s.speciesConfidence >= 0.8);
      const swapped = confident && rA != null && rB != null &&
        norm(pair[0]!.species!) === norm(rB) && norm(pair[1]!.species!) === norm(rA) && norm(rA) !== norm(rB);
      this.pairContra[side] = swapped ? this.pairContra[side] + 1 : 0;
      // Pre-first-flush: swap fast (2 frames) — nothing emitted yet. MID-MATCH the
      // swap is also allowed (the engine now follows plate truth via the occupancy
      // reconciler) but demands a longer sustained contradiction so a double-switch
      // animation's lingering plates can't flip it transiently.
      const need = this.tracker.turnsClosed() === 0 ? 2 : 6;
      if (this.pairContra[side] >= need) {
        this.tracker.swapPair(side);
        this.pairContra[side] = 0;
        // The HP/touched maps are keyed by TRUE plate refs and stay valid; only the
        // roster's species↔slot mapping was wrong.
      }
    }
    const text = (read.battleText ?? '').trim();

    if (isBannerText(text)) {
      this.noBannerRun = 0;
      this.plateGapRun = 0;
      if (norm(text) === norm(this.lastBanner)) return null;        // same banner, still showing
      this.lastBanner = text;
      const msg = parseBanner(text);
      const lines = this.tracker.feed(msg, this.lastHp, this.touched);
      if (lines) { this.touched = new Set(); this.lastPreview = ''; return this.propose(lines, read.ts); }
      // Game over (forfeit/win/loss) → there's no NEXT turn to close the current one, and
      // the reader keeps running (no finish()). Flush the final turn now so it emits,
      // then RESET all per-match state — a long-running reader carried the previous
      // match's roster/faint-vacancy flags into the next one (seen live:
      // `mDragonite in m1` for a voluntary switch, keyed off a stale vacancy).
      if (msg.kind === 'end') {
        const flushed = this.tracker.flushPending(this.lastHp, this.touched);
        this.tracker.resetMatch();
        this.lastHp = {}; this.touched = new Set(); this.settleRuns = {}; this.plateRuns = {};
        this.occupancy = {}; this.pairContra = { mine: 0, opp: 0 }; this.lastPreview = '';
        if (flushed) return this.propose(flushed, read.ts);
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

    // No banner this frame — count toward the move-select gap. The PLATE GATE: only
    // frames where every live slot's nameplate is visible count toward the (short) gap.
    // Mid-turn animation lulls hide the plates (cinematic camera), the move-select
    // screen shows them all — that's the discriminator that stops a slow animation
    // from chopping the turn mid-action. longGapFrames is the plate-blind hard stop.
    this.noBannerRun++;
    if (this.noBannerRun >= this.clearFrames) this.lastBanner = '';
    const roster = this.tracker.getRoster();
    const live = read.slots.filter(s => roster[refOf(s)] != null);
    const allPlates = live.length > 0 && live.every(s => s.speciesRaw.replace(/[^a-z]/gi, '').length >= 3);
    this.plateGapRun = allPlates ? this.plateGapRun + 1 : 0;
    if (this.plateGapRun === this.gapFrames || this.noBannerRun === this.longGapFrames) {
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
