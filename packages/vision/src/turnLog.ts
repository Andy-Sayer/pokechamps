// Turn-log emitter: TurnObservation → canonical turn-log lines, the exact strings
// you'd type into BattleScreen by hand (grammar in docs/notes + the turnparser).
// This is the contract boundary: get this right and vision output flows through
// the existing parser/engine/inference unchanged.
import type { TurnObservation, TurnAction } from './types.js';

function actorWithMods(a: TurnAction): string {
  let s = a.actor as string;
  if (a.mega) s += '+mega';
  if (a.crit) s += '+crit';
  return s;
}

// Damage-slot units mirror the screen, exactly as a human would key them in:
//   mine-side target → the RAW on-screen HP ("117" from "117/175"), bare number
//   opp-side target  → the on-screen percent, bare number
// A mine-side read that only got the bar fraction (digits unreadable) falls back to an
// EXPLICIT `%` — a bare m-side number would be mis-parsed as raw HP.
const fmtHp = (ref: string, pct: number, raw?: number): string =>
  ref.startsWith('m') ? (raw != null ? `${raw}` : `${pct}%`) : `${pct}`;

/** One action → one turn-log line. */
export function emitAction(a: TurnAction): string {
  if (a.kind === 'switch') return `${a.actor} > switch > ${a.switchTo}`;
  if (a.spread && a.spread.length) {
    const parts = a.spread.map(t => `${t.ref}:${fmtHp(t.ref, t.hpRemainingPercent, t.hpRemainingRaw)}`).join(', ');
    return `${actorWithMods(a)} > ${a.move} > spread > ${parts}`;
  }
  if (a.target == null) return `${actorWithMods(a)} > ${a.move} > self`;   // status / no-damage
  const hp = a.hpRemainingPercent != null ? ` > ${fmtHp(a.target, a.hpRemainingPercent, a.hpRemainingRaw)}` : '';
  return `${actorWithMods(a)} > ${a.move} > ${a.target}${hp}`;
}

/** A settled turn → all its turn-log lines (actions, standalone megas, then faint lines). */
export function emitTurnLog(obs: TurnObservation): string[] {
  const lines = obs.actions.map(emitAction);
  // Standalone mega declarations for mons that mega'd but whose move wasn't captured.
  for (const ref of obs.megas ?? []) lines.push(`${ref} mega`);
  // Stat-boost state lines (Intimidate on switch-in, Nasty Plot, …).
  for (const sl of obs.stateLines ?? []) lines.push(sl);
  for (const f of obs.faints) lines.push(`${f} ko`);
  return lines;
}
