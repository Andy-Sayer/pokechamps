// Turn segmentation: split a continuous battle-event stream into TURNS. The clean
// signal is the END-OF-TURN RESIDUAL cluster — after all mons have acted, the game
// applies residuals (weather buffets, Leftovers, burn/poison…) before the next turn's
// selection. So a turn ends when, having already seen an action AND a residual, the
// next ACTION arrives (it belongs to the new turn). Mid-turn switches (pivot moves /
// post-faint replacements) DON'T cross a boundary because no residual preceded them.
//
// Observed so far: weather buffets are the residual we get from real footage. Other
// residuals (Leftovers/status damage) slot into isEotResidual as they're added to the
// parser. NOTE: a turn with NO residuals (no weather/status/items) has no event-level
// boundary — that case needs the FRAME-level signal (the no-banner move-select gap),
// which the stateMachine layer adds on top of this. HP (damage %) is attached by that
// frame layer too (it reads the nameplates at the boundary); this core is event-only.

import type { BattleMessage } from './bannerParse.js';
import { BattleAssembler, type Roster } from './assemble.js';
import type { SlotRef } from './types.js';

type HpBySlot = Partial<Record<SlotRef, number>>;

const isEotResidual = (e: BattleMessage): boolean => e.kind === 'weather';
const isActionStart = (e: BattleMessage): boolean =>
  e.kind === 'move' || e.kind === 'switchIn' || e.kind === 'mega' || e.kind === 'megaReact';
const isCommittedAction = (e: BattleMessage): boolean => e.kind === 'move' || e.kind === 'switchIn';

/** Split a flat event stream into per-turn chunks at residual→action boundaries. */
export function segmentEvents(events: BattleMessage[]): BattleMessage[][] {
  const turns: BattleMessage[][] = [];
  let cur: BattleMessage[] = [];
  let sawAction = false, sawEot = false;
  for (const e of events) {
    if (isActionStart(e) && sawAction && sawEot) {
      turns.push(cur);
      cur = []; sawAction = false; sawEot = false;
    }
    cur.push(e);
    if (isCommittedAction(e)) sawAction = true;
    if (isEotResidual(e)) sawEot = true;
  }
  if (cur.length) turns.push(cur);
  return turns;
}

/** Stateful tracker: feed events as they stream; get a completed turn's lines when a
 *  boundary is crossed. One assembler underneath, so the roster persists across turns.
 *  (Damage % is wired in by the frame layer via endTurn(hpBySlot) — omitted here.) */
export class BattleTracker {
  private asm: BattleAssembler;
  private sawAction = false;
  private sawEot = false;
  // Settled HP as the just-closed turn STARTED (= previous turn's post-HP). The delta
  // vs the closing HP drives target inference for un-named (neutral) hits.
  private hpBefore: HpBySlot = {};

  constructor(leads: Partial<Roster> = {}) { this.asm = new BattleAssembler(leads); }

  /** Current active roster snapshot. */
  getRoster(): Roster { return this.asm.getRoster(); }

  /** Turns emitted so far — guards the pair-order swap to pre-first-emission. */
  turnsClosed(): number { return this.asm.getTurnsClosed(); }

  /** Swap one side's two slots everywhere (roster + recorded refs) — see
   *  BattleAssembler.swapPair. */
  swapPair(side: 'mine' | 'opp'): void { this.asm.swapPair(side); }

  /** Reset ALL per-match state (roster, aliases, vacancy flags, turn counter) — call
   *  at match end so a long-running reader starts the next match clean. */
  resetMatch(): void {
    this.asm.resetMatch();
    this.sawAction = false; this.sawEot = false; this.hpBefore = {};
  }

  /** Seed an unknown active slot from a confident per-frame species OCR (see
   *  BattleAssembler.seedActiveIfUnknown) — recovers the roster when the reader joined
   *  mid-battle; at high confidence also overrides a garbled (unresolvable) label. */
  seedActive(ref: SlotRef, species: string, confidence = 0): void { this.asm.seedActiveIfUnknown(ref, species, confidence); }

  /** Forward one per-frame HP read onto the assembler's per-action timeline (see
   *  BattleAssembler.recordHp) — the fine-grained signal that gives each hit its own
   *  damage value when a target is hit more than once in a turn. `raw` = mine-side
   *  exact on-screen HP, carried through so the turn-log emits what the screen shows. */
  recordHp(ref: SlotRef, pct: number, stable = false, raw?: number): void { this.asm.recordHp(ref, pct, stable, raw); }

  /** In-progress lines for the current (unclosed) turn — a live preview. */
  preview(): string[] { return this.asm.preview(); }

  /** Feed one event; returns the PREVIOUS turn's lines if this event opened a new turn.
   *  `hp` (post-turn remaining HP% per slot) is attached to that closed turn's moves. */
  feed(e: BattleMessage, hp: HpBySlot = {}, touched?: Set<SlotRef>): string[] | null {
    let done: string[] | null = null;
    // A mon acting a SECOND time (different move) means the frame-level gap missed the
    // move-select pause — this event belongs to a NEW turn, so close the old one first.
    // (A same-move repeat is a banner re-fire and stays deduped in the assembler.)
    const missedBoundary = e.kind === 'move' && this.asm.moveStartsNewTurn(e.side, e.species ?? e.label, e.move);
    if ((isActionStart(e) && this.sawAction && this.sawEot) || missedBoundary) {
      const lines = this.asm.endTurnLines(hp, this.hpBefore, touched);
      done = lines.length ? lines : null;        // every line suppressed → nothing to ratify
      this.hpBefore = { ...hp };                 // this turn's post-HP = next turn's pre-HP
      this.sawAction = false; this.sawEot = false;
    }
    this.asm.feed(e);
    if (isCommittedAction(e)) this.sawAction = true;
    if (isEotResidual(e)) this.sawEot = true;
    return done;
  }

  /** Close the current turn ONLY if it has an action yet (for the frame-gap boundary —
   *  a no-residual turn ends at the move-select gap, not on an event). Else null. `touched`
   *  = slots whose nameplate appeared this turn (affected mons) → the target signal. */
  flushPending(hp: HpBySlot = {}, touched?: Set<SlotRef>): string[] | null {
    // Flush on ANY pending content, not just actions: a faint (or state line) that
    // landed after the last flush has no following action to close its turn — the
    // match-ending KO was silently lost under the actions-only gate.
    if (!this.sawAction && !this.asm.hasPending()) return null;
    const lines = this.asm.endTurnLines(hp, this.hpBefore, touched);
    this.hpBefore = { ...hp };
    this.sawAction = false; this.sawEot = false;
    return lines.length ? lines : null;          // a fully-suppressed turn (dropped garble) emits nothing
  }

  /** Close the final (in-progress) turn. */
  end(hp: HpBySlot = {}): string[] { return this.asm.endTurnLines(hp); }
}

/** Convenience: segment + assemble a whole event stream into per-turn line groups.
 *  Roster persists across turns (one assembler). HP/damage not attached (event-only). */
export function assembleMatch(events: BattleMessage[], leads: Partial<Roster> = {}): string[][] {
  const t = new BattleTracker(leads);
  const out: string[][] = [];
  for (const e of events) { const turn = t.feed(e); if (turn) out.push(turn); }
  const last = t.end();
  if (last.length) out.push(last);
  return out;
}
