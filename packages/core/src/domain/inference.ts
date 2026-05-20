import type { DamageObservation, PokemonSet, Stats } from './types.js';
import { damageRange, observationToAbsoluteDamage } from './damage.js';
import { getSpecies, toId } from './data.js';
import { activeGimmick } from './gimmicks/index.js';
import { getPikalytics, evFromSp } from './pikalytics.js';

// The inverse problem: given an observed damage event, find which (EVs, nature,
// item, ability) combinations of the defender are consistent with what we saw.
//
// We don't search the full 252^3 EV space — instead we enumerate a coarse grid
// of investment buckets (0, 4, 84, 124, 156, 196, 252) on HP/Def/SpD plus the
// most common defensive-natured cases. That covers ~98% of real VGC builds.

// 9-bucket grid aligned to PoChamps stat points: SP values [0, 4, 8, 12, 16,
// 20, 24, 28, 32] mapped through evFromSp. ~2.1× the search cost of the old
// 7-bucket grid but it covers the meaningful PoChamps stat resolution (each
// SP step changes the stat by 1 at L50 / 31 IVs).
const COARSE_EVS = [0, 4, 8, 12, 16, 20, 24, 28, 32].map(sp => sp === 0 ? 0 : 4 + (sp - 1) * 8);

const NATURES_TO_TRY = [
  'Bold',     // +Def, -Atk
  'Impish',   // +Def, -SpA
  'Careful',  // +SpD, -SpA
  'Calm',     // +SpD, -Atk
  'Sassy',    // +SpD, -Spe
  'Relaxed',  // +Def, -Spe
  'Modest',
  'Timid',
  'Adamant',
  'Jolly',
  'Hardy',    // neutral
];

const COMMON_DEFENSIVE_ITEMS: (string | undefined)[] = [
  undefined,
  'Assault Vest',
  'Sitrus Berry',
  'Leftovers',
  'Rocky Helmet',
  'Eviolite',
  'Covert Cloak',
  'Safety Goggles',
  'Clear Amulet',
  'Booster Energy',
  'Choice Scarf',
  'Choice Specs',
  'Choice Band',
  'Life Orb',
  'Focus Sash',
];

export interface SpreadCandidate {
  evs: Stats;
  nature: string;
  item?: string;
  ability?: string;
}

function fullSet(species: string, c: SpreadCandidate, level: number, moves: string[]): PokemonSet {
  return {
    species,
    level,
    item: c.item,
    ability: c.ability,
    nature: c.nature,
    evs: c.evs,
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    moves,
  };
}

export interface InferenceInput {
  defenderSpecies: string;
  defenderLevel: number;
  knownDefenderMoves: string[];
  attackerSet: PokemonSet;
  observation: DamageObservation;
  // Tighten priors with anything we already know.
  priorItems?: string[];          // restrict to these items
  priorAbilities?: string[];      // restrict to these abilities
  priorNatures?: string[];        // restrict to these
  // If already narrowed from earlier observations, start from this set.
  startingCandidates?: SpreadCandidate[];
}

export function inferSpread(input: InferenceInput): SpreadCandidate[] {
  const species = getSpecies(input.defenderSpecies);
  const speciesName: string = species?.name ?? input.defenderSpecies;
  const possibleAbilities: string[] = input.priorAbilities ??
    (species?.abilities ? Object.values(species.abilities) as string[] : ['']);

  // Item search space: the standard defensive items + any gimmick-specific
  // variants (e.g. mega stones legal for this species).
  const baseItems = input.priorItems ?? COMMON_DEFENSIVE_ITEMS.map(x => x ?? '');
  const gimmickItems = (activeGimmick().enumerateOpponentVariants?.(toId(input.defenderSpecies)) ?? [])
    .map(v => v.item)
    .filter((i): i is string => !!i);
  const items = Array.from(new Set([...baseItems, ...gimmickItems]));
  const natures = input.priorNatures ?? NATURES_TO_TRY;

  // Pikalytics priors: if the species is in our cached top-N, build narrower
  // candidates from the top items × top abilities × the top spread/nature.
  // Try these *first*; if none survive the observation, fall back to the
  // coarse grid (so off-meta opponents still work).
  const priorCandidates = priorsFromPikalytics(speciesName);
  let candidates: SpreadCandidate[];
  if (input.startingCandidates) {
    candidates = input.startingCandidates;
  } else if (priorCandidates.length) {
    candidates = priorCandidates;
  } else {
    candidates = generateCoarseCandidates({ natures, items, abilities: possibleAbilities });
  }

  const tryList = (list: SpreadCandidate[]) => {
    const kept: SpreadCandidate[] = [];
    for (const c of list) {
      const defenderSet = fullSet(speciesName, c, input.defenderLevel, input.knownDefenderMoves);
      let predicted;
      try {
        predicted = damageRange({
          attacker: input.attackerSet,
          defender: defenderSet,
          move: input.observation.move,
          field: input.observation.field,
          attackerSide: input.observation.attackerSide,
          attackerOpts: { boosts: input.observation.attackerBoosts as any },
          defenderOpts: { boosts: input.observation.defenderBoosts as any },
          helpingHand: input.observation.helpingHand,
          critical: input.observation.critical,
        });
      } catch { continue; }
      const obs = observationToAbsoluteDamage(input.observation, defenderSet);
      if (predicted.max >= obs.lo && predicted.min <= obs.hi) kept.push(c);
    }
    return kept;
  };

  const fromPriors = tryList(candidates);
  if (fromPriors.length) return fromPriors;
  // Priors gave nothing — fall back to the coarse grid (only if we were
  // running on priors; if we were already on the coarse grid, there's no
  // wider net to cast).
  if (!input.startingCandidates && candidates === priorCandidates) {
    return tryList(generateCoarseCandidates({ natures, items, abilities: possibleAbilities }));
  }
  return [];
}

// Build candidates from Pikalytics' top items × top abilities × the single top
// spread. Top items are filtered to remove "Other" buckets and capped at 4 to
// avoid explosion. Returns [] when the species isn't cached or has no spread.
function priorsFromPikalytics(speciesName: string): SpreadCandidate[] {
  const pik = getPikalytics(speciesName);
  if (!pik || !pik.topSpread) return [];
  const spread = pik.topSpread;
  const evs: Stats = {
    hp: evFromSp(spread.sp[0]),
    atk: evFromSp(spread.sp[1]),
    def: evFromSp(spread.sp[2]),
    spa: evFromSp(spread.sp[3]),
    spd: evFromSp(spread.sp[4]),
    spe: evFromSp(spread.sp[5]),
  };
  const topItems = pik.items.filter(i => i.name.toLowerCase() !== 'other').slice(0, 4).map(i => i.name);
  const topAbilities = pik.abilities.filter(a => a.name.toLowerCase() !== 'other').slice(0, 3).map(a => a.name);
  const items = topItems.length ? topItems : [''];
  const abilities = topAbilities.length ? topAbilities : [''];
  const out: SpreadCandidate[] = [];
  for (const item of items) {
    for (const ability of abilities) {
      out.push({ evs, nature: spread.nature, item: item || undefined, ability: ability || undefined });
    }
  }
  return out;
}

function generateCoarseCandidates(opts: {
  natures: string[];
  items: string[];
  abilities: string[];
}): SpreadCandidate[] {
  const out: SpreadCandidate[] = [];
  for (const hp of COARSE_EVS) {
    for (const def of COARSE_EVS) {
      for (const spd of COARSE_EVS) {
        const total = hp + def + spd;
        if (total > 508) continue; // EV budget
        for (const nature of opts.natures) {
          for (const item of opts.items) {
            for (const ability of opts.abilities) {
              out.push({
                evs: { hp, atk: 0, def, spa: 0, spd, spe: 0 },
                nature,
                item: item || undefined,
                ability: ability || undefined,
              });
            }
          }
        }
      }
    }
  }
  return out;
}

// Pick a "most likely" representative from a candidate set: prefer minimal EV
// investment and most common items/natures. Cheap heuristic — refine later.
export function mostLikely(candidates: SpreadCandidate[]): SpreadCandidate | null {
  if (!candidates.length) return null;
  const scored = candidates.map(c => {
    const totalEvs = c.evs.hp + c.evs.def + c.evs.spd;
    const itemPenalty = c.item ? 0 : 5;
    const naturePenalty = c.nature === 'Hardy' ? 10 : 0;
    return { c, score: totalEvs + itemPenalty + naturePenalty };
  });
  scored.sort((a, b) => a.score - b.score);
  return scored[0]?.c ?? null;
}
