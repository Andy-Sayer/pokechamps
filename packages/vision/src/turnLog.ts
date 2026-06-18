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

/** One action → one turn-log line. */
export function emitAction(a: TurnAction): string {
  if (a.kind === 'switch') return `${a.actor} > switch > ${a.switchTo}`;
  if (a.spread && a.spread.length) {
    const parts = a.spread.map(t => `${t.ref}:${t.hpRemainingPercent}`).join(', ');
    return `${actorWithMods(a)} > ${a.move} > spread > ${parts}`;
  }
  if (a.target == null) return `${actorWithMods(a)} > ${a.move} > self`;   // status / no-damage
  const hp = a.hpRemainingPercent != null ? ` > ${a.hpRemainingPercent}` : '';
  return `${actorWithMods(a)} > ${a.move} > ${a.target}${hp}`;
}

/** A settled turn → all its turn-log lines (actions, then faint state lines). */
export function emitTurnLog(obs: TurnObservation): string[] {
  const lines = obs.actions.map(emitAction);
  for (const f of obs.faints) lines.push(`${f} ko`);
  return lines;
}
