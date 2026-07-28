// Occupancy reconciler decision core (pure — the React wiring lives in
// BattleScreen). The vision reader asserts which species each physical nameplate
// shows (settled, high-confidence). The engine believes its own actives. When they
// disagree STEADILY, something upstream mis-slotted (banner order vs plate order,
// a mis-slotted replacement, a missed switch-out) — the recurring slot-confusion
// class. A clean pairwise SWAP is auto-correctable; anything murkier (a species
// the engine doesn't even have active) only warrants a prompt, never an auto-edit.
import { toId } from '@pokechamps/core/domain/data.js';

export type SlotRef = 'm1' | 'm2' | 'o1' | 'o2';
export type Occupancy = Partial<Record<SlotRef, string>>;

export interface ReconcileState {
  /** Consecutive assertions in which the side read as exactly SWAPPED vs the engine. */
  swapRuns: { mine: number; opp: number };
  /** Consecutive assertions with a non-swap mismatch (prompt-only). */
  mismatchRuns: { mine: number; opp: number };
}

export const freshReconcileState = (): ReconcileState => ({ swapRuns: { mine: 0, opp: 0 }, mismatchRuns: { mine: 0, opp: 0 } });

export interface ReconcileDecision {
  /** Sides whose engine actives should be swapped NOW (sustained clean swap). */
  swap: ('mine' | 'opp')[];
  /** Sides with a sustained non-swap mismatch — surface a /override prompt. */
  prompt: ('mine' | 'opp')[];
}

/** How many consecutive agreeing assertions before acting. Assertions arrive with
 *  proposals/updates (bursty, not per-frame), so 3 ≈ several seconds of steady
 *  evidence — enough to outlive a double-switch animation's stale plates. */
export const RECONCILE_RUNS = 3;

/** Feed one occupancy assertion against the engine's current actives; mutates
 *  `state` runs and returns what (if anything) should happen. Slots the reader
 *  hasn't settled (absent from the assertion) or the engine has empty (fainted,
 *  awaiting replacement) don't count against agreement. */
export function reconcileOccupancy(
  state: ReconcileState,
  asserted: Occupancy,
  engine: Occupancy,
): ReconcileDecision {
  const decision: ReconcileDecision = { swap: [], prompt: [] };
  for (const side of ['mine', 'opp'] as const) {
    const [a, b] = side === 'mine' ? (['m1', 'm2'] as const) : (['o1', 'o2'] as const);
    const asA = asserted[a], asB = asserted[b];
    const enA = engine[a], enB = engine[b];
    const cmp = (x?: string, y?: string) => !!x && !!y && toId(x) === toId(y);
    // Both slots asserted AND both engine slots occupied — the only shape we judge.
    if (!asA || !asB || !enA || !enB) { state.swapRuns[side] = 0; state.mismatchRuns[side] = 0; continue; }
    const match = cmp(asA, enA) && cmp(asB, enB);
    const swapped = !match && cmp(asA, enB) && cmp(asB, enA);
    if (match) { state.swapRuns[side] = 0; state.mismatchRuns[side] = 0; continue; }
    if (swapped) {
      state.mismatchRuns[side] = 0;
      if (++state.swapRuns[side] >= RECONCILE_RUNS) { decision.swap.push(side); state.swapRuns[side] = 0; }
    } else {
      state.swapRuns[side] = 0;
      if (++state.mismatchRuns[side] >= RECONCILE_RUNS) { decision.prompt.push(side); state.mismatchRuns[side] = 0; }
    }
  }
  return decision;
}

/** One correction: seat `teamIdx` into `slot` on `side` (it is currently in the other). */
export interface SeatFix { side: 'mine' | 'theirs'; slot: number; teamIdx: number }

/**
 * OPENING SEND-OUT lines are never a turn to ratify — they are occupancy facts.
 *  • a line naming the mon already in that slot carries no information;
 *  • a line naming a mon sitting in our OTHER slot means our seats are reversed;
 *  • a line naming a mon that isn't on the field at all is a real switch — keep it.
 *
 * Returns the lines still worth logging plus the seat corrections to apply silently.
 * Routing the second case through the ratify panel is what turned "the opponents
 * swapped" into a prompt that could be missed, taking turn 1 with it (live 2026-07-28).
 */
export function planOpeningSeats(
  lines: readonly string[],
  active: { mine: readonly (number | null)[]; theirs: readonly (number | null)[] },
  speciesAt: (side: 'mine' | 'theirs', teamIdx: number) => string | undefined,
  findInTeam: (side: 'mine' | 'theirs', species: string) => number,
  sameSpecies: (a: string, b: string) => boolean,
): { lines: string[]; seatFix: SeatFix[] } {
  const seatFix: SeatFix[] = [];
  const kept = lines.filter(l => {
    const m = l.match(/^([mo])([12]) > switch > (.+)$/);
    if (!m) return true;
    const side: 'mine' | 'theirs' = m[1] === 'm' ? 'mine' : 'theirs';
    const slot = parseInt(m[2]!, 10) - 1;
    const cur = side === 'mine' ? active.mine : active.theirs;
    const idx = cur[slot];
    const seated = idx != null ? speciesAt(side, idx) : undefined;
    if (seated && sameSpecies(seated, m[3]!)) return false;         // already there → no-op
    const other = findInTeam(side, m[3]!);
    if (other >= 0 && cur.includes(other)) { seatFix.push({ side, slot, teamIdx: other }); return false; }
    return true;                                                     // genuinely new mon
  });
  return { lines: kept, seatFix };
}
