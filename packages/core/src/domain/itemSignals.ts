import type { Match, MoveAction, FieldSide } from './types.js';

// Moves that only work on the user's FIRST turn after entering battle
// (Bulbapedia: succeeds only "first thing upon entering"; switching out and
// back resets it). Fake Out / First Impression flinch; Mat Block protects.
const FIRST_TURN_MOVES = new Set(['Fake Out', 'First Impression', 'Mat Block']);
export function isFirstTurnMove(move: string): boolean {
  return FIRST_TURN_MOVES.has(move);
}

// Can the mon at `teamIndex` still use a first-turn-only move? True iff it has
// made no move since it last entered the field. Entry = the most recent
// switch-in bringing it to its slot (or turn 0 for a lead). Switching out and
// back in resets eligibility, matching the real mechanic.
export function firstTurnOut(match: Match, side: FieldSide, teamIndex: number): boolean {
  let entryTurn = 0;
  for (const turn of match.turns) {
    for (const a of turn.actions) {
      if (a.side === side && a.kind === 'switch' && a.targetTeamIndex === teamIndex) entryTurn = turn.index;
    }
  }
  for (const turn of match.turns) {
    if (turn.index <= entryTurn) continue;
    for (const a of turn.actions) {
      if (a.side === side && a.kind === 'move' && a.attackerTeamIndex === teamIndex) return false;
    }
  }
  return true;
}

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

// The last move this mon used since it last entered the field — the HARD
// Choice-lock read (vs detectChoiceLock's soft ≥2-repeat suspicion): with a
// KNOWN Choice item, ONE use locks the mon until it leaves. Any switch
// involving the mon (in or out) resets to null, since the lock only holds
// while it stays in. Item-agnostic — the isChoiceItem gate lives at the
// caller (searchInputFromMatch).
export function lockedMoveSinceEntry(match: Match, side: FieldSide, teamIndex: number): string | null {
  let last: string | null = null;
  for (const turn of match.turns) {
    for (const a of turn.actions) {
      if (a.side !== side) continue;
      if (a.kind === 'switch' && (a.attackerTeamIndex === teamIndex || a.targetTeamIndex === teamIndex)) last = null;
      else if (a.kind === 'move' && a.attackerTeamIndex === teamIndex) last = a.move;
    }
  }
  return last;
}

// Detect if an opponent mon takes sand-chip damage, proving it's not holding
// Safety Goggles (and doesn't have Sand immunity by type/ability). This signal
// flags the opponent entry to exclude Safety Goggles from the item candidate set.
//
// Returns true if we've observed the mon taking sandstorm damage at end of turn
// (indicated by a note in inferenceNotes containing "o<idx>" and the sandstorm
// damage pattern). The caller (finalizeTurn in match/engine.ts) should mark
// the opponent entry's `sandChipObserved` flag if this returns true.
export function observedSandChip(match: Match, oppIdx: number, inferenceNotes: string[]): boolean {
  // Look for EOT notes that match the sand chip pattern:
  // "o<idx> -6% (Sand)" or similar (1/16 damage = 6.25%, displayed as -6%)
  const oppLabel = `o${oppIdx + 1}`;
  const sandChipPattern = /Sand/;
  for (const note of inferenceNotes) {
    if (note.includes(oppLabel) && sandChipPattern.test(note)) {
      return true;
    }
  }
  return false;
}
