import type { Gimmick } from './types.js';
import { Dex } from '@pkmn/dex';

// Kept independent of ../data.ts on purpose — pulling in the data layer would
// create a circular import (data.ts registers this module's resolver during
// initialization). Mega only needs the dex directly and the format that's
// already handed to validateSet.
const dex = Dex.forGen(9).includeData();
const toId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const getItem = (name: string) => dex.items.get(name);

// Champions custom mega abilities that @pkmn/dex still ships as PLACEHOLDERS
// (the base-forme ability), so the calc would miss their DAMAGE-affecting effect.
// Keyed by mega forme name. Keep in sync with refresh-data's SPECIES_PATCHES (our
// data layer) and the emulation in damage.ts. Fire Mane → ×1.5 Fire override;
// Eelevate → aliased to Levitate by the calc for the Ground immunity; Contrary
// (Mega Staraptor) is a STANDARD ability needing no emulation — the search already
// inverts self-stat-drops via hasContrary (so Close Combat boosts its Def/SpD). (The
// Raichu X/Y customs are NOT here — Electric Surge / No Guard don't affect damage.)
export const MEGA_ABILITY_OVERRIDES: Record<string, string> = {
  'Pyroar-Mega': 'Fire Mane',          // custom effect — emulated in damage.ts (×1.5 Fire)
  'Eelektross-Mega': 'Eelevate',       // custom effect — Levitate immunity + Beast Boost snowball
  // The rest are STANDARD abilities (effects handled natively by calc/search); pinned
  // here only to override @pkmn/dex's placeholders. Confirmed 2026-06-18 (The Game
  // Haus / Pokéos / PLDH); Staraptor=Contrary independently seen in live footage.
  'Staraptor-Mega': 'Contrary',
  'Scolipede-Mega': 'Shell Armor',
  'Scrafty-Mega': 'Intimidate',
  'Malamar-Mega': 'Contrary',
  'Barbaracle-Mega': 'Tough Claws',
  'Dragalge-Mega': 'Regenerator',
  'Falinks-Mega': 'Defiant',
};

// The ability a mega forme fights with — our override (for the customs @pkmn/dex
// still ships as placeholders) else the dex's slot-0. Shared by enrichCalcPokemon
// (calc) and the search (Beast Boost / Eelevate snowball off the resolved ability).
export function megaFormeAbility(forme: string): string | undefined {
  return MEGA_ABILITY_OVERRIDES[forme]
    ?? ((dex.species.get(forme) as any)?.abilities as Record<string, string> | undefined)?.['0'];
}

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

// Map: speciesId -> Array of { forme, stone, variant } for every mega forme
// the species has. variant is the trailing 'X' / 'Y' / '' (Charizard-Mega-Y
// → 'Y'; Lucario-Mega → ''). Used by the parser to disambiguate
// "m1 mega y" vs "m1 mega x" and to power the standalone mega action.
export interface MegaOption {
  /** Full mega forme species name, e.g. "Charizard-Mega-Y". */
  forme: string;
  /** Item name that triggers this forme, e.g. "Charizardite Y". */
  stone: string;
  /** Variant tag if any, lowercased: 'x' / 'y' / '' (no variant). */
  variant: string;
}
const megaOptionsBySpecies = (() => {
  const out = new Map<string, MegaOption[]>();
  for (const item of dex.items.all()) {
    const stone = (item as any).megaStone as Record<string, string> | undefined;
    if (!stone) continue;
    for (const [baseSpecies, megaForme] of Object.entries(stone)) {
      const sid = toId(baseSpecies);
      const list = out.get(sid) ?? [];
      // Variant: trailing suffix after the last hyphen if it's a single
      // letter (X/Y), else empty. Charizard-Mega-Y → 'y'; Lucario-Mega → ''.
      const match = megaForme.match(/-(?:Mega|Primal)-([A-Z])$/i);
      const variant = match ? match[1]!.toLowerCase() : '';
      list.push({ forme: megaForme, stone: item.name, variant });
      out.set(sid, list);
    }
  }
  return out;
})();

// Public: list mega formes available for a species. Empty if none.
export function getMegaOptions(speciesName: string): readonly MegaOption[] {
  return megaOptionsBySpecies.get(toId(speciesName)) ?? [];
}

// Public: pick the right mega forme given a variant hint. variant === ''
// means "auto" — if only one option exists return it, else null (caller
// must surface a disambiguation error). If variant is 'x' / 'y' / etc.
// match the option whose variant tag agrees.
export function resolveMegaForme(
  speciesName: string,
  variant: string,
): MegaOption | null {
  const opts = getMegaOptions(speciesName);
  if (opts.length === 0) return null;
  const v = variant.toLowerCase();
  if (v === '') {
    if (opts.length === 1) return opts[0]!;
    return null;
  }
  return opts.find(o => o.variant === v) ?? null;
}

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
  // keys purely on the species name passed to `new Pokemon(...)`. So when the
  // mon has actually mega-evolved this battle (`active: true`) we swap in the
  // mega forme name (e.g. Charizard + Charizardite Y -> "Charizard-Mega-Y").
  // Before activation the mon is still in its base forme — base-stats, base-
  // ability — even though the stone is held; in that case we leave the
  // species alone so damage/speed reflect the pre-mega reality. The matchup
  // grid surfaces the post-mega numbers separately as a "potential mega"
  // alternative.
  resolveSpecies({ set, active }) {
    if (!active) return null;
    if (!set.item) return null;
    const inner = megaFormeByItem.get(toId(set.item));
    if (!inner) return null;
    return inner.get(toId(set.species)) ?? null;
  },

  // On mega evolution the ability becomes the mega forme's ability. A team set
  // carries the BASE forme's ability, so once the mon is actually mega'd we
  // override it for the calc — otherwise damage-affecting mega abilities (Tough
  // Claws, Aerilate, Mega Launcher, Pixilate, Adaptability, Filter, Thick Fat,
  // Multiscale, …) and the format's custom ones are silently dropped from both
  // offensive and defensive calculations.
  enrichCalcPokemon({ set, active, opts }) {
    if (!active || !set.item) return;
    const forme = megaFormeByItem.get(toId(set.item))?.get(toId(set.species));
    if (!forme) return;
    const ability = megaFormeAbility(forme);
    if (ability) opts.ability = ability;
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
