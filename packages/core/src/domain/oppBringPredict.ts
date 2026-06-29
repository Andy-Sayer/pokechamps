// Opponent-bring prediction — the secondary task of the team chooser. Symmetric to
// our OWN bring decision: the opponent brings the 4 that are best for THEM against
// OUR team, so we predict it with the same technique (scoreBrings) with the sides
// flipped — score the opponent's brings vs our full team. Two stages:
//   (1) predictOppBring  — at preview, their likely 4-of-6 (and alternatives).
//   (2) predictOppBack   — once their two leads are revealed, the likely back two
//       (filter their candidate brings to those containing both leads, re-rank).
// Fast/heuristic (live-suitable). For an offline, higher-confidence read, the same
// can be playout-validated by flipping the args to bringEval.bestBringVsOpponent.
import { scoreBrings } from './bring.js';
import { entryOf } from './teamSim.js';
import type { PokemonSet } from './types.js';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface OppBringGuess { bring: PokemonSet[]; score: number }
export interface OppBringPrediction {
  /** Most-likely 4 the opponent brings vs our team. */
  likely: PokemonSet[];
  score: number;
  /** Next-most-likely brings, for hedging. */
  alternatives: OppBringGuess[];
  /** How decisive the top pick is over the next (score gap, normalized) — a rough
   *  confidence: a big gap = they're "locked in", a small gap = genuinely a toss-up. */
  confidence: number;
}

/** Predict the opponent's bring vs our team. `topK` alternatives surfaced. */
export function predictOppBring(oppSets: PokemonSet[], myTeam: PokemonSet[], topK = 3): OppBringPrediction {
  const ranked = scoreBrings(oppSets, myTeam.map(entryOf)); // their brings, scored vs us
  const top = ranked[0]!;
  const second = ranked[1];
  const span = Math.abs(top.total) + 1;
  return {
    likely: top.myIndices.map(i => oppSets[i]!),
    score: top.total,
    alternatives: ranked.slice(1, 1 + topK).map(b => ({ bring: b.myIndices.map(i => oppSets[i]!), score: b.total })),
    confidence: second ? Math.min(1, (top.total - second.total) / span) : 1,
  };
}

export interface OppBackGuess { back: PokemonSet[]; full: PokemonSet[]; score: number }

/** Once the opponent's two leads are revealed, predict what's in the back: keep
 *  only their candidate brings that contain BOTH leads, ranked by score vs us; the
 *  back two are the bring minus the leads. Returns top-`topK` completions. */
export function predictOppBack(oppSets: PokemonSet[], myTeam: PokemonSet[], leadSpecies: string[], topK = 3): OppBackGuess[] {
  const leadIds = leadSpecies.map(norm);
  const ranked = scoreBrings(oppSets, myTeam.map(entryOf));
  const matching = ranked.filter(b => {
    const sp = b.myIndices.map(i => norm(oppSets[i]!.species));
    return leadIds.every(l => sp.includes(l));
  });
  return matching.slice(0, topK).map(b => {
    const full = b.myIndices.map(i => oppSets[i]!);
    return { full, back: full.filter(m => !leadIds.includes(norm(m.species))), score: b.total };
  });
}
