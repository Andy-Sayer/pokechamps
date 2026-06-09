import type { FieldState } from './types.js';
import { getSpecies, getMove, toId } from './data.js';

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
  // Download: on switch-in, boost the higher of the opponent's defenses.
  // The exact calculation (+1 Atk or +1 SpA) depends on comparing opponent's Def vs SpD.
  download?: boolean;
  // Trace: copy an opponent's ability on switch-in. The engine applies this
  // by copying the ability from one of the opposing actives.
  trace?: boolean;
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
  if (ability === 'Download') e.download = true;
  if (ability === 'Trace') e.trace = true;
  return e.intimidate || e.weather || e.terrain || e.selfBoosts || e.download || e.trace ? e : null;
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

// Guaranteed (100%) stat-drop a DAMAGING move inflicts on its TARGET: Icy Wind /
// Electroweb / Bulldoze −1 Spe, Snarl / Struggle Bug −1 SpA, Breaking Swipe −1 Atk,
// Low Sweep −1 Spe, Lunge −1 Atk, Acid Spray −2 SpD. Reads `move.secondary.boosts`
// only when the chance is 100 (probabilistic 10–30% drops like Crunch/Liquidation
// are policy-excluded, same as flinch). Negatives only; null if none.
export function foeDropOf(move: string): BoostMap | null {
  const sec = (getMove(move) as { secondary?: { chance?: number; boosts?: Record<string, number> } } | undefined)?.secondary;
  if (!sec || sec.chance !== 100 || !sec.boosts) return null;
  const out: BoostMap = {};
  for (const k of ['atk', 'def', 'spa', 'spd', 'spe'] as const) if ((sec.boosts[k] ?? 0) < 0) out[k] = sec.boosts[k]!;
  return Object.keys(out).length ? out : null;
}

// Abilities/items that block an OPPONENT-inflicted stat drop entirely (no drop, no
// Defiant trigger). Hyper Cutter / Big Pecks (stat-specific) are a documented omission.
const STAT_IMMUNE_ABILITIES = new Set(['clearbody', 'whitesmoke', 'fullmetalbody']);
export function statDropImmune(ability: string | null | undefined, item: string | null | undefined): boolean {
  return STAT_IMMUNE_ABILITIES.has(toId(ability ?? '')) || /clear\s*amulet/i.test(item ?? '');
}

// The stat a mon raises +2 when the OPPONENT lowers one of its stats: Defiant → Atk,
// Competitive → SpA. null otherwise.
export function defiantStat(ability: string | null | undefined): 'atk' | 'spa' | null {
  const a = toId(ability ?? '');
  if (a === 'defiant') return 'atk';
  if (a === 'competitive') return 'spa';
  return null;
}

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

// Download boost resolution: which stat should be boosted (+1 Atk or +1 SpA)?
// Compares the opponent's Def vs SpD; boosts the corresponding offensive stat
// for the one that is lower (Def lower → +1 Atk, SpD lower → +1 SpA).
// If Def == SpD, Atk is boosted (game rule: Atk takes the tiebreaker).
export interface DownloadBoost {
  stat: 'atk' | 'spa';
  lowerDefense: 'def' | 'spd'; // which defense was lower
}

export function resolveDownloadBoost(defenderDef: number, defenderSpd: number): DownloadBoost {
  if (defenderSpd < defenderDef) {
    return { stat: 'spa', lowerDefense: 'spd' };
  }
  // Def <= SpD: boost Atk (tiebreaker)
  return { stat: 'atk', lowerDefense: 'def' };
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
