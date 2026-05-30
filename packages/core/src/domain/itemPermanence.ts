// Items split into two lifetimes:
//   - `consumable` — one-shot. Triggers, then it's gone. Affects future turns'
//     calc (no item held → Acrobatics doubles in BP) and is auto-marked
//     `itemConsumed` once the trigger fires.
//   - `persistent` — stays the whole match (Leftovers, Choice, Eviolite, Life
//     Orb, mega stones, type-boost items, Assault Vest, Heavy-Duty Boots …).
//     Can ONLY leave the field via Trick / Switcheroo / Knock Off / Corrosive
//     Gas (the `isItemRemovingMove` / `isItemSwapMove` path).
//
// The split lets downstream callers reason about state — e.g. a mon whose item
// was naturally consumed couldn't have been holding Leftovers — and is the
// foundation for the Acrobatics BP swing, resist-berry / pinch-berry triggers,
// and tightened item inference (see docs/notes/accuracy-roadmap.md).

import { getItem } from './data.js';

export type ItemPermanence = 'consumable' | 'persistent';

// Curated non-berry, non-gem one-shot items. Berries (isBerry) and Gems (isGem)
// are auto-classified via the dex below. Everything else falls through to
// `persistent` — held items, Choice items, type-boosters, mega stones …
const CONSUMABLE_NON_BERRY: ReadonlySet<string> = new Set([
  'Focus Sash',
  'Air Balloon',
  'White Herb',
  'Mental Herb',
  'Power Herb',
  'Eject Button',
  'Eject Pack',
  'Red Card',
  'Weakness Policy',
  'Booster Energy',
  'Mirror Herb',
]);

const toId = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const CONSUMABLE_IDS: ReadonlySet<string> = new Set(Array.from(CONSUMABLE_NON_BERRY, toId));

/**
 * Classify an item by lifetime. Unknown / falsy names default to `persistent`
 * — a missing classification should never wrongly mark something consumable.
 */
export function itemPermanence(name: string | null | undefined): ItemPermanence {
  if (!name) return 'persistent';
  const id = toId(name);
  if (CONSUMABLE_IDS.has(id)) return 'consumable';
  const item = getItem(name) as { isBerry?: boolean; isGem?: boolean } | undefined;
  if (item?.isBerry || item?.isGem) return 'consumable';
  return 'persistent';
}

/** Convenience: true iff the item is one-shot. */
export function isConsumable(name: string | null | undefined): boolean {
  return itemPermanence(name) === 'consumable';
}
