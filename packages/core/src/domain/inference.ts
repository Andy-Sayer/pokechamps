import type { DamageObservation, PokemonSet, Stats } from './types.js';
import { damageRange, observationToAbsoluteDamage, maxHpFor } from './damage.js';
import { getSpecies, getMove, isLegalItem, toId } from './data.js';
import { activeGimmick } from './gimmicks/index.js';
import { getPikalytics, evFromSp } from './pikalytics.js';
import { resistBerriesForSpecies } from './resistBerries.js';

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
  'Modest',   // +SpA, -Atk
  'Timid',    // +Spe, -Atk
  'Adamant',  // +Atk, -SpA
  'Jolly',    // +Spe, -SpA
  'Brave',    // +Atk, -Spe — Trick Room physical attackers
  'Quiet',    // +SpA, -Spe — Trick Room special attackers
  'Hardy',    // neutral
];

// The +Atk / +SpA nature CLASSES for the extreme-hit promotion: a huge observed hit
// proves the 1.1× on the attacking stat but says NOTHING about which stat the nature
// docks — Adamant(-SpA) and Brave(-Spe) deal identical damage. Promote to the class
// (the two variants that exist in practice) and let speed reads / later observations
// discriminate. What downstream actually consumes is the implied STATS, so an
// unresolved minus-stat stays honestly wide instead of collapsing to one guess.
const PLUS_ATK_NATURES = ['Adamant', 'Brave'];
const PLUS_SPA_NATURES = ['Modest', 'Quiet'];

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

// Type-immunity / absorb abilities: holding one makes the mon take ZERO damage
// from the keyed move type. So observing REAL (non-zero) damage from that type
// rules the ability out — a clean, observation-driven ability narrowing that
// needs no extra logging. Keyed by move type. (Dry Skin is immune to Water but
// takes EXTRA from Fire, so it only sits under Water; a Fire hit doesn't rule it
// out.) Wonder Guard etc. are absent in this format.
const TYPE_IMMUNITY_ABILITIES: Record<string, string[]> = {
  Ground: ['Levitate'],
  Electric: ['Volt Absorb', 'Lightning Rod', 'Motor Drive'],
  Water: ['Water Absorb', 'Storm Drain', 'Dry Skin'],
  Fire: ['Flash Fire'],
  Grass: ['Sap Sipper'],
};

// Abilities ruled out by a landed damaging hit of the given move type (empty if
// the type has no immunity ability). Compared by id for name-spacing safety.
export function abilitiesRuledOutByHit(moveType: string | undefined): Set<string> {
  const names = moveType ? TYPE_IMMUNITY_ABILITIES[moveType] ?? [] : [];
  return new Set(names.map(toId));
}

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
  // Ability ids proven absent by PRIOR observations (OpponentEntry.
  // abilitiesRuledOut — landed-status / landed-hit rule-outs persisted across
  // turns). Merged with this observation's own per-hit type-immunity rule-out;
  // filters both the coarse ability axis and prior/starting candidates.
  ruledOutAbilities?: string[];
  // Item ids the ITEM CLAUSE forbids on this mon (claimed by a teammate —
  // claimedItemIdsExcept in itemClause.ts). Filters the item AXIS so the grid
  // never generates claimed-item spreads, and prunes prior/starting candidates.
  excludeItems?: string[];
  // Item permanence: the opponent's held item is known to have been consumed on
  // a PRIOR turn (gone before this observation). Per the permanence model, a mon
  // whose item was consumed can't still be holding a persistent item, so collapse
  // the item axis to "no item" — inference stops proposing Leftovers/Choice/etc.
  // The caller reads PRE-turn state, so a resist berry that pops on THIS hit is
  // not yet "gone" and still applies its 0.5x. See itemPermanence.ts.
  itemKnownGone?: boolean;
  // Recoil/drain HP readout: the HP EV(s) whose max HP matches an observed
  // recoil/drain reading. When set, the HP dimension is PINNED to these (the
  // recoil maths give max HP defense-independently), collapsing the grid's HP
  // axis so the solver only varies Def/SpD. Usually one EV, two at a bucket seam.
  hpEvCandidates?: number[];
}

// --- Recoil/drain HP readout -------------------------------------------------
// A recoil/drain effect is `frac × damageDealt`, and damage dealt lives on the
// TARGET's HP scale — so observing the effect on the attacker bridges straight to
// the opponent's max HP, with NO dependence on defense or the damage formula.
// (Rocky Helmet/Life Orb/Rough Skin are fixed fractions of the attacker's OWN bar,
// peeled off by the caller before this is called.)
export function solveOppMaxHp(p: {
  oppIsAttacker: boolean;        // is the OPP the one using the recoil/drain move?
  recoilFrac: number;           // the move's recoil or drain fraction (>0, e.g. 0.33, 0.5)
  attackerSelfFrac: number;     // recoil/drain magnitude as a fraction of the ATTACKER's bar, peeled of helmet/orb (>0)
  targetDropFrac: number;       // damage dealt as a fraction of the TARGET's bar (>0)
  knownMaxHp: number;           // max HP of the KNOWN (mine-side) mon: the target if oppIsAttacker, else the attacker
}): number | null {
  const { oppIsAttacker, recoilFrac, attackerSelfFrac, targetDropFrac, knownMaxHp } = p;
  if (recoilFrac <= 0 || attackerSelfFrac <= 0 || targetDropFrac <= 0 || knownMaxHp <= 0) return null;
  // oppIsAttacker: opp's self-frac is on the UNKNOWN bar → opp = recoilFrac·D / selfFrac, D = knownMaxHp·targetDrop.
  // else (opp is target): attacker self-frac is on the KNOWN bar → recoilHP = knownMaxHp·selfFrac = recoilFrac·opp·targetDrop.
  const oppMaxHp = oppIsAttacker
    ? (recoilFrac * knownMaxHp * targetDropFrac) / attackerSelfFrac
    : (knownMaxHp * attackerSelfFrac) / (recoilFrac * targetDropFrac);
  return Number.isFinite(oppMaxHp) && oppMaxHp > 0 ? oppMaxHp : null;
}

// One-call orchestration shared by both finalizeTurn paths: peel the fixed
// contact-item fraction, isolate the recoil/drain magnitude, solve the opponent's
// max HP, and return the matching HP EV(s). Returns [] (abstain) when the attacker
// fainted, the magnitude is non-positive, a drain overhealed (capped), or nothing
// reconciles. `attacker*Frac`/`targetDropFrac` are 0..1 fractions of each bar.
export function recoilDrainHpEvs(p: {
  effect: 'recoil' | 'drain';
  frac: number;                  // the move's recoil/drain fraction (e.g. 0.33, 0.5)
  oppIsAttacker: boolean;
  oppSpecies: string;
  oppLevel: number;
  attackerBeforeFrac: number;    // attacker's HP before the move (pre-turn), 0..1
  attackerAfterFrac: number;     // OBSERVED self HP after, 0..1
  attackerFainted: boolean;
  peelFrac: number;              // helmet (1/6) / orb (1/10) / barbs (1/8) total, fraction of attacker bar
  targetDropFrac: number;        // damage dealt, fraction of the target's bar
  knownMaxHp: number;            // the mine-side mon's max HP
}): number[] {
  if (p.attackerFainted) return [];
  // recoil: attacker dropped (recoil + peel) → recoil = drop − peel.
  // drain:  attacker gained (drain − peel)  → drain  = gain + peel.
  const selfFrac = p.effect === 'recoil'
    ? (p.attackerBeforeFrac - p.attackerAfterFrac) - p.peelFrac
    : (p.attackerAfterFrac - p.attackerBeforeFrac) + p.peelFrac;
  if (selfFrac <= 1e-4 || p.targetDropFrac <= 1e-4) return [];          // nothing attributable → abstain
  if (p.effect === 'drain' && p.attackerAfterFrac >= 0.999) return []; // overheal capped → can't read
  const oppMaxHp = solveOppMaxHp({
    oppIsAttacker: p.oppIsAttacker, recoilFrac: p.frac,
    attackerSelfFrac: selfFrac, targetDropFrac: p.targetDropFrac, knownMaxHp: p.knownMaxHp,
  });
  if (oppMaxHp == null) return [];
  // Propagate the ±0.5% rounding on each observed % into an HP tolerance (relative
  // errors add: oppMaxHp ∝ targetDrop / selfFrac), + 1 HP for max-HP rounding. A
  // small recoil drop ⇒ looser reading (more buckets), which is honest.
  const tol = oppMaxHp * (0.005 / selfFrac + 0.005 / p.targetDropFrac) + 1.5;
  return hpEvsForMaxHp(p.oppSpecies, p.oppLevel, oppMaxHp, tol);
}

// HP EVs (0..252, step 4) whose resulting max HP is within `tol` of `maxHp`.
// Usually one; two at a bucket seam. Empty ⇒ nothing reconciles → the caller
// should abstain rather than constrain on a bogus reading.
export function hpEvsForMaxHp(species: string, level: number, maxHp: number, tol = 1.5): number[] {
  const out: number[] = [];
  for (let ev = 0; ev <= 252; ev += 4) {
    const set: PokemonSet = {
      species, level, nature: 'Hardy',
      evs: { hp: ev, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
      ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, moves: [],
    };
    if (Math.abs(maxHpFor(set) - maxHp) <= tol) out.push(ev);
  }
  return out;
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
  let possibleAbilities: string[] = input.priorAbilities ??
    (species?.abilities ? Object.values(species.abilities) as string[] : ['']);

  // Ability inference: a damaging hit that DEALT damage rules out the type-
  // immunity ability for that move's type (a Levitate mon never takes Ground
  // damage, etc.). Narrow both the coarse ability axis and any prior candidates.
  const tookDamage = (input.observation.damageHpPercent ?? input.observation.damageRaw ?? 0) > 0;
  const moveType = (getMove(input.observation.move) as { type?: string } | undefined)?.type;
  const ruledOut = tookDamage ? abilitiesRuledOutByHit(moveType) : new Set<string>();
  // Persisted rule-outs from earlier observations (landed status / prior hits).
  for (const id of input.ruledOutAbilities ?? []) ruledOut.add(id);
  if (ruledOut.size) {
    const narrowed = possibleAbilities.filter(a => !ruledOut.has(toId(a)));
    if (narrowed.length) possibleAbilities = narrowed; // never empty the axis
  }

  // Item search space: the standard defensive items + any gimmick-specific
  // variants (e.g. mega stones legal for this species). Filter against the
  // format's allow-list so a banned item never appears in a candidate spread —
  // Champions in particular runs a heavily-restricted item pool, and
  // suggesting an off-format item is just noise.
  const baseItems = input.priorItems ?? COMMON_DEFENSIVE_ITEMS.map(x => x ?? '');
  const gimmickItems = (activeGimmick().enumerateOpponentVariants?.(toId(input.defenderSpecies)) ?? [])
    .map(v => v.item)
    .filter((i): i is string => !!i);
  // Type-matchup resist berries (Yache / Occa / Haban / …): only the ones
  // matching this species' super-effective weaknesses. The calc handles the
  // 0.5x reduction natively when the berry is passed as the held item.
  const berryItems = input.priorItems ? [] : resistBerriesForSpecies(speciesName);
  let items = Array.from(new Set([...baseItems, ...gimmickItems, ...berryItems]));
  // Keep the empty-string "no item" entry; everything else must be format-legal.
  items = items.filter(i => !i || isLegalItem(i));
  // Item clause: a teammate's claimed item can't appear on this mon.
  const excludeItems = new Set((input.excludeItems ?? []).map(toId));
  if (excludeItems.size) {
    items = items.filter(i => !i || !excludeItems.has(toId(i)));
  }
  // Item signals: exclude Safety Goggles if we've observed sand chip damage.
  if (input.sandChipObserved) {
    items = items.filter(i => i !== 'Safety Goggles');
  }
  // Item permanence: if the held item was already consumed before this hit, the
  // item axis is settled — collapse to "no item".
  if (input.itemKnownGone) items = [''];
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

  // Apply the ability/item narrowing to whichever candidate set we picked —
  // priors and chained startingCandidates carry their own item/ability that
  // bypass the `items`/`possibleAbilities` arrays the coarse grid builds from.
  if (ruledOut.size || input.itemKnownGone || excludeItems.size) {
    const seen = new Set<string>();
    const narrowed = candidates
      .filter(c => !c.ability || !ruledOut.has(toId(c.ability)))
      .filter(c => !c.item || !excludeItems.has(toId(c.item)))
      .map(c => (input.itemKnownGone ? { ...c, item: undefined } : c))
      .filter(c => {
        const key = `${c.evs.hp}|${c.evs.atk}|${c.evs.def}|${c.evs.spa}|${c.evs.spd}|${c.evs.spe}|${c.nature}|${c.item ?? ''}|${c.ability ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (narrowed.length) candidates = narrowed; // never empty the set
  }

  // Recoil/drain HP readout pins the HP EV (defense-independent), so override
  // every candidate's HP with the solved value(s) and drop any that bust the EV
  // budget. Collapses the HP axis — the solver then only varies Def/SpD.
  if (input.hpEvCandidates?.length) {
    const pinned = new Set(input.hpEvCandidates);
    candidates = candidates
      .flatMap(c => [...pinned].map(hp => ({ ...c, evs: { ...c.evs, hp } })))
      .filter(c => c.evs.hp + c.evs.def + c.evs.spd <= 508);
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
  // For each candidate, sweep the offensive-stat buckets that fit the budget and
  // keep the ones whose forward damage range contains the observed value.
  //
  // The sweep OVERWRITES the candidate's existing value for `stat`, so two
  // candidates differing only in that stat map onto the SAME outputs — chained
  // observations (two opp hits in one turn, or across turns) would otherwise
  // multiply duplicates geometrically (the replay harness measured one real
  // turn at 71s before this dedupe). Dedupe on the full candidate identity,
  // keeping the first (best-likelihood) instance.
  const dedupe = (scored: ScoredCandidate[]): ScoredCandidate[] => {
    const seen = new Set<string>();
    return scored.filter(s => {
      const c = s.candidate;
      const k = `${c.evs.hp}|${c.evs.atk}|${c.evs.def}|${c.evs.spa}|${c.evs.spd}|${c.evs.spe}|${c.nature}|${c.item ?? ''}|${c.ability ?? ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const solve = (cands: SpreadCandidate[]): ScoredCandidate[] => {
    const out: ScoredCandidate[] = [];
    for (const c of cands) {
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
        if (predicted.max >= obs.lo && predicted.min <= obs.hi) {
          out.push({ candidate: cand, within: true, likelihood: candidateLikelihood(predicted.rolls, obs.lo, obs.hi) });
        }
      }
    }
    return out.sort((a, b) => b.likelihood - a.likelihood);
  };

  let result = dedupe(solve(input.startingCandidates));
  if (!result.length) {
    // Confidence trigger: no current-nature spread can explain the hit even at
    // max investment → it's an extreme hit that forces A boosting nature. Promote
    // to the whole +stat CLASS (Adamant/Brave or Modest/Quiet — damage-identical;
    // the minus stat is discriminated by speed reads and later observations), not
    // one flag-bearer — natures otherwise stay loose.
    const boosts = stat === 'atk' ? PLUS_ATK_NATURES : PLUS_SPA_NATURES;
    const promoted = input.startingCandidates.flatMap(c =>
      boosts.filter(b => b !== c.nature).map(b => ({ ...c, nature: b })));
    if (promoted.length) result = dedupe(solve(promoted));
  }
  return result.length ? result : passthrough(); // still nothing → keep prior belief
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
  const topItems = pik.items
    .filter(i => i.name.toLowerCase() !== 'other' && isLegalItem(i.name))
    .slice(0, 4).map(i => i.name);
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

// --- Coarse search profile ---------------------------------------------------
// Pick K REPRESENTATIVE spreads from a (possibly huge) candidate set so the
// lookahead search's per-mon cost is a constant, decoupled from inference's grid
// width. The full candidate set still drives the spread READOUT; the search only
// needs enough spreads to preserve the DAMAGE ENVELOPE (does the foe survive / can
// it KO). So we keep, in priority order: the most-likely (the expected case), the
// BULKIEST and FRAILEST by defensive investment (the min/max damage bounds for "do
// I KO it"), and the most-offensive (its max threat to me) — deduped, capped to k.
// `k` is meant to SHRINK as inference gets confident (Step C of the deep-switch
// plan); a narrow candidate set (≤k) is returned unchanged.
export function representativeSpreadIndices(
  candidates: { evs: Stats; item?: string; nature: string }[],
  likelihoods: number[] | undefined,
  k: number,
): number[] {
  const n = candidates.length;
  if (n <= Math.max(1, k)) return candidates.map((_, i) => i);
  const defInvest = (i: number) => candidates[i]!.evs.hp + candidates[i]!.evs.def + candidates[i]!.evs.spd;
  const offInvest = (i: number) => candidates[i]!.evs.atk + candidates[i]!.evs.spa;
  const all = candidates.map((_, i) => i);
  const ml = mostLikelyIndex(candidates as SpreadCandidate[], likelihoods);
  const maxDef = all.reduce((a, b) => (defInvest(b) > defInvest(a) ? b : a));
  const minDef = all.reduce((a, b) => (defInvest(b) < defInvest(a) ? b : a));
  const maxOff = all.reduce((a, b) => (offInvest(b) > offInvest(a) ? b : a));
  const picked: number[] = [];
  for (const i of [ml, maxDef, minDef, maxOff]) if (i >= 0 && !picked.includes(i)) picked.push(i);
  return picked.slice(0, k);
}

// --- Joint solve -------------------------------------------------------------
// The defensive (scoreSpread) and offensive (scoreOffensiveSpread) passes run on
// DIFFERENT observations and chain through the candidate set — which keeps them
// mostly joint already. But two things can break joint consistency: the
// offensive pass's nature PROMOTION (it swaps a candidate's nature to reach an
// extreme hit, possibly contradicting an earlier defensive fit) and the Hybrid
// fallback (which keeps "least wrong" candidates to avoid an empty set). This is
// the reconciliation: re-check every surviving candidate against the FULL
// history of observations on this mon and keep only the ones consistent with ALL
// of them — a true joint (nature × item × EV) solve. Guarded to never empty.
export interface StoredObservation {
  // Is the opponent the ATTACKER in this observation (offensive obs) or the
  // defender (defensive obs)?
  oppIsAttacker: boolean;
  // The KNOWN (mine-side) mon: the defender when oppIsAttacker, else the attacker.
  otherSet: PokemonSet;
  observation: DamageObservation;
}

// Per-observation forward check: does this candidate's predicted damage contain
// the observed value, and how well? Returns null when the obs is unscorable
// (calc threw / not comparable) so the caller can skip it without penalty.
// Shared by reconcileCandidates and jointSolve.
function obsFit(
  c: SpreadCandidate, h: StoredObservation,
  oppSpecies: string, oppLevel: number, knownMoves: string[],
): { within: boolean; like: number } | null {
  const oppSpeciesForObs = h.oppIsAttacker ? h.observation.attackerSpecies : h.observation.defenderSpecies;
  const oppSet = fullSet(oppSpeciesForObs || oppSpecies, c, oppLevel, knownMoves);
  const attacker = h.oppIsAttacker ? oppSet : h.otherSet;
  const defender = h.oppIsAttacker ? h.otherSet : oppSet;
  let predicted;
  try {
    predicted = damageRange({
      attacker, defender,
      move: h.observation.move,
      field: h.observation.field,
      attackerSide: h.observation.attackerSide,
      attackerOpts: { gimmickActive: h.observation.attackerGimmickActive, boosts: h.observation.attackerBoosts as any },
      defenderOpts: { gimmickActive: h.observation.defenderGimmickActive, boosts: h.observation.defenderBoosts as any },
      helpingHand: h.observation.helpingHand,
      critical: h.observation.critical,
    });
  } catch { return null; }
  const obs = observationToAbsoluteDamage(h.observation, defender);
  return { within: predicted.max >= obs.lo && predicted.min <= obs.hi, like: candidateLikelihood(predicted.rolls, obs.lo, obs.hi) };
}

// The defensive / offensive stat a standard damaging move constrains on the
// OPPONENT. Status, fixed-damage (Seismic Toss), Body Press (uses Def to
// attack) and Foul Play (uses the target's Atk) don't constrain the opp's own
// offensive stat, so they're null on the offensive side.
function defensiveStatOf(move: string): 'def' | 'spd' | null {
  const m = getMove(move) as { category?: string } | undefined;
  return m?.category === 'Physical' ? 'def' : m?.category === 'Special' ? 'spd' : null;
}
function offensiveStatOf(move: string): 'atk' | 'spa' | null {
  const m = getMove(move) as { category?: string; damage?: unknown; overrideOffensiveStat?: unknown; overrideOffensivePokemon?: unknown } | undefined;
  if (!m || (m.category !== 'Physical' && m.category !== 'Special')) return null;
  if (m.damage || m.overrideOffensiveStat || m.overrideOffensivePokemon === 'target') return null;
  return m.category === 'Physical' ? 'atk' : 'spa';
}

export interface JointSolveResult { candidates: SpreadCandidate[]; likelihoods: number[] }

// Joint inference commits only when the observations collapse the candidate
// natures to at most this many — its value is pinning the nature, and a result
// spread across more natures means the swept stat wasn't discriminated.
const NATURE_COLLAPSE_MAX = 3;

// JOINT EV/nature/item inference. The sequential pipeline (scoreSpread →
// scoreOffensiveSpread) commits to a NATURE defensively, then only overrides it
// offensively as a last resort — so a single nature jointly consistent with a
// hit the opp TOOK and a hit it DEALT is never generated (e.g. a special hit
// constrains SpD while a physical hit it landed constrains Atk; only an
// Adamant-family spread satisfying both should survive, but the defensive pass
// might lock in Calm/-Atk first and the offensive pass can't recover the right
// bulk).
//
// This solver enumerates nature × item × ability × HP ONCE and exploits that,
// with those fixed, the opponent's defensive stat (from hits it took) and
// offensive stat (from hits it dealt) are INDEPENDENT — so each is solved
// marginally over the coarse EV grid, then the cartesian of the survivors is
// re-checked against the FULL history (catching any cross-terms). Only worth
// running when the history mixes both directions; returns null otherwise so the
// caller keeps the cheaper sequential path. Bails to null past `calcBudget` so
// live latency stays bounded.
export function jointSolve(p: {
  oppSpecies: string;
  oppLevel: number;
  knownMoves: string[];
  history: StoredObservation[];
  priorAbilities?: string[];
  priorItems?: string[];
  priorNatures?: string[];
  excludeItems?: string[];
  ruledOutAbilities?: string[];
  itemKnownGone?: boolean;
  hpEvCandidates?: number[];
  calcBudget?: number;
}): JointSolveResult | null {
  const defensiveObs = p.history.filter(h => !h.oppIsAttacker);
  const offensiveObs = p.history.filter(h => h.oppIsAttacker);
  // Joint reasoning only adds something when BOTH directions are observed AND
  // each actually constrains a stat (a status/fixed-damage move constrains
  // neither). Otherwise the sequential solvers already cover it.
  const constrainedDef = new Set(defensiveObs.map(h => defensiveStatOf(h.observation.move)).filter((s): s is 'def' | 'spd' => !!s));
  const constrainedOff = new Set(offensiveObs.map(h => offensiveStatOf(h.observation.move)).filter((s): s is 'atk' | 'spa' => !!s));
  if (!constrainedDef.size || !constrainedOff.size) return null;

  const species = getSpecies(p.oppSpecies);
  const speciesName = species?.name ?? p.oppSpecies;

  // Axes (mirrors scoreSpread's filtering so the two solvers agree on the space).
  const ruledOut = new Set((p.ruledOutAbilities ?? []).map(toId));
  let abilities = p.priorAbilities ?? (species?.abilities ? Object.values(species.abilities) as string[] : ['']);
  if (ruledOut.size) { const n = abilities.filter(a => !ruledOut.has(toId(a))); if (n.length) abilities = n; }
  let items = p.itemKnownGone ? [''] : (p.priorItems ?? COMMON_DEFENSIVE_ITEMS.map(x => x ?? ''));
  const excludeItems = new Set((p.excludeItems ?? []).map(toId));
  items = items.filter(i => !i || (isLegalItem(i) && !excludeItems.has(toId(i))));
  if (!items.length) items = [''];
  const natures = p.priorNatures ?? NATURES_TO_TRY;
  const hpAxis = p.hpEvCandidates?.length ? p.hpEvCandidates : COARSE_EVS;

  // Pikalytics prior fills the UNCONSTRAINED stats so a candidate isn't
  // implausibly zero where we have no signal.
  const prior = priorsFromPikalytics(speciesName)[0]?.evs ?? { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };

  // Budget guard: project the calc count and bail if it would stall the UI.
  const budget = p.calcBudget ?? 60_000;
  const defAxisSize = hpAxis.length * (constrainedDef.has('def') ? COARSE_EVS.length : 1) * (constrainedDef.has('spd') ? COARSE_EVS.length : 1);
  const offAxisSize = (constrainedOff.has('atk') ? COARSE_EVS.length : 1) * (constrainedOff.has('spa') ? COARSE_EVS.length : 1);
  const projected = natures.length * items.length * abilities.length * (defAxisSize * defensiveObs.length + offAxisSize * offensiveObs.length);
  if (projected > budget) return null;

  const kept: { c: SpreadCandidate; like: number }[] = [];
  const budgetStat = (stat: keyof Stats, ev: number, base: Stats) => ({ ...base, [stat]: ev });
  for (const nature of natures) {
    for (const itemRaw of items) {
      const item = itemRaw || undefined;
      for (const abilityRaw of abilities) {
        const ability = abilityRaw || undefined;
        const base: SpreadCandidate = { evs: { ...prior, atk: 0, spa: 0 }, nature, item, ability };
        // --- Offensive marginals (independent of HP/defense) ---
        const offCombos: Stats[] = [];
        const sweepOff = (stat: 'atk' | 'spa', evs: Stats[]): Stats[] => {
          if (!constrainedOff.has(stat)) return evs;
          const out: Stats[] = [];
          for (const e of evs) for (const ev of COARSE_EVS) out.push(budgetStat(stat, ev, e));
          return out;
        };
        for (const combo of sweepOff('spa', sweepOff('atk', [{ ...base.evs }]))) {
          const cand = { ...base, evs: combo };
          if (offensiveObs.every(h => obsFit(cand, h, p.oppSpecies, p.oppLevel, p.knownMoves)?.within !== false)) offCombos.push(combo);
        }
        if (!offCombos.length) continue;
        // --- Defensive marginals (depend on HP + the defensive stat) ---
        const defCombos: Stats[] = [];
        for (const hp of hpAxis) {
          const sweepDef = (stat: 'def' | 'spd', evs: Stats[]): Stats[] => {
            if (!constrainedDef.has(stat)) return evs;
            const out: Stats[] = [];
            for (const e of evs) for (const ev of COARSE_EVS) out.push(budgetStat(stat, ev, e));
            return out;
          };
          for (const combo of sweepDef('spd', sweepDef('def', [budgetStat('hp', hp, base.evs)]))) {
            const cand = { ...base, evs: combo };
            if (defensiveObs.every(h => obsFit(cand, h, p.oppSpecies, p.oppLevel, p.knownMoves)?.within !== false)) defCombos.push(combo);
          }
        }
        if (!defCombos.length) continue;
        // --- Cartesian + full-history re-check (cross-terms) ---
        for (const off of offCombos) {
          for (const def of defCombos) {
            const evs: Stats = {
              hp: def.hp, def: def.def, spd: def.spd,
              atk: constrainedOff.has('atk') ? off.atk : def.atk,
              spa: constrainedOff.has('spa') ? off.spa : def.spa,
              spe: prior.spe,
            };
            if (evs.hp + evs.atk + evs.def + evs.spa + evs.spd + evs.spe > 508) continue;
            const cand: SpreadCandidate = { evs, nature, item, ability };
            let ok = true, scoreSum = 0;
            for (const h of p.history) {
              const fit = obsFit(cand, h, p.oppSpecies, p.oppLevel, p.knownMoves);
              if (fit == null) continue;
              if (!fit.within) { ok = false; break; }
              scoreSum += fit.like;
            }
            if (ok) kept.push({ c: cand, like: scoreSum });
          }
        }
      }
    }
  }
  if (!kept.length) return null;
  // Dedupe identical spreads, keep the best-likelihood instance.
  const seen = new Set<string>();
  const deduped = kept
    .sort((a, b) => b.like - a.like)
    .filter(({ c }) => {
      const k = `${c.evs.hp}|${c.evs.atk}|${c.evs.def}|${c.evs.spa}|${c.evs.spd}|${c.evs.spe}|${c.nature}|${c.item ?? ''}|${c.ability ?? ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  // DISCRIMINATION GATE: joint inference earns its place by pinning the NATURE
  // (its whole point — a single nature consistent with both directions). When
  // the observations don't discriminate the swept stat (e.g. Gyro Ball's power
  // is speed-, not Atk-based, so every Atk fits), the result fans across most
  // natures — pure noise that would also destabilise the chained pipeline.
  // Only commit when it collapses the nature space; otherwise abstain (null)
  // and the caller keeps the stable sequential belief.
  const distinctNatures = new Set(deduped.map(d => d.c.nature)).size;
  if (distinctNatures > NATURE_COLLAPSE_MAX) return null;
  return { candidates: deduped.map(k => k.c), likelihoods: deduped.map(k => k.like) };
}

// Integration-ready (NOT yet wired into the live mirrors — see below) entry
// point that augments reconcile with the JOINT solver: joint fires only for
// histories mixing offensive + defensive observations AND only when it
// collapses the nature space (the discrimination gate), then its correct-
// nature spreads are unioned onto reconcile's trusted survivors.
//
// DEFERRED 2026-06-13: jointSolve itself is shipped + tested (jointSolve is the
// proven unit), but feeding its candidates back into the CHAINED per-turn
// pipeline (scoreOffensiveSpread sweeps them next turn) intermittently
// destabilised the J.4 sim round-trip. The clean wiring needs feedback
// isolation — surface joint's nature correction for display/use without
// re-seeding the next turn's sequential sweep. Until then the mirrors call
// reconcileCandidates directly (stable) and this helper is the staging ground.
export function refineCandidates(p: {
  oppSpecies: string;
  oppLevel: number;
  knownMoves: string[];
  candidates: SpreadCandidate[];
  likelihoods?: number[];
  history: StoredObservation[];
  ruledOutAbilities?: string[];
  hpEvCandidates?: number[];
}): { candidates: SpreadCandidate[]; likelihoods: number[] } {
  // Reconcile first: the subset of the PROVIDED candidates consistent with the
  // whole history (this is what retains a correct seeded/chained spread).
  const recon = reconcileCandidates(p);
  const priorItems = [...new Set(p.candidates.map(c => c.item ?? ''))];
  const priorAbilities = [...new Set(p.candidates.map(c => c.ability ?? '').filter(a => a))];
  const joint = jointSolve({
    oppSpecies: p.oppSpecies, oppLevel: p.oppLevel, knownMoves: p.knownMoves,
    history: p.history,
    priorItems: priorItems.length ? priorItems : undefined,
    priorAbilities: priorAbilities.length ? priorAbilities : undefined,
    ruledOutAbilities: p.ruledOutAbilities,
    hpEvCandidates: p.hpEvCandidates,
  });
  if (!joint || !joint.candidates.length) return recon;
  // Reconcile's survivors are kept IN FULL and unchanged — joint must never
  // drop a trusted/seeded spread or alter the chained-observation feedback the
  // sequential pipeline relies on. Joint then ADDS, into whatever room is left
  // up to CAP, the correct-nature spreads the sequential pipeline couldn't
  // reach (it commits to nature defensively first). New-nature joint
  // candidates are added preferentially — that's joint's whole contribution.
  const CAP = 40;
  const key = (c: SpreadCandidate) =>
    `${c.evs.hp}|${c.evs.atk}|${c.evs.def}|${c.evs.spa}|${c.evs.spd}|${c.evs.spe}|${c.nature}|${c.item ?? ''}|${c.ability ?? ''}`;
  const out = [...recon.candidates];
  const likes = [...recon.likelihoods];
  const seen = new Set(out.map(key));
  const reconNatures = new Set(recon.candidates.map(c => c.nature));
  // New-nature joint candidates first (highest value), then the rest — both
  // already likelihood-sorted within jointSolve.
  const ordered = [
    ...joint.candidates.map((c, i) => ({ c, l: joint.likelihoods[i] ?? 0 })).filter(x => !reconNatures.has(x.c.nature)),
    ...joint.candidates.map((c, i) => ({ c, l: joint.likelihoods[i] ?? 0 })).filter(x => reconNatures.has(x.c.nature)),
  ];
  for (const { c, l } of ordered) {
    if (out.length >= CAP) break;     // never truncates recon — recon was pushed whole
    const k = key(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    likes.push(l);
  }
  return { candidates: out, likelihoods: likes };
}

export function reconcileCandidates(p: {
  oppSpecies: string;
  oppLevel: number;
  knownMoves: string[];
  candidates: SpreadCandidate[];
  likelihoods?: number[];
  history: StoredObservation[];
}): { candidates: SpreadCandidate[]; likelihoods: number[] } {
  const fallback = {
    candidates: p.candidates,
    likelihoods: p.likelihoods ?? p.candidates.map(() => 0),
  };
  if (p.history.length < 2 || p.candidates.length <= 1) return fallback;
  const kept: { c: SpreadCandidate; like: number }[] = [];
  for (let i = 0; i < p.candidates.length; i++) {
    const c = p.candidates[i]!;
    let ok = true;
    let scoreSum = 0;
    for (const h of p.history) {
      // Build the opp set from the forme the observation actually saw (mega
      // forme if they'd mega'd), not the base species.
      const oppSpeciesForObs = h.oppIsAttacker
        ? h.observation.attackerSpecies
        : h.observation.defenderSpecies;
      const oppSet = fullSet(oppSpeciesForObs || p.oppSpecies, c, p.oppLevel, p.knownMoves);
      const attacker = h.oppIsAttacker ? oppSet : h.otherSet;
      const defender = h.oppIsAttacker ? h.otherSet : oppSet;
      let predicted;
      try {
        predicted = damageRange({
          attacker,
          defender,
          move: h.observation.move,
          field: h.observation.field,
          attackerSide: h.observation.attackerSide,
          attackerOpts: { gimmickActive: h.observation.attackerGimmickActive, boosts: h.observation.attackerBoosts as any },
          defenderOpts: { gimmickActive: h.observation.defenderGimmickActive, boosts: h.observation.defenderBoosts as any },
          helpingHand: h.observation.helpingHand,
          critical: h.observation.critical,
        });
      } catch { continue; } // unscorable obs → don't penalise the candidate
      const obs = observationToAbsoluteDamage(h.observation, defender);
      if (!(predicted.max >= obs.lo && predicted.min <= obs.hi)) { ok = false; break; }
      scoreSum += candidateLikelihood(predicted.rolls, obs.lo, obs.hi);
    }
    if (ok) kept.push({ c, like: p.likelihoods?.[i] ?? scoreSum });
  }
  if (!kept.length) return fallback; // never empty — keep prior belief
  kept.sort((a, b) => b.like - a.like);
  return { candidates: kept.map(k => k.c), likelihoods: kept.map(k => k.like) };
}
