/**
 * endgame.ts — 1-ply endgame solver for Pokémon doubles.
 *
 * Given my two active mons, the opponent's two active mons, and the current
 * field state, recommend the best move for each of my mons by evaluating a
 * position score that accounts for:
 *   + KOs I can secure this turn (binary bonus)
 *   + fraction of HP I can remove from the target
 *   - worst-case retaliation each surviving opp can deal to my mon
 *
 * This is a 1-ply minimax heuristic (I pick my best action, opponent responds
 * with their worst-case for me). It is NOT exhaustive: no tree search, no
 * priority modelling, no switch prediction. Keep it fast and transparent.
 *
 * All exported functions are PURE — no I/O, no mutation of inputs.
 */

import type { PokemonSet, OpponentEntry, FieldState } from './types.js';
import { predictOffense, predictThreat } from './predictions.js';

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

/** One of my active mons with its current remaining HP. */
export interface MyActiveMon {
  set: PokemonSet;
  /** Remaining HP as 0–100 percent of max. */
  currentHpPercent: number;
}

/** One of the opponent's active mons with its current remaining HP. */
export interface OppActiveMon {
  entry: OpponentEntry;
  /** Remaining HP as 0–100 percent of max. */
  currentHpPercent: number;
}

/** Full snapshot passed to the solver. */
export interface EndgamePosition {
  /** Up to 2 of my active mons (absent/fainted slots are simply omitted). */
  mine: MyActiveMon[];
  /** Up to 2 of the opponent's active mons. */
  opp: OppActiveMon[];
  field: FieldState;
}

/** Recommendation for a single one of my mons. */
export interface MonRecommendation {
  /** Species name of my mon. */
  mySpecies: string;
  /** Species name of the recommended target. */
  targetSpecies: string;
  /** Best move to use against that target. */
  move: string;
  /**
   * True when the likely damage range covers at least the target's remaining
   * HP (i.e., `likelyMaxPercent >= currentHpPercent`). Falls back to
   * `maxPercent` when no `likelyMaxPercent` is available.
   */
  likelyKo: boolean;
  /**
   * Composite position score (higher = better for me). Transparent breakdown:
   *   offenseScore  = KO_BONUS (10) if likelyKo, else (likelyMaxPercent ?? maxPercent) / 100
   *   retaliationPenalty = (opp worst-case maxPercent against this mon) / 100
   *   netScore = offenseScore - retaliationPenalty
   */
  netScore: number;
  /** Breakdown for display / debugging. */
  breakdown: {
    offenseScore: number;
    retaliationPenalty: number;
  };
}

/** Full solver output: one recommendation per live mon of mine, best first. */
export interface EndgameResult {
  recommendations: MonRecommendation[];
}

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

/**
 * Bonus applied when a move is a likely KO this turn. Deliberately large
 * (> 1.0) so securing a KO outweighs any HP-fraction gain from a non-KO.
 */
const KO_BONUS = 10;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the worst-case retaliation penalty: the highest `maxPercent` any
 * live opp mon can deal to `myMon` across all opp mons (each opp independently
 * picks their best move). We use `maxPercent` (worst-case for me) to be
 * conservative.
 *
 * Returns a value in [0, ∞) — realistically 0–2 (mons rarely deal > 200%).
 * If no opp threat can be calculated, returns 0 (safe default: we don't
 * penalise what we can't measure).
 */
function worstCaseRetaliation(
  myMon: MyActiveMon,
  opps: OppActiveMon[],
  field: FieldState,
): number {
  let worst = 0;
  for (const opp of opps) {
    if (opp.entry.fainted) continue;
    if (opp.currentHpPercent <= 0) continue;

    const threat = predictThreat({
      opponent: opp.entry,
      defender: myMon.set,
      field,
      defenderCurrentHpPercent: myMon.currentHpPercent,
    });
    if (!threat) continue;

    // Use maxPercent as the conservative worst-case damage to my mon.
    const dmg = threat.maxPercent / 100;
    if (dmg > worst) worst = dmg;
  }
  return worst;
}

/**
 * Score my mon attacking `target` — returns null when predictOffense returns
 * null (no calculable moves).
 */
function scoreAttack(
  myMon: MyActiveMon,
  target: OppActiveMon,
  field: FieldState,
): { move: string; offenseScore: number; likelyKo: boolean } | null {
  const cell = predictOffense({
    attacker: myMon.set,
    opponent: target.entry,
    field,
    defenderCurrentHpPercent: target.currentHpPercent,
  });
  if (!cell) return null;

  // Use the "likely" range when available (more precise), else the full envelope.
  const likelyMax = cell.likelyMaxPercent ?? cell.maxPercent;
  const likelyMin = cell.likelyMinPercent ?? cell.minPercent;

  // A "likely KO" is when the LIKELY damage (not just the optimistic max roll)
  // covers the target's remaining HP. We use the midpoint of the likely range
  // to avoid being over-optimistic on one-hit checks.
  const likelyMid = (likelyMin + likelyMax) / 2;
  const likelyKo = likelyMid >= target.currentHpPercent;

  const offenseScore = likelyKo
    ? KO_BONUS
    : likelyMax / 100; // fraction of defender max HP removed (likely best case)

  return { move: cell.move, offenseScore, likelyKo };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Solve the endgame position and return a ranked list of recommendations —
 * one per live mon on my side.
 *
 * Algorithm (1-ply minimax heuristic):
 *   For each of my live mons:
 *     For each live opp mon:
 *       1. Compute offenseScore for attacking that opp.
 *       2. Compute retaliationPenalty = worst-case damage ANY surviving opp
 *          can deal to this mon (assumes all non-targeted opps still respond).
 *          Note: if the chosen attack IS a likely KO, that opp slot is
 *          treated as empty for the retaliation calc (they're KO'd).
 *       3. netScore = offenseScore - retaliationPenalty.
 *     Pick the (target, move) with the highest netScore for this mon.
 *   Sort all recommendations by netScore descending.
 *
 * Returns an empty `recommendations` array when my side is empty or every
 * result produced a null offenseScore (all moves failed to calculate).
 */
export function solveEndgame(pos: EndgamePosition): EndgameResult {
  const liveOpps = pos.opp.filter(o => !o.entry.fainted && o.currentHpPercent > 0);

  const recs: MonRecommendation[] = [];

  for (const myMon of pos.mine) {
    if (myMon.currentHpPercent <= 0) continue; // I'm fainted — skip.

    let bestRec: MonRecommendation | null = null;

    if (liveOpps.length === 0) {
      // No live opponents — produce a "no-op" recommendation so the caller
      // still gets a result for this mon (e.g. to confirm position is won).
      recs.push({
        mySpecies: myMon.set.species,
        targetSpecies: '',
        move: '',
        likelyKo: false,
        netScore: 0,
        breakdown: { offenseScore: 0, retaliationPenalty: 0 },
      });
      continue;
    }

    for (const target of liveOpps) {
      const atk = scoreAttack(myMon, target, pos.field);
      if (!atk) continue; // no calculable move vs this target

      // If this attack is a likely KO, the targeted opp doesn't retaliate.
      const survivingOpps = atk.likelyKo
        ? liveOpps.filter(o => o !== target)
        : liveOpps;

      const retaliationPenalty = worstCaseRetaliation(myMon, survivingOpps, pos.field);
      const netScore = atk.offenseScore - retaliationPenalty;

      if (!bestRec || netScore > bestRec.netScore) {
        bestRec = {
          mySpecies: myMon.set.species,
          targetSpecies: target.entry.species,
          move: atk.move,
          likelyKo: atk.likelyKo,
          netScore,
          breakdown: { offenseScore: atk.offenseScore, retaliationPenalty },
        };
      }
    }

    if (bestRec) {
      recs.push(bestRec);
    } else {
      // All targets produced null offense (no calculable moves) — push a
      // sentinel so the caller knows this mon couldn't find a damage option.
      recs.push({
        mySpecies: myMon.set.species,
        targetSpecies: liveOpps[0]!.entry.species,
        move: '',
        likelyKo: false,
        netScore: -Infinity,
        breakdown: { offenseScore: 0, retaliationPenalty: 0 },
      });
    }
  }

  // Sort best first.
  recs.sort((a, b) => {
    // Push -Infinity sentinels to the back.
    if (!isFinite(a.netScore) && !isFinite(b.netScore)) return 0;
    if (!isFinite(a.netScore)) return 1;
    if (!isFinite(b.netScore)) return -1;
    return b.netScore - a.netScore;
  });

  return { recommendations: recs };
}
