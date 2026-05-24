import type { Match, MoveAction } from './types.js';

// Did a `sash`-annotated hit actually PROC the Focus Sash? It procs only when
// the target ends at a 1-HP / 1% sliver — i.e. the damage was capped. If the
// mon survived with more HP to spare, the Sash didn't trigger: the logged
// damage is the move's true output (usable for inference), and we've merely
// learned the mon HOLDS a Focus Sash.
export function sashProcced(a: MoveAction): boolean {
  if (!a.sash || typeof a.target !== 'object') return false;
  const remaining = a.target.side === 'mine' ? a.targetRemainingHpRaw : a.targetRemainingHpPercent;
  return remaining == null || remaining <= 1;
}

// Item signals inferred from move OUTCOMES rather than damage rolls (A.3
// part 2). These complement the EV-grid solver in inference.ts, which can't
// see mechanics like Choice locking or Sash survival.
//
// Deliberately SOFT: a repeated move is a *hint* of a Choice item, not proof
// (the player may simply be clicking their best move). We surface it the same
// way as `scarfSuspected` — informational, never a hard candidate cut — in
// line with the user's standing distrust of over-confident inference.

export interface ChoiceLock {
  move: string;
  turns: number; // consecutive turns this mon used the move while staying in
}

// Detect a suspected Choice lock for the opponent at `oppIdx`: the same move
// used on ≥2 consecutive turns while the mon stayed on the field. Switching
// out (or being sent in) resets the run, since a Choice lock only holds while
// the mon is active. Counts per TURN, so multi-hit moves (several actions in
// one turn) don't inflate the count.
export function detectChoiceLock(match: Match, oppIdx: number): ChoiceLock | null {
  let run: { move: string; count: number } | null = null;
  for (const turn of match.turns) {
    // Any switch involving this mon (in or out) breaks the lock.
    const switched = turn.actions.some(a =>
      a.side === 'theirs' && a.kind === 'switch'
      && (a.attackerTeamIndex === oppIdx || a.targetTeamIndex === oppIdx),
    );
    if (switched) run = null;

    const moveAct = turn.actions.find(a =>
      a.side === 'theirs' && a.kind === 'move' && a.attackerTeamIndex === oppIdx,
    );
    if (!moveAct) continue;
    if (run && run.move === moveAct.move) run.count += 1;
    else run = { move: moveAct.move, count: 1 };
  }
  return run && run.count >= 2 ? { move: run.move, turns: run.count } : null;
}
