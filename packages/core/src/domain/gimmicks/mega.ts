import type { Gimmick } from './types.js';
import { Dex } from '@pkmn/dex';

// Kept independent of ../data.ts on purpose — pulling in the data layer would
// create a circular import (data.ts registers this module's resolver during
// initialization). Mega only needs the dex directly and the format that's
// already handed to validateSet.
const dex = Dex.forGen(9).includeData();
const toId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const getItem = (name: string) => dex.items.get(name);

// Map: speciesId -> list of mega stone item names that turn it into a mega.
// Built once on module load by walking every item in the dex.
const stonesBySpecies = (() => {
  const out = new Map<string, string[]>();
  for (const item of dex.items.all()) {
    const stone = (item as any).megaStone as Record<string, string> | undefined;
    if (!stone) continue;
    for (const baseSpecies of Object.keys(stone)) {
      const sid = toId(baseSpecies);
      if (!out.has(sid)) out.set(sid, []);
      out.get(sid)!.push(item.name);
    }
  }
  return out;
})();

// Map: itemId -> mega forme name keyed by base-species id. e.g. the entry for
// "charizarditey" maps base "charizard" -> "Charizard-Mega-Y". Used by
// resolveSpecies() to find the right forme name to hand to @smogon/calc.
const megaFormeByItem = (() => {
  const out = new Map<string, Map<string, string>>();
  for (const item of dex.items.all()) {
    const stone = (item as any).megaStone as Record<string, string> | undefined;
    if (!stone) continue;
    const inner = new Map<string, string>();
    for (const [baseSpecies, megaForme] of Object.entries(stone)) {
      inner.set(toId(baseSpecies), megaForme);
    }
    out.set(toId(item.name), inner);
  }
  return out;
})();

function holdingMegaStone(itemName: string | undefined): boolean {
  if (!itemName) return false;
  const item = getItem(itemName);
  return !!item && !!(item as any).megaStone;
}

function stoneMatchesSpecies(itemName: string, speciesName: string): boolean {
  const item = getItem(itemName);
  const stone = item && ((item as any).megaStone as Record<string, string> | undefined);
  if (!stone) return false;
  const sid = toId(speciesName);
  return Object.keys(stone).some(s => toId(s) === sid);
}

export const megaGimmick: Gimmick = {
  id: 'mega',
  label: 'Mega Evolution',

  // @smogon/calc does NOT auto-resolve the mega forme from the held stone — it
  // keys purely on the species name passed to `new Pokemon(...)`. So when a set
  // holds a legal mega stone we swap in the mega forme name (e.g. Charizard +
  // Charizardite Y -> "Charizard-Mega-Y") so damage/stat calcs reflect mega.
  // If a future ruleset requires opt-in mega (held stone but not activated
  // this turn), gate this on `active`.
  resolveSpecies({ set }) {
    if (!set.item) return null;
    const inner = megaFormeByItem.get(toId(set.item));
    if (!inner) return null;
    return inner.get(toId(set.species)) ?? null;
  },

  enumerateOpponentVariants(speciesId) {
    const sid = toId(speciesId);
    const stones = stonesBySpecies.get(sid) ?? [];
    return stones.map(stone => ({ item: stone }));
  },

  battleControl(set, active) {
    if (active) return null;
    if (!holdingMegaStone(set.item)) return null;
    return { hotkey: 'm', label: 'Mega Evolve' };
  },

  validateSet(set, format) {
    if (!set.item) return [];
    const item = getItem(set.item);
    if (!item || !(item as any).megaStone) return [];
    const errors: string[] = [];
    const itemId = toId(set.item);
    const banned = format.items.ban.map(toId).includes(itemId);
    const allowedList = format.items.allow.map(toId);
    const isAllowed = allowedList.length === 0 || allowedList.includes(itemId);
    if (banned || !isAllowed) {
      errors.push(`${set.species}: ${set.item} is not in the legal item list.`);
    }
    if (!stoneMatchesSpecies(set.item, set.species)) {
      errors.push(`${set.species} cannot hold ${set.item} — wrong species.`);
    }
    return errors;
  },

  describeSet(set) {
    return holdingMegaStone(set.item) ? `Mega (stone: ${set.item})` : null;
  },
};
