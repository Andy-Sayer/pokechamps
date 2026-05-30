// HP-threshold item triggers — pure logic.
//
// Sitrus Berry: when HP crosses below 50% (was > 50, is now <= 50 but > 0),
// heal 25% then consume.
// Pinch berries (Salac / Liechi / Petaya / Ganlon / Apicot): when HP crosses
// below 25% (was > 25, is now <= 25 but > 0), apply +1 to the matching stat
// then consume.
//
// Why a separate module: the engine + BattleScreen each have a finalizeTurn
// implementation (per `project_dual_finalize_turn` memory) that decrements HP
// at multiple sites — damage hits, Leech Seed drains, residual chip, etc.
// Centralising the trigger logic here keeps both call sites symmetric and
// makes the rules unit-testable in isolation.
//
// Scope intentionally limited to MY side. Opp items are usually unknown and
// auto-firing a guessed Salac would silently corrupt downstream inference.
// When opp items are revealed (e.g. via a future "I saw the Sitrus animation"
// state line), the caller can route opp triggers through the same helper.

import type { StatID } from './types.js';

export interface HpItemTriggerResult {
  consumed: string;                                       // item name to mark consumed
  healPercent?: number;                                   // % of max HP to restore (0..100)
  boost?: { stat: StatID; amount: number };               // boost stage to apply
}

const PINCH_BERRY_STAT: Readonly<Record<string, StatID>> = {
  'Salac Berry': 'spe',
  'Liechi Berry': 'atk',
  'Petaya Berry': 'spa',
  'Ganlon Berry': 'def',
  'Apicot Berry': 'spd',
};

// Compute the trigger (if any) for an HP transition. Pure: no match state read
// or mutated. Caller threads the `item` (must be the holder's current item,
// undefined if already consumed) and the prev/new HP percentages.
//
// Boundary behaviour: triggers fire on the FALLING edge — `prev > threshold`
// and `newHp <= threshold`. So a hit that lands you at exactly 50% triggers
// Sitrus; a hit that leaves you AT exactly 50% from a prior 50% (a no-op)
// does not. Triggers never fire when newHp === 0 (the holder fainted; the
// game doesn't grant berries to a KO'd mon).
export function hpItemTriggerFor(
  item: string | undefined,
  prevHpPercent: number,
  newHpPercent: number,
): HpItemTriggerResult | null {
  if (!item) return null;
  if (newHpPercent <= 0) return null;
  if (newHpPercent >= prevHpPercent) return null;

  // Sitrus: <50% threshold, heal 25%.
  if (item === 'Sitrus Berry') {
    if (prevHpPercent > 50 && newHpPercent <= 50) {
      return { consumed: 'Sitrus Berry', healPercent: 25 };
    }
    return null;
  }

  // Oran Berry: <50% threshold, heal 10 HP flat — but the holder's max HP
  // is unknown at this layer (we work in %). Approximate as ~5% for an
  // average max ~200; the gap is small and Oran is essentially never used
  // in VGC anyway. Skip for now to avoid false precision.

  // Pinch berries: <=25% threshold, +1 to the matching stat.
  const stat = PINCH_BERRY_STAT[item];
  if (stat && prevHpPercent > 25 && newHpPercent <= 25) {
    return { consumed: item, boost: { stat, amount: 1 } };
  }

  return null;
}

// True for any item this module knows how to auto-trigger. Useful for the
// caller to short-circuit the prev/newHp lookup when the holder isn't a
// candidate at all.
export function isHpItemTriggerItem(item: string | undefined): boolean {
  if (!item) return false;
  return item === 'Sitrus Berry' || item in PINCH_BERRY_STAT;
}
