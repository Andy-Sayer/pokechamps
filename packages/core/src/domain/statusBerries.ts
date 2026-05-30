// Status-berry auto-cure on status application.
//
// When a non-volatile status (brn/par/psn/tox/slp/frz) is about to be applied
// to a holder of the matching status berry, the berry consumes itself and the
// status NEVER lands. Same semantics as Lum Berry (universal) — the berry
// triggers ON application, so the displayed state is "no status, berry gone."
//
// Why a separate module: same reasoning as `hpItemTriggers.ts` — status gets
// applied at 3+ sites per finalize (hazards, state lines, Spicy Spray on-hit
// burn). Centralising lets the engine + BattleScreen mirror call the same
// `statusBerryCures(item, status)` decision and stay symmetric.
//
// Confusion: a volatile we don't currently track, so Persim Berry is out of
// scope until/unless we add a confusion volatile.

import type { ActivePokemonState } from './types.js';

type NonVolatileStatus = NonNullable<ActivePokemonState['status']>;

// Map item -> set of statuses it cures. Lum cures any non-volatile.
const STATUS_BERRY_CURES: Readonly<Record<string, ReadonlySet<NonVolatileStatus>>> = {
  'Lum Berry': new Set(['brn', 'par', 'psn', 'tox', 'slp', 'frz']),
  'Cheri Berry': new Set(['par']),
  'Chesto Berry': new Set(['slp']),
  'Pecha Berry': new Set(['psn', 'tox']),
  'Rawst Berry': new Set(['brn']),
  'Aspear Berry': new Set(['frz']),
};

export interface StatusBerryResult {
  consumed: string;   // item to mark consumed; status is NOT applied
}

// True when `item` is a status berry that cures `status`. The caller is
// expected to consult `match.myItemConsumed` to confirm the holder still has
// the item before passing it; pass `undefined` after consumption.
export function statusBerryFor(
  item: string | undefined,
  status: NonVolatileStatus | undefined | null,
): StatusBerryResult | null {
  if (!item || !status) return null;
  const cures = STATUS_BERRY_CURES[item];
  if (!cures) return null;
  return cures.has(status) ? { consumed: item } : null;
}

export function isStatusBerry(item: string | undefined): boolean {
  return !!item && item in STATUS_BERRY_CURES;
}
