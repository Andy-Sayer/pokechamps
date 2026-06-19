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

  constructor(leads: Partial<Roster> = {}) { this.asm = new BattleAssembler(leads); }

  /** Current active roster snapshot. */
  getRoster(): Roster { return this.asm.getRoster(); }

  /** Feed one event; returns the PREVIOUS turn's lines if this event opened a new turn. */
  feed(e: BattleMessage): string[] | null {
    let done: string[] | null = null;
    if (isActionStart(e) && this.sawAction && this.sawEot) {
      done = this.asm.endTurnLines();
      this.sawAction = false; this.sawEot = false;
    }
    this.asm.feed(e);
    if (isCommittedAction(e)) this.sawAction = true;
    if (isEotResidual(e)) this.sawEot = true;
    return done;
  }

  /** Close the final (in-progress) turn. */
  end(): string[] { return this.asm.endTurnLines(); }
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
