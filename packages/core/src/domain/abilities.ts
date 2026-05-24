import type { FieldState } from './types.js';
import { getSpecies } from './data.js';

// Switch-in ability effects (A.2). On entry some abilities change the battle
// state without any move being used: Intimidate drops foe Attack, weather
// setters change the weather, terrain setters change the terrain, and a few
// (Intrepid Sword / Dauntless Shield) self-boost. These feed straight into the
// damage calc — `damage.ts` reads `field.weather` / `field.terrain` and the
// boost maps — so applying them on switch-in makes the matchup grid reflect
// reality instead of always assuming a neutral field.
//
// Side-agnostic by design (mirrors `hazards.ts`): this module describes the
// effect of an ability; `match/engine.ts` decides which side it lands on and
// mutates the Match.

export type BoostMap = Partial<Record<'atk' | 'def' | 'spa' | 'spd' | 'spe', number>>;

export interface SwitchInAbilityEffect {
  // Boosts applied to the incoming mon itself (Intrepid Sword etc.).
  selfBoosts?: BoostMap;
  // Intimidate: -1 Atk to each opposing active. The engine applies it per-foe,
  // consulting each foe's ability for immunity / retaliation.
  intimidate?: boolean;
  // Weather to set on the field.
  weather?: NonNullable<FieldState['weather']>;
  // Terrain to set on the field.
  terrain?: NonNullable<FieldState['terrain']>;
}

// Snow Warning sets Snow in gen 9 (not Hail). Sand Stream → Sand, Drought →
// Sun, Drizzle → Rain. The signature-legendary weathers are included so a
// confirmed Groudon/Kyogre reads correctly, even if they're off-format today.
const WEATHER_SETTERS: Record<string, NonNullable<FieldState['weather']>> = {
  Drought: 'Sun',
  'Orichalcum Pulse': 'Sun',
  Drizzle: 'Rain',
  'Sand Stream': 'Sand',
  'Snow Warning': 'Snow',
  'Desolate Land': 'Harsh Sunshine',
  'Primordial Sea': 'Heavy Rain',
};

const TERRAIN_SETTERS: Record<string, NonNullable<FieldState['terrain']>> = {
  'Electric Surge': 'Electric',
  'Hadron Engine': 'Electric',
  'Grassy Surge': 'Grassy',
  'Misty Surge': 'Misty',
  'Psychic Surge': 'Psychic',
};

const SELF_BOOST_ABILITIES: Record<string, BoostMap> = {
  'Intrepid Sword': { atk: 1 },
  'Dauntless Shield': { def: 1 },
};

// What does this ability do the moment its owner switches in? Returns null for
// abilities with no switch-in state effect (the common case).
export function switchInAbilityEffect(
  ability: string | undefined | null,
): SwitchInAbilityEffect | null {
  if (!ability) return null;
  const e: SwitchInAbilityEffect = {};
  if (ability === 'Intimidate') e.intimidate = true;
  const w = WEATHER_SETTERS[ability];
  if (w) e.weather = w;
  const t = TERRAIN_SETTERS[ability];
  if (t) e.terrain = t;
  const sb = SELF_BOOST_ABILITIES[ability];
  if (sb) e.selfBoosts = sb;
  return e.intimidate || e.weather || e.terrain || e.selfBoosts ? e : null;
}

// How a foe reacts to an incoming Intimidate.
export interface IntimidateReaction {
  blocked: boolean; // Atk drop prevented entirely
  reaction?: BoostMap; // boost the foe gains in response (Defiant etc.)
}

// Abilities that stop the Intimidate Atk drop. Clear Body / White Smoke /
// Full Metal Body block all stat drops; Hyper Cutter blocks Atk specifically;
// Inner Focus / Oblivious / Own Tempo / Scrappy ignore Intimidate (gen 8+).
const INTIMIDATE_IMMUNE = new Set([
  'Clear Body', 'White Smoke', 'Full Metal Body',
  'Hyper Cutter',
  'Inner Focus', 'Oblivious', 'Own Tempo', 'Scrappy',
]);

export function intimidateReaction(
  foeAbility: string | undefined | null,
): IntimidateReaction {
  if (!foeAbility) return { blocked: false };
  if (INTIMIDATE_IMMUNE.has(foeAbility)) return { blocked: true };
  // Guard Dog: Intimidate raises Atk instead of lowering it.
  if (foeAbility === 'Guard Dog') return { blocked: true, reaction: { atk: 1 } };
  // Defiant / Competitive: drop still lands, plus a retaliatory boost.
  if (foeAbility === 'Defiant') return { blocked: false, reaction: { atk: 2 } };
  if (foeAbility === 'Competitive') return { blocked: false, reaction: { spa: 2 } };
  if (foeAbility === 'Rattled') return { blocked: false, reaction: { spe: 1 } };
  return { blocked: false };
}

// Resolve the ability to attribute to a (possibly opponent) mon switching in.
// My own sets always know their ability. For opponents the ability is only
// certain when we've observed it (`knownAbility`) OR the species has exactly
// one possible ability in the dex — otherwise we return undefined so the
// engine doesn't apply a switch-in effect the mon might not have.
export function certainAbility(opts: {
  knownAbility?: string | null;
  species: string;
}): string | undefined {
  if (opts.knownAbility) return opts.knownAbility;
  const sp = getSpecies(opts.species) as any;
  const ab = sp?.abilities;
  if (ab && ab['0'] && ab['1'] === undefined && ab['H'] === undefined && ab['S'] === undefined) {
    return ab['0'] as string;
  }
  return undefined;
}
