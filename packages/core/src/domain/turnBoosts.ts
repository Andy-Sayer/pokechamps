// Positional boost context for inference.
//
// A turn is an ORDERED sequence of events. A move's observed damage depends on the
// boosts in effect AT THAT POINT in the sequence — Helping Hand (×1.5 on the ally's
// move), Coaching (+1 Atk/+1 Def to the ally), a setup self-boost, or a defensive
// boost the user logged — all applied BEFORE the move that resolves after them. If
// we infer that move's spread without those boosts, we back-solve the wrong build
// (e.g. a defense-boosted mon reads as bulkier than it is; a Helping-Hand'd hit
// reads as frailer). `scoreSpread` already consumes attacker/defender boosts +
// helpingHand on the observation — this fills them in, positionally.
//
// PURE. Walks the merged (actions + logged boost lines) timeline by `order`,
// maintains a running per-mon boost map, and returns each damaging action's context.

import type { MoveAction } from './types.js';
import type { StateUpdate } from './turnparser.js';
import { getMove, toId } from './data.js';
import type { BoostMap } from './abilities.js';

export interface ActionBoostContext {
  attackerBoosts: BoostMap;
  defenderBoosts: BoostMap;
  helpingHand: boolean;
}

const STAT_KEYS = ['atk', 'def', 'spa', 'spd', 'spe'] as const;
const clampStage = (n: number) => Math.max(-6, Math.min(6, n));
function addBoosts(a: BoostMap, b: BoostMap | undefined): BoostMap {
  if (!b) return { ...a };
  const out: BoostMap = { ...a };
  for (const k of STAT_KEYS) if (b[k]) out[k] = clampStage((out[k] ?? 0) + (b[k] ?? 0));
  return out;
}

export interface TurnBoostInput {
  actions: MoveAction[];
  /** Logged boost state-lines that belong to THIS turn's timeline (with an order). */
  stateEvents?: { order: number; update: StateUpdate }[];
  /** Start-of-turn boosts keyed by team index, per side. */
  myStartBoosts: Record<number, BoostMap>;
  oppStartBoosts: Record<number, BoostMap>;
  /** Active team index per slot, per side — to resolve a Helping Hand / Coaching ally. */
  myActive: (number | null)[];
  oppActive: (number | null)[];
}

// The OTHER active mon on `side` (the ally of the mon at `teamIndex`), or null.
function allyOf(side: 'mine' | 'opp', teamIndex: number, input: TurnBoostInput): number | null {
  const active = side === 'mine' ? input.myActive : input.oppActive;
  for (const idx of active) if (idx != null && idx !== teamIndex) return idx;
  return null;
}

/**
 * Per damaging move action (keyed by reference), the boosts in effect at its point
 * in the turn. Move actions whose damage doesn't depend on boosts still get an
 * entry (with whatever's in effect) — callers spread it onto the observation.
 */
export function computeActionBoostContexts(input: TurnBoostInput): Map<MoveAction, ActionBoostContext> {
  const myB: Record<number, BoostMap> = {};
  for (const [k, v] of Object.entries(input.myStartBoosts)) myB[+k] = { ...v };
  const oppB: Record<number, BoostMap> = {};
  for (const [k, v] of Object.entries(input.oppStartBoosts)) oppB[+k] = { ...v };
  const helped = new Set<string>();   // `${side}:${teamIndex}` Helping-Hand'd this turn
  const get = (side: 'mine' | 'opp', idx: number): BoostMap => (side === 'mine' ? myB : oppB)[idx] ?? {};
  const set = (side: 'mine' | 'opp', idx: number, b: BoostMap) => { (side === 'mine' ? myB : oppB)[idx] = b; };
  const sideOf = (s: MoveAction['side'] | StateUpdate['side']): 'mine' | 'opp' => (s === 'mine' ? 'mine' : 'opp');

  type Ev =
    | { order: number; kind: 'action'; a: MoveAction }
    | { order: number; kind: 'state'; u: StateUpdate };
  const events: Ev[] = [
    ...input.actions.map((a, i) => ({ order: a.order ?? i + 1, kind: 'action' as const, a })),
    ...(input.stateEvents ?? []).map(e => ({ order: e.order, kind: 'state' as const, u: e.update })),
  ].sort((x, y) => x.order - y.order);

  const out = new Map<MoveAction, ActionBoostContext>();
  for (const ev of events) {
    if (ev.kind === 'state') {
      if (ev.u.boosts) {
        const side = sideOf(ev.u.side);
        // Strip acc/eva (not damage-relevant stages).
        const b: BoostMap = {};
        for (const k of STAT_KEYS) if (ev.u.boosts[k]) b[k] = ev.u.boosts[k];
        set(side, ev.u.teamIndex, addBoosts(get(side, ev.u.teamIndex), b));
      }
      continue;
    }
    const a = ev.a;
    if (a.kind === 'switch' || a.kind === 'mega' || a.attackerTeamIndex == null) continue;
    const side = sideOf(a.side);
    const mid = toId(a.move);
    const m = getMove(a.move) as { category?: string; boosts?: BoostMap; target?: string } | undefined;

    // Helping Hand → the ally's move this turn is ×1.5.
    if (mid === 'helpinghand') {
      const ally = allyOf(side, a.attackerTeamIndex, input);
      if (ally != null) helped.add(`${side}:${ally}`);
      continue;
    }

    // Capture the damaging action's context BEFORE applying its own boost effect.
    const damaging = m?.category === 'Physical' || m?.category === 'Special';
    if (damaging && typeof a.target === 'object' && a.targetTeamIndex != null) {
      const defSide = sideOf(a.target.side);
      out.set(a, {
        attackerBoosts: get(side, a.attackerTeamIndex),
        defenderBoosts: get(defSide, a.targetTeamIndex),
        helpingHand: helped.has(`${side}:${a.attackerTeamIndex}`),
      });
    }

    // A status move's own boosts: self-target (setup) → the user; ally-target
    // (Coaching / Decorate / Aromatic Mist) → the ally. Applied AFTER capture so a
    // setup mon's later reference (rare) sees it but this action's own context is clean.
    if (m?.boosts && m.category === 'Status') {
      if (m.target === 'self') set(side, a.attackerTeamIndex, addBoosts(get(side, a.attackerTeamIndex), m.boosts));
      else if (/ally|allies/i.test(m.target ?? '')) {
        const ally = allyOf(side, a.attackerTeamIndex, input);
        if (ally != null) set(side, ally, addBoosts(get(side, ally), m.boosts));
      }
    }
  }
  return out;
}
