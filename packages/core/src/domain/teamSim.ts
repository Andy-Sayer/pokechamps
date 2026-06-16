// Shared team-vs-team battle simulation, used by the team scripts (anti-meta,
// fine-tune, suggest) AND the parallel worker so the sequential and parallel
// paths can never disagree. One matchup = both sides pick their bring
// intelligently (symmetric scoreBrings, open team sheets), then the maximin
// lookahead (searchIterative — the in-battle "best play" engine) scores the
// brought position under mutual best play.
import { scoreBrings } from './bring.js';
import { searchIterative, searchBudgeted, type SearchInput } from './endgameSearch.js';
import type { PokemonSet, OpponentEntry } from './types.js';
import { NEUTRAL_FIELD } from './types.js';

export interface Matchup {
  anchor: string;
  score: number;
  verdict: string;
  myBring: string[];
}

/** Full-knowledge OpponentEntry for a known set: species/ability/item revealed,
 *  candidates pinned to the TRUE set so every damage calc runs on the real
 *  spread. */
export function entryOf(set: PokemonSet): OpponentEntry {
  return {
    species: set.species,
    ability: set.ability, item: set.item,
    knownMoves: set.moves,
    candidates: [set], candidateLikelihoods: [1],
  };
}

/** Build the opening SearchInput for `mine` vs `oppSets`: each side picks its
 *  best bring knowing the other's six (open team sheets), leads in the first two
 *  brought, all at full HP, neutral field. Shared by `evaluateMatchup` and the
 *  policy audit so both reason about the exact same opening position. */
export function buildMatchupInput(mine: PokemonSet[], oppSets: PokemonSet[]): { input: SearchInput; myBring: number[] } {
  const oppEntries = oppSets.map(entryOf);
  const myEntries = mine.map(entryOf);
  const myBring = scoreBrings(mine, oppEntries)[0]!;
  const oppBring = scoreBrings(oppSets, myEntries)[0]!;
  const input: SearchInput = {
    mine: myBring.myIndices.map((i, k) => ({ set: mine[i]!, hpPercent: 100, active: k < 2 })),
    opp: oppBring.myIndices.map((j, k) => ({ entry: oppEntries[j]!, hpPercent: 100, active: k < 2 })),
    field: { ...NEUTRAL_FIELD },
    allOppRevealed: true,
  };
  return { input, myBring: myBring.myIndices };
}

/** One simulated matchup. `depth` is the (max) lookahead; when `budgetMs` is
 *  given the search deepens 1→depth under a per-position wall-clock budget
 *  (anytime — as deep as the board allows in the time), else it runs the full
 *  fixed `depth`. Pure + deterministic (the budget only caps how deep it gets). */
export function evaluateMatchup(
  mine: PokemonSet[],
  oppSets: PokemonSet[],
  oppAnchor: string,
  depth: number,
  budgetMs?: number,
): Matchup {
  const { input, myBring } = buildMatchupInput(mine, oppSets);
  const r = budgetMs ? searchBudgeted(input, depth, budgetMs) : searchIterative(input, depth);
  return { anchor: oppAnchor, score: r.score, verdict: r.verdict, myBring: myBring.map(i => mine[i]!.species) };
}
