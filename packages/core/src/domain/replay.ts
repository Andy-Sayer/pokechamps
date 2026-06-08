// Match replay support: progressive, HONEST tallies derived only from the logged
// turn actions (each MoveAction's damageHpPercent). Snapshots don't turn-stamp
// manual HP corrections (`o2 ko`, `m1 = 145`), so a perfect per-turn re-simulation
// isn't possible — but the logged damage IS accurate, so we accumulate that and
// surface an APPROXIMATE remaining-HP from it. Pure + side-effect free → testable
// and reusable by the TUI replay viewer.
import type { Match } from './types.js';

export interface ReplayTally {
  /** teamIndex → cumulative damage % DEALT by this mon through the given turn. */
  myDealt: Record<number, number>;
  oppDealt: Record<number, number>;
  /** teamIndex → cumulative damage % TAKEN by this mon through the given turn. */
  myTaken: Record<number, number>;
  oppTaken: Record<number, number>;
}

/** Accumulate logged damage dealt/taken per mon through `uptoTurnIndex` (inclusive,
 *  0-based over match.turns). Reads only recorded actions — an honest running total
 *  of what was logged, not a re-simulation. */
export function replayTallyUpTo(match: Match, uptoTurnIndex: number): ReplayTally {
  const t: ReplayTally = { myDealt: {}, oppDealt: {}, myTaken: {}, oppTaken: {} };
  const last = Math.min(uptoTurnIndex, match.turns.length - 1);
  for (let i = 0; i <= last; i++) {
    for (const a of match.turns[i]!.actions) {
      const dmg = a.damageHpPercent ?? 0;
      if (dmg <= 0) continue;
      if (a.side === 'mine') {
        if (a.attackerTeamIndex != null) t.myDealt[a.attackerTeamIndex] = (t.myDealt[a.attackerTeamIndex] ?? 0) + dmg;
        if (a.targetTeamIndex != null) t.oppTaken[a.targetTeamIndex] = (t.oppTaken[a.targetTeamIndex] ?? 0) + dmg;
      } else if (a.side === 'theirs') {
        if (a.attackerTeamIndex != null) t.oppDealt[a.attackerTeamIndex] = (t.oppDealt[a.attackerTeamIndex] ?? 0) + dmg;
        if (a.targetTeamIndex != null) t.myTaken[a.targetTeamIndex] = (t.myTaken[a.targetTeamIndex] ?? 0) + dmg;
      }
    }
  }
  return t;
}

/** Approximate remaining HP% (100 − cumulative logged damage taken, clamped to
 *  0..100). Approximate because healing / EOT residual aren't reconstructible from
 *  a snapshot — the viewer labels it as such. */
export function approxHpFromTaken(taken: Record<number, number>, teamIndex: number): number {
  return Math.max(0, Math.min(100, 100 - (taken[teamIndex] ?? 0)));
}
