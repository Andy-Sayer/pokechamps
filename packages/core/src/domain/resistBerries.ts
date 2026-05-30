// "Resist berries" — the type-matchup berries that halve a super-effective hit
// of their matching type, ONCE, then consume themselves. Heavy use in this
// format (Champions), so they belong in the inference candidate pool for any
// mon weak to the matching type. Mons that aren't weak to a type don't carry
// the matching resist berry, so we don't include it for them.
//
// Plain damage calc: passing the berry as the held item makes @smogon/calc
// apply the 0.5x reduction on the right type — no special handling needed
// beyond surfacing the item in candidates and tracking consumption.

import { effectiveness, speciesTypes } from './typechart.js';
import { getSpecies } from './data.js';

const RESIST_BERRY_BY_TYPE: Readonly<Record<string, string>> = {
  Normal: 'Chilan Berry',   // halves a Normal hit even at neutral effectiveness
  Fire: 'Occa Berry',
  Water: 'Passho Berry',
  Electric: 'Wacan Berry',
  Grass: 'Rindo Berry',
  Ice: 'Yache Berry',
  Fighting: 'Chople Berry',
  Poison: 'Kebia Berry',
  Ground: 'Shuca Berry',
  Flying: 'Coba Berry',
  Psychic: 'Payapa Berry',
  Bug: 'Tanga Berry',
  Rock: 'Charti Berry',
  Ghost: 'Kasib Berry',
  Dragon: 'Haban Berry',
  Dark: 'Colbur Berry',
  Steel: 'Babiri Berry',
  Fairy: 'Roseli Berry',
};

/** The resist berry for a specific attacking type, or undefined. */
export function resistBerryForType(attackingType: string): string | undefined {
  return RESIST_BERRY_BY_TYPE[attackingType];
}

/**
 * Resist berries plausibly held by a species — the ones whose matching type is
 * SUPER-EFFECTIVE against it. Chilan (Normal) is included regardless because
 * it halves Normal hits even at neutral effectiveness — its niche is exactly
 * mons not otherwise resistant to Normal.
 */
export function resistBerriesForSpecies(speciesName: string): string[] {
  // @pkmn/dex's species.get returns an exists:false stub with default types for
  // unknown names, so check existence directly — otherwise Chilan would be
  // returned for any garbage species string.
  if ((getSpecies(speciesName) as { exists?: boolean } | undefined)?.exists === false) return [];
  const types = speciesTypes(speciesName);
  if (!types.length) return [];
  const out: string[] = [];
  for (const atkType of Object.keys(RESIST_BERRY_BY_TYPE)) {
    const e = effectiveness(atkType, types);
    if (e > 1) out.push(RESIST_BERRY_BY_TYPE[atkType]!);    // SE
    else if (atkType === 'Normal' && e === 1) out.push(RESIST_BERRY_BY_TYPE.Normal!); // Chilan exception
  }
  return out;
}
