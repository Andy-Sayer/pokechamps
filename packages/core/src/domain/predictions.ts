import type { PokemonSet, OpponentEntry, FieldState } from './types.js';
import { damageRange } from './damage.js';
import { defaultOpponentSet } from './bring.js';
import { actualSpeed } from './speed.js';
import { getPikalytics } from './pikalytics.js';
import { mostLikelyIndex } from './inference.js';
import { isFirstTurnMove } from './itemSignals.js';
import { isAttackConditionalMove } from './data.js';

export type Confidence = 'high' | 'med' | 'low';

// One matchup row's worth of data. `move` is the attacker's best option
// against this defender; min/max are the HONEST envelope across the candidate
// uncertainty (every plausible defender spread × the calc's roll spread).
// `likely*` is the single most-likely (least-invested consistent) spread's
// range, with a `confidence` rating reflecting how tightly observations pin it.
export interface MatchupCell {
  move: string;
  minPercent: number;
  maxPercent: number;
  koChance: string;
  candidatesConsidered: number;
  likelyMinPercent?: number;
  likelyMaxPercent?: number;
  confidence?: Confidence;
  /** Set when the move's damage is conditional (e.g. Sucker Punch only lands
   *  if the target attacks this turn). A short caveat the UI surfaces so the
   *  number isn't read as guaranteed. */
  conditional?: string;
  /** Every damage roll (% of defender max) for the chosen move, pooled across
   *  ALL surviving candidate spreads. Lets callers compute an exact KO chance
   *  that already folds in spread (bulk) uncertainty as well as roll variance. */
  percentRolls?: number[];
}

// Confidence in the prediction: no inference yet → low (it's a Pikalytics /
// default prior); otherwise driven by how wide the honest envelope is (tight
// agreement across surviving spreads = high).
function confidenceFor(hasInference: boolean, minPercent: number, maxPercent: number): Confidence {
  if (!hasInference) return 'low';
  const width = maxPercent - minPercent;
  if (width <= 12) return 'high';
  if (width <= 28) return 'med';
  return 'low';
}

export type SpeedVerdict = 'faster' | 'slower' | 'tie' | 'unknown' | 'scarf-flag';

// Candidate defender sets to evaluate. Falls back to the cheap default set
// when inference hasn't started narrowing yet. When the mon's item has been
// consumed (Sitrus/Sash) or knocked off (Knock Off/Thief/etc.), strip the item
// so the calc no longer applies it — `opp.itemConsumed` is our marker.
function defenderCandidates(opp: OpponentEntry, level: number): PokemonSet[] {
  const base = opp.candidates?.length ? opp.candidates : [defaultOpponentSet(opp, level)];
  if (opp.itemConsumed) return base.map(c => ({ ...c, item: undefined }));
  return base;
}

// Best move for `attackerMoves` against a single defender set, by max-roll %.
// Returns null if nothing in the movepool can be calculated against this
// defender (e.g. unknown move id).
function bestMoveAgainst(
  attacker: PokemonSet,
  defender: PokemonSet,
  moves: string[],
  field: FieldState,
  attackerSide: 'mine' | 'theirs',
  opts: {
    attackerGimmickActive?: boolean;
    defenderGimmickActive?: boolean;
    attackerBoosts?: Partial<Record<string, number>>;
    defenderBoosts?: Partial<Record<string, number>>;
    attackerStatus?: string;
    defenderStatus?: string;
    critical?: boolean;
  } = {},
): { move: string; min: number; max: number; koChance: string } | null {
  let best: { move: string; min: number; max: number; koChance: string } | null = null;
  for (const move of moves) {
    try {
      const r = damageRange({
        attacker,
        defender,
        move,
        field,
        attackerSide,
        attackerOpts: { gimmickActive: opts.attackerGimmickActive, boosts: opts.attackerBoosts, status: opts.attackerStatus },
        defenderOpts: { gimmickActive: opts.defenderGimmickActive, boosts: opts.defenderBoosts, status: opts.defenderStatus },
        critical: opts.critical,
      });
      if (!best || r.maxPercent > best.max) {
        best = { move, min: r.minPercent, max: r.maxPercent, koChance: r.koChance };
      }
    } catch { /* skip */ }
  }
  return best;
}

// Top-Pikalytics moves for a species when we have no observed moves yet.
// Filters out the "Other" rollup bucket and any move that comes back as null
// from the dex (shouldn't happen for legal species but harmless). Exported so
// the search can draw an opponent's spread-move pool from the SAME source
// predictThreat uses (knownMoves else this), keeping the two consistent.
export function pikalyticsMoves(species: string): string[] {
  const pik = getPikalytics(species);
  if (!pik) return [];
  return pik.moves
    .filter(m => m.name.toLowerCase() !== 'other')
    .slice(0, 4)
    .map(m => m.name);
}

// Exact-ish KO chance: count the fraction of damage rolls that meet/exceed
// remaining HP. `percentRolls` is the rolls expressed as % of defender max
// HP — directly comparable. When all rolls clear, guaranteed; when none
// clear, survives by the gap from the highest roll.
function koVsRemaining(percentRolls: number[], remaining: number): string {
  if (!percentRolls.length) return '';
  const min = Math.min(...percentRolls);
  const max = Math.max(...percentRolls);
  if (min >= remaining) return 'guaranteed KO';
  if (max < remaining) return `survives (≥${(remaining - max).toFixed(0)}% left)`;
  const wins = percentRolls.filter(p => p >= remaining).length;
  const pct = Math.round((wins / percentRolls.length) * 100);
  return `${pct}% KO`;
}

// MY damage TO opp. Iterates every candidate defender spread, picks my best
// move per candidate, then aggregates: chooses the move that's best on
// average (specifically: by highest top-end damage), and reports the
// min/max range of THAT move across all candidates. When
// `defenderCurrentHpPercent` is supplied, KO chance is recomputed against
// remaining HP rather than max HP.
export function predictOffense(args: {
  attacker: PokemonSet;
  opponent: OpponentEntry;
  field: FieldState;
  attackerGimmickActive?: boolean;
  defenderGimmickActive?: boolean;
  defenderCurrentHpPercent?: number;
  attackerBoosts?: Partial<Record<string, number>>;
  defenderBoosts?: Partial<Record<string, number>>;
  attackerStatus?: string;
  defenderStatus?: string;
  critical?: boolean;
  // False → the attacker is past its first turn out, so Fake Out / First
  // Impression / Mat Block can't be used and are dropped from consideration.
  attackerFirstTurnOut?: boolean;
}): MatchupCell | null {
  const cands = defenderCandidates(args.opponent, args.attacker.level);
  if (!cands.length) return null;
  const atkMoves = args.attackerFirstTurnOut === false
    ? args.attacker.moves.filter(m => !isFirstTurnMove(m))
    : args.attacker.moves;

  // For each candidate, find this attacker's best move (max-damaging).
  // Tally votes by move name (which move wins most often) AND track each
  // move's min/max across all candidates. Pick the most-frequent best move;
  // tiebreak by highest sum of max damage. Report that move's range.
  const perCandidate = cands.map(c =>
    bestMoveAgainst(args.attacker, c, atkMoves, args.field, 'mine', {
      attackerGimmickActive: args.attackerGimmickActive,
      defenderGimmickActive: args.defenderGimmickActive,
      attackerBoosts: args.attackerBoosts,
      defenderBoosts: args.defenderBoosts,
      attackerStatus: args.attackerStatus,
      defenderStatus: args.defenderStatus,
      critical: args.critical,
    }),
  );
  const votes = new Map<string, { count: number; sumMax: number }>();
  for (const r of perCandidate) {
    if (!r) continue;
    const v = votes.get(r.move) ?? { count: 0, sumMax: 0 };
    v.count += 1;
    v.sumMax += r.max;
    votes.set(r.move, v);
  }
  if (votes.size === 0) return null;
  const chosenMove = [...votes.entries()].sort((a, b) =>
    b[1].count - a[1].count || b[1].sumMax - a[1].sumMax,
  )[0]![0];

  // Range of the chosen move across all candidates. Collect every roll so
  // KO odds at the end use the real distribution.
  let minPercent = Infinity;
  let maxPercent = -Infinity;
  let koChance = '';
  const allRolls: number[] = [];
  for (const c of cands) {
    try {
      const r = damageRange({
        attacker: args.attacker,
        defender: c,
        move: chosenMove,
        field: args.field,
        attackerSide: 'mine',
        attackerOpts: { gimmickActive: args.attackerGimmickActive, boosts: args.attackerBoosts, status: args.attackerStatus },
        defenderOpts: { gimmickActive: args.defenderGimmickActive, boosts: args.defenderBoosts, status: args.defenderStatus },
      });
      if (r.minPercent < minPercent) minPercent = r.minPercent;
      if (r.maxPercent > maxPercent) {
        maxPercent = r.maxPercent;
        koChance = r.koChance; // worst-case KO chance for the defender
      }
      allRolls.push(...r.percentRolls);
    } catch { /* skip */ }
  }
  if (!Number.isFinite(minPercent)) return null;
  const finalKo = args.defenderCurrentHpPercent != null && args.defenderCurrentHpPercent < 100
    ? koVsRemaining(allRolls, args.defenderCurrentHpPercent)
    : koChance;
  const likely = likelyRange(args.opponent, cands, chosenMove, c => damageRange({
    attacker: args.attacker, defender: c, move: chosenMove, field: args.field, attackerSide: 'mine',
    attackerOpts: { gimmickActive: args.attackerGimmickActive, boosts: args.attackerBoosts, status: args.attackerStatus },
    defenderOpts: { gimmickActive: args.defenderGimmickActive, boosts: args.defenderBoosts, status: args.defenderStatus },
  }));
  return {
    move: chosenMove,
    minPercent,
    maxPercent,
    koChance: finalKo,
    candidatesConsidered: cands.length,
    likelyMinPercent: likely?.min,
    likelyMaxPercent: likely?.max,
    confidence: confidenceFor(!!args.opponent.candidates?.length, minPercent, maxPercent),
    conditional: isAttackConditionalMove(chosenMove) ? 'only if target attacks' : undefined,
    percentRolls: allRolls,
  };
}

// Compute the most-likely (least-invested consistent) defender candidate's
// damage range for `move`. `cands` is in OpponentEntry.candidates order, so the
// mostLikely index maps straight across; falls back to the first candidate.
function likelyRange(
  opp: OpponentEntry,
  cands: PokemonSet[],
  _move: string,
  calc: (defender: PokemonSet) => { minPercent: number; maxPercent: number },
): { min: number; max: number } | null {
  if (!cands.length) return null;
  const li = mostLikelyIndex((opp.candidates ?? []) as any, opp.candidateLikelihoods);
  const set = cands[li >= 0 && li < cands.length ? li : 0]!;
  try {
    const r = calc(set);
    return { min: r.minPercent, max: r.maxPercent };
  } catch { return null; }
}

// Like predictOffense, but reports the range for EVERY move in the attacker's
// movepool rather than just the voted "best" one. The BattleScreen matchup
// grid surfaces this when the user presses `a` to expand the cell. Moves that
// can't be calculated against any candidate (e.g. status moves, or move names
// the calc rejects) are silently omitted.
//
// Sort order: highest max damage first, so the user sees their strongest
// option at the top.
export function predictOffenseAll(args: {
  attacker: PokemonSet;
  opponent: OpponentEntry;
  field: FieldState;
  attackerGimmickActive?: boolean;
  defenderGimmickActive?: boolean;
  defenderCurrentHpPercent?: number;
  attackerBoosts?: Partial<Record<string, number>>;
  defenderBoosts?: Partial<Record<string, number>>;
  attackerStatus?: string;
  defenderStatus?: string;
  critical?: boolean;
  attackerFirstTurnOut?: boolean;
}): MatchupCell[] {
  const cands = defenderCandidates(args.opponent, args.attacker.level);
  if (!cands.length) return [];
  const atkMoves = args.attackerFirstTurnOut === false
    ? args.attacker.moves.filter(m => !isFirstTurnMove(m))
    : args.attacker.moves;
  const out: MatchupCell[] = [];
  for (const move of atkMoves) {
    let minPercent = Infinity;
    let maxPercent = -Infinity;
    let koChance = '';
    const allRolls: number[] = [];
    for (const c of cands) {
      try {
        const r = damageRange({
          attacker: args.attacker,
          defender: c,
          move,
          field: args.field,
          attackerSide: 'mine',
          attackerOpts: { gimmickActive: args.attackerGimmickActive, boosts: args.attackerBoosts, status: args.attackerStatus },
          defenderOpts: { gimmickActive: args.defenderGimmickActive, boosts: args.defenderBoosts, status: args.defenderStatus },
          critical: args.critical,
        });
        if (r.minPercent < minPercent) minPercent = r.minPercent;
        if (r.maxPercent > maxPercent) {
          maxPercent = r.maxPercent;
          koChance = r.koChance;
        }
        allRolls.push(...r.percentRolls);
      } catch { /* skip — move/calc failure shouldn't drop the whole row */ }
    }
    if (!Number.isFinite(minPercent)) continue;
    const finalKo = args.defenderCurrentHpPercent != null && args.defenderCurrentHpPercent < 100
      ? koVsRemaining(allRolls, args.defenderCurrentHpPercent)
      : koChance;
    const likely = likelyRange(args.opponent, cands, move, c => damageRange({
      attacker: args.attacker, defender: c, move, field: args.field, attackerSide: 'mine',
      attackerOpts: { gimmickActive: args.attackerGimmickActive, boosts: args.attackerBoosts, status: args.attackerStatus },
      defenderOpts: { gimmickActive: args.defenderGimmickActive, boosts: args.defenderBoosts, status: args.defenderStatus },
      critical: args.critical,
    }));
    out.push({
      move,
      minPercent,
      maxPercent,
      koChance: finalKo,
      candidatesConsidered: cands.length,
      likelyMinPercent: likely?.min,
      likelyMaxPercent: likely?.max,
      confidence: confidenceFor(!!args.opponent.candidates?.length, minPercent, maxPercent),
    });
  }
  out.sort((a, b) => b.maxPercent - a.maxPercent);
  return out;
}

// OPP damage TO me. Uses opp.knownMoves when present, else Pikalytics top
// moves, else falls back to the species' STAB types as a last resort
// (empty array → we'll return null which the UI shows as n/a).
export function predictThreat(args: {
  opponent: OpponentEntry;
  defender: PokemonSet;
  field: FieldState;
  attackerGimmickActive?: boolean;
  defenderGimmickActive?: boolean;
  defenderCurrentHpPercent?: number;
  attackerBoosts?: Partial<Record<string, number>>;
  defenderBoosts?: Partial<Record<string, number>>;
  attackerStatus?: string;
  defenderStatus?: string;
  critical?: boolean;
  // False → this opp is past its first turn out: drop Fake Out / First
  // Impression / Mat Block from its threat pool (they can't fire).
  attackerFirstTurnOut?: boolean;
}): MatchupCell | null {
  let moves = args.opponent.knownMoves.length
    ? args.opponent.knownMoves
    : pikalyticsMoves(args.opponent.species);
  // Move-restricting volatiles: Encore forces a single move; Disable removes one.
  if (args.opponent.encoreMove) moves = [args.opponent.encoreMove];
  else if (args.opponent.disabledMove) moves = moves.filter(m => m !== args.opponent.disabledMove);
  if (args.attackerFirstTurnOut === false) moves = moves.filter(m => !isFirstTurnMove(m));
  if (!moves.length) return null;

  const cands = defenderCandidates(args.opponent, args.defender.level);
  // Worst-case-for-me: pick the (move, candidate) that maxes damage.
  let best: { move: string; min: number; max: number; koChance: string } | null = null;
  for (const c of cands) {
    const r = bestMoveAgainst(c, args.defender, moves, args.field, 'theirs', {
      attackerGimmickActive: args.attackerGimmickActive,
      defenderGimmickActive: args.defenderGimmickActive,
      attackerBoosts: args.attackerBoosts,
      defenderBoosts: args.defenderBoosts,
      attackerStatus: args.attackerStatus,
      defenderStatus: args.defenderStatus,
      critical: args.critical,
    });
    if (r && (!best || r.max > best.max)) best = r;
  }
  if (!best) return null;

  // Range of the chosen worst-case move across all candidates. Collect every
  // roll so KO odds use the real distribution.
  const chosenMove = best.move;
  let minPercent = Infinity;
  let maxPercent = -Infinity;
  let koChance = best.koChance;
  const allRolls: number[] = [];
  for (const c of cands) {
    try {
      const r = damageRange({
        attacker: c,
        defender: args.defender,
        move: chosenMove,
        field: args.field,
        attackerSide: 'theirs',
        attackerOpts: { gimmickActive: args.attackerGimmickActive, boosts: args.attackerBoosts, status: args.attackerStatus },
        defenderOpts: { gimmickActive: args.defenderGimmickActive, boosts: args.defenderBoosts, status: args.defenderStatus },
      });
      if (r.minPercent < minPercent) minPercent = r.minPercent;
      if (r.maxPercent > maxPercent) {
        maxPercent = r.maxPercent;
        koChance = r.koChance;
      }
      allRolls.push(...r.percentRolls);
    } catch { /* skip */ }
  }
  if (!Number.isFinite(minPercent)) return null;
  const finalKo = args.defenderCurrentHpPercent != null && args.defenderCurrentHpPercent < 100
    ? koVsRemaining(allRolls, args.defenderCurrentHpPercent)
    : koChance;
  // Likely range here = the opp's most-likely (least-invested) ATTACKING spread.
  const likely = likelyRange(args.opponent, cands, chosenMove, c => damageRange({
    attacker: c, defender: args.defender, move: chosenMove, field: args.field, attackerSide: 'theirs',
    attackerOpts: { gimmickActive: args.attackerGimmickActive, boosts: args.attackerBoosts, status: args.attackerStatus },
    defenderOpts: { gimmickActive: args.defenderGimmickActive, boosts: args.defenderBoosts, status: args.defenderStatus },
  }));
  return {
    move: chosenMove,
    minPercent,
    maxPercent,
    koChance: finalKo,
    candidatesConsidered: cands.length,
    likelyMinPercent: likely?.min,
    likelyMaxPercent: likely?.max,
    confidence: confidenceFor(!!args.opponent.candidates?.length, minPercent, maxPercent),
    conditional: isAttackConditionalMove(chosenMove) ? 'only if you attack' : undefined,
    percentRolls: allRolls,
  };
}

// Like predictThreat, but reports a range for EVERY move in the opponent's
// expected pool (knownMoves when we've seen any, else Pikalytics top moves)
// rather than only the single worst one. Used by /ask to show what each of the
// opponent's likely moves does to me. Sorted by max damage, strongest first.
export function predictThreatAll(args: {
  opponent: OpponentEntry;
  defender: PokemonSet;
  field: FieldState;
  attackerGimmickActive?: boolean;
  defenderGimmickActive?: boolean;
  defenderCurrentHpPercent?: number;
  attackerBoosts?: Partial<Record<string, number>>;
  defenderBoosts?: Partial<Record<string, number>>;
  attackerStatus?: string;
  defenderStatus?: string;
  critical?: boolean;
  attackerFirstTurnOut?: boolean;
}): MatchupCell[] {
  let moves = args.opponent.knownMoves.length
    ? args.opponent.knownMoves
    : pikalyticsMoves(args.opponent.species);
  if (args.opponent.encoreMove) moves = [args.opponent.encoreMove];
  else if (args.opponent.disabledMove) moves = moves.filter(m => m !== args.opponent.disabledMove);
  if (args.attackerFirstTurnOut === false) moves = moves.filter(m => !isFirstTurnMove(m));
  if (!moves.length) return [];

  const cands = defenderCandidates(args.opponent, args.defender.level);
  if (!cands.length) return [];
  const out: MatchupCell[] = [];
  for (const move of moves) {
    let minPercent = Infinity;
    let maxPercent = -Infinity;
    let koChance = '';
    const allRolls: number[] = [];
    for (const c of cands) {
      try {
        const r = damageRange({
          attacker: c, defender: args.defender, move, field: args.field, attackerSide: 'theirs',
          attackerOpts: { gimmickActive: args.attackerGimmickActive, boosts: args.attackerBoosts, status: args.attackerStatus },
          defenderOpts: { gimmickActive: args.defenderGimmickActive, boosts: args.defenderBoosts, status: args.defenderStatus },
          critical: args.critical,
        });
        if (r.minPercent < minPercent) minPercent = r.minPercent;
        if (r.maxPercent > maxPercent) { maxPercent = r.maxPercent; koChance = r.koChance; }
        allRolls.push(...r.percentRolls);
      } catch { /* skip — a status / uncalculable move shouldn't drop the row */ }
    }
    if (!Number.isFinite(minPercent)) continue; // no damaging variant of this move
    const finalKo = args.defenderCurrentHpPercent != null && args.defenderCurrentHpPercent < 100
      ? koVsRemaining(allRolls, args.defenderCurrentHpPercent)
      : koChance;
    const likely = likelyRange(args.opponent, cands, move, c => damageRange({
      attacker: c, defender: args.defender, move, field: args.field, attackerSide: 'theirs',
      attackerOpts: { gimmickActive: args.attackerGimmickActive, boosts: args.attackerBoosts, status: args.attackerStatus },
      defenderOpts: { gimmickActive: args.defenderGimmickActive, boosts: args.defenderBoosts, status: args.defenderStatus },
      critical: args.critical,
    }));
    out.push({
      move, minPercent, maxPercent, koChance: finalKo,
      candidatesConsidered: cands.length,
      likelyMinPercent: likely?.min, likelyMaxPercent: likely?.max,
      confidence: confidenceFor(!!args.opponent.candidates?.length, minPercent, maxPercent),
      conditional: isAttackConditionalMove(move) ? 'only if you attack' : undefined,
    });
  }
  out.sort((a, b) => b.maxPercent - a.maxPercent);
  return out;
}

// Per-pair speed comparison. Tailwind and Trick Room are applied here so the
// UI doesn't have to. If both bounds are unknown, returns 'unknown'.
//
// Without TR, "I move first" iff my effective speed > opp's. So:
//   definitely first  ↔  mySpd > opp.speedCeiling (I'm above their max)
//   definitely second ↔  mySpd < opp.speedFloor   (I'm below their min)
// With TR the comparison inverts: I move first iff my speed < opp's. So:
//   definitely first  ↔  mySpd < opp.speedFloor
//   definitely second ↔  mySpd > opp.speedCeiling
// scarf-flag overrides 'faster'/'unknown' (the scarf concern is "they might
// outspeed despite my prediction"); a definitive 'slower' stays as-is since
// scarf can't help opp more than we already assume.
export function speedVerdict(args: {
  mySet: PokemonSet;
  opp: OpponentEntry;
  field: FieldState;
  /** Forme override for mySet — e.g. the post-mega forme name. Lets the
   *  matchup grid render a "what if I mega'd" verdict without rebuilding
   *  the whole set. */
  myFormeOverride?: string;
}): SpeedVerdict {
  let mySpd = actualSpeed(args.mySet, args.myFormeOverride);
  if (args.field.myTailwind) mySpd *= 2;

  let oppLow = args.opp.speedFloor;
  let oppHigh = args.opp.speedCeiling;
  if (args.field.theirTailwind) {
    if (oppLow != null) oppLow *= 2;
    if (oppHigh != null) oppHigh *= 2;
  }
  const scarfFlag = !!args.opp.scarfSuspected;
  const tr = !!args.field.trickRoom;

  let verdict: SpeedVerdict;
  if (oppLow == null && oppHigh == null) {
    verdict = 'unknown';
  } else if (!tr) {
    if (oppHigh != null && mySpd > oppHigh) verdict = 'faster';
    else if (oppLow != null && mySpd < oppLow) verdict = 'slower';
    else verdict = 'unknown';
  } else {
    // Trick Room: lower stat moves first.
    if (oppLow != null && mySpd < oppLow) verdict = 'faster';
    else if (oppHigh != null && mySpd > oppHigh) verdict = 'slower';
    else verdict = 'unknown';
  }

  if (scarfFlag && verdict !== 'slower') return 'scarf-flag';
  return verdict;
}
