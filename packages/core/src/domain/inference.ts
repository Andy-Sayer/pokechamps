import type { DamageObservation, PokemonSet, Stats } from './types.js';
import { damageRange, observationToAbsoluteDamage } from './damage.js';
import { getSpecies, getMove, toId } from './data.js';
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

export interface ScoredCandidate {
  candidate: SpreadCandidate;
  // P(observation | candidate): the fraction of the candidate's damage rolls
  // that land in the observed bucket. >0 means the hard filter keeps it.
  likelihood: number;
  within: boolean;
}

// How well does a candidate's predicted roll distribution explain the observed
// damage? In-range candidates get a real probability (rolls-in-bucket / total);
// out-of-range candidates get a tiny negative score scaled by distance, so the
// Hybrid fallback can still rank "least wrong" first without ever beating a
// genuine in-range fit.
function candidateLikelihood(rolls: number[], lo: number, hi: number): number {
  if (!rolls.length) return 0;
  const within = rolls.filter(r => r >= lo && r <= hi).length;
  if (within > 0) return within / rolls.length;
  const mid = (lo + hi) / 2;
  let nearest = Infinity;
  for (const r of rolls) nearest = Math.min(nearest, Math.abs(r - mid));
  return -nearest / 1e6; // always below any positive (in-range) score
}

// Hybrid fallback width: when the hard filter empties, keep this many of the
// closest-fitting candidates rather than returning nothing.
const HYBRID_FALLBACK_K = 8;

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
  // Skip the exhaustive coarse-grid fallback (~360k spreads × @smogon/calc =
  // tens of seconds). Server-side request handlers set this to keep response
  // latency bounded; the TUI omits it so off-meta opps still get inferred.
  // When skipped, an inference that exhausts the priors returns [].
  quickOnly?: boolean;
  // Item signals: exclude Safety Goggles if the mon has taken sand chip damage.
  sandChipObserved?: boolean;
}

// Plain candidate list (likelihood order preserved). Most callers want this.
export function inferSpread(input: InferenceInput): SpreadCandidate[] {
  return scoreSpread(input).map(s => s.candidate);
}

// Scored variant — returns each surviving candidate with its likelihood,
// ordered best-first. finalizeTurn persists these so "most likely" can pick by
// score (vs the minimal-EV heuristic).
export function scoreSpread(input: InferenceInput): ScoredCandidate[] {
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
  let items = Array.from(new Set([...baseItems, ...gimmickItems]));
  // Item signals: exclude Safety Goggles if we've observed sand chip damage.
  if (input.sandChipObserved) {
    items = items.filter(i => i !== 'Safety Goggles');
  }
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

  // Score every candidate: predicted damage vs observed, keeping both the
  // hard in/out verdict and a likelihood for ranking + Hybrid fallback.
  const evaluate = (list: SpreadCandidate[]): ScoredCandidate[] => {
    const out: ScoredCandidate[] = [];
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
      const within = predicted.max >= obs.lo && predicted.min <= obs.hi;
      out.push({ candidate: c, within, likelihood: candidateLikelihood(predicted.rolls, obs.lo, obs.hi) });
    }
    return out;
  };

  const withinSorted = (scored: ScoredCandidate[]): ScoredCandidate[] =>
    scored.filter(s => s.within).sort((a, b) => b.likelihood - a.likelihood);

  const scoredPriors = evaluate(candidates);
  const keptPriors = withinSorted(scoredPriors);
  if (keptPriors.length) return keptPriors;

  // Hard filter on the chosen set emptied. If we were on Pikalytics priors (not
  // a chained/started set) and allowed, cast the wider coarse-grid net first.
  let scoredFallback = scoredPriors;
  if (!input.startingCandidates && candidates === priorCandidates && !input.quickOnly) {
    const scoredCoarse = evaluate(generateCoarseCandidates({ natures, items, abilities: possibleAbilities }));
    const keptCoarse = withinSorted(scoredCoarse);
    if (keptCoarse.length) return keptCoarse;
    scoredFallback = scoredCoarse;
  }

  // Hybrid: never return nothing. Keep the closest-fitting candidates so the UI
  // shows a (best-effort) spread and a contradictory observation recovers
  // instead of leaving an empty candidate set.
  return scoredFallback
    .sort((a, b) => b.likelihood - a.likelihood)
    .slice(0, HYBRID_FALLBACK_K);
}

// Offensive inference. The defensive solver (scoreSpread) only ever varies
// HP/Def/SpD; the opponent's Atk/SpA are otherwise left at the Pikalytics prior
// (or 0). When the OPPONENT lands a damaging move on one of MY known mons we can
// run the mirror problem: hold my mon fixed (known) and find which of the
// opponent's offensive-stat (Atk for physical, SpA for special) investments
// reproduce the observed damage. Each existing candidate keeps its inferred
// bulk/nature/item; we assign the offensive-stat buckets consistent with the
// hit (and drop a candidate whose nature/item can't reach the damage at all —
// e.g. a -Atk nature ruled out by a big physical hit). Returns the refined
// candidate set; a no-op (returns the input) for moves whose damage doesn't
// scale with the attacker's offensive stat.
export function scoreOffensiveSpread(input: {
  attackerSpecies: string;
  attackerLevel: number;
  startingCandidates: SpreadCandidate[];
  attackerMoves: string[];
  move: string;
  defenderSet: PokemonSet;       // my known mon (the target)
  observation: DamageObservation;
}): ScoredCandidate[] {
  const m = getMove(input.move) as {
    category?: string; damage?: unknown; overrideOffensiveStat?: unknown; overrideOffensivePokemon?: unknown;
  } | undefined;
  const passthrough = (): ScoredCandidate[] =>
    input.startingCandidates.map(c => ({ candidate: c, within: true, likelihood: 0 }));
  // Only standard Physical/Special moves whose damage scales with the user's
  // Atk/SpA. Skip status, fixed-damage (Seismic Toss…), Body Press (uses Def),
  // and Foul Play (uses the target's Atk).
  if (!m || (m.category !== 'Physical' && m.category !== 'Special')) return passthrough();
  if (m.damage || m.overrideOffensiveStat || m.overrideOffensivePokemon === 'target') return passthrough();
  const stat: keyof Stats = m.category === 'Physical' ? 'atk' : 'spa';

  const obs = observationToAbsoluteDamage(input.observation, input.defenderSet);
  const out: ScoredCandidate[] = [];
  for (const c of input.startingCandidates) {
    const otherTotal = (Object.values(c.evs) as number[]).reduce((a, b) => a + b, 0) - c.evs[stat];
    for (const ev of COARSE_EVS) {
      if (otherTotal + ev > 508) break; // budget; COARSE_EVS ascends so the rest also fail
      const cand: SpreadCandidate = { ...c, evs: { ...c.evs, [stat]: ev } };
      const attacker = fullSet(input.attackerSpecies, cand, input.attackerLevel, input.attackerMoves);
      let predicted;
      try {
        predicted = damageRange({
          attacker,
          defender: input.defenderSet,
          move: input.move,
          field: input.observation.field,
          attackerSide: 'theirs',
          attackerOpts: { gimmickActive: input.observation.attackerGimmickActive, boosts: input.observation.attackerBoosts as any },
          defenderOpts: { gimmickActive: input.observation.defenderGimmickActive, boosts: input.observation.defenderBoosts as any },
          helpingHand: input.observation.helpingHand,
          critical: input.observation.critical,
        });
      } catch { continue; }
      const within = predicted.max >= obs.lo && predicted.min <= obs.hi;
      if (within) out.push({ candidate: cand, within: true, likelihood: candidateLikelihood(predicted.rolls, obs.lo, obs.hi) });
    }
  }
  if (!out.length) return passthrough(); // contradictory/odd hit — keep prior belief
  return out.sort((a, b) => b.likelihood - a.likelihood);
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

// Index of the "most likely" spread in a candidate set. Per the minimum-stat-
// points principle, the headline estimate is the LEAST-invested spread still
// consistent with observations (people run the minimum that hits benchmarks),
// so we rank by total defensive investment ascending (+ small item/nature
// priors). Per-candidate likelihoods, when present, only break investment ties
// — the better roll-fit among equally-invested spreads. Returns -1 if empty.
export function mostLikelyIndex(candidates: SpreadCandidate[], likelihoods?: number[]): number {
  if (!candidates.length) return -1;
  const invest = (c: SpreadCandidate) =>
    (c.evs.hp + c.evs.def + c.evs.spd) + (c.item ? 0 : 5) + (c.nature === 'Hardy' ? 10 : 0);
  let best = 0;
  for (let i = 1; i < candidates.length; i++) {
    const di = invest(candidates[i]!) - invest(candidates[best]!);
    if (di < -1e-9) { best = i; continue; }
    if (Math.abs(di) <= 1e-9 && likelihoods && (likelihoods[i] ?? 0) > (likelihoods[best] ?? 0)) best = i;
  }
  return best;
}

export function mostLikely(candidates: SpreadCandidate[], likelihoods?: number[]): SpreadCandidate | null {
  const i = mostLikelyIndex(candidates, likelihoods);
  return i < 0 ? null : candidates[i]!;
}
