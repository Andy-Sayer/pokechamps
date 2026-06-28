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
/** Build the opening SearchInput for a SPECIFIC bring pair (team-index arrays). */
function bringInput(mine: PokemonSet[], oppEntries: OpponentEntry[], myIdx: number[], oppIdx: number[]): SearchInput {
  return {
    mine: myIdx.map((i, k) => ({ set: mine[i]!, hpPercent: 100, active: k < 2 })),
    opp: oppIdx.map((j, k) => ({ entry: oppEntries[j]!, hpPercent: 100, active: k < 2 })),
    field: { ...NEUTRAL_FIELD },
    allOppRevealed: true,
  };
}

export function buildMatchupInput(mine: PokemonSet[], oppSets: PokemonSet[]): { input: SearchInput; myBring: number[] } {
  const oppEntries = oppSets.map(entryOf);
  const myEntries = mine.map(entryOf);
  const myBring = scoreBrings(mine, oppEntries)[0]!.myIndices;
  const oppBring = scoreBrings(oppSets, myEntries)[0]!.myIndices;
  return { input: bringInput(mine, oppEntries, myBring, oppBring), myBring };
}

/** One simulated matchup. `depth` is the (max) lookahead; when `budgetMs` is
 *  given the search deepens 1→depth under a per-position wall-clock budget
 *  (anytime — as deep as the board allows in the time), else it runs the full
 *  fixed `depth`. Pure + deterministic (the budget only caps how deep it gets).
 *
 *  `bringK` makes the BRING decision a real game instead of a heuristic guess:
 *  instead of trusting `scoreBrings[0]`, search each side's top-`bringK`
 *  candidate brings and take the MAXIMIN — I pick the bring whose worst case
 *  over the opponent's top-`oppBringK` brings is best. `bringK = 1` (default)
 *  reproduces the legacy single-search behaviour exactly. Cost is up to
 *  `bringK × oppBringK` searches per matchup. */
export function evaluateMatchup(
  mine: PokemonSet[],
  oppSets: PokemonSet[],
  oppAnchor: string,
  depth: number,
  budgetMs?: number,
  opts?: { bringK?: number; oppBringK?: number },
): Matchup {
  const myK = Math.max(1, opts?.bringK ?? 1);
  const oppK = Math.max(1, opts?.oppBringK ?? opts?.bringK ?? 1);
  const oppEntries = oppSets.map(entryOf);
  const myEntries = mine.map(entryOf);
  const myBrings = scoreBrings(mine, oppEntries).slice(0, myK).map(b => b.myIndices);
  const oppBrings = scoreBrings(oppSets, myEntries).slice(0, oppK).map(b => b.myIndices);
  const run = (myIdx: number[], oppIdx: number[]) => {
    const input = bringInput(mine, oppEntries, myIdx, oppIdx);
    return budgetMs ? searchBudgeted(input, depth, budgetMs) : searchIterative(input, depth);
  };
  // Maximin over candidate brings: my chosen bring maximises its worst case
  // against the opponent's candidate brings (so I never assume the opp brings
  // a bring that's convenient for me).
  let best: { score: number; myIdx: number[]; verdict: string } | null = null;
  for (const myIdx of myBrings) {
    let worst: { score: number; verdict: string } | null = null;
    for (const oppIdx of oppBrings) {
      const r = run(myIdx, oppIdx);
      if (!worst || r.score < worst.score) worst = { score: r.score, verdict: r.verdict };
    }
    if (!best || worst!.score > best.score) best = { score: worst!.score, myIdx, verdict: worst!.verdict };
  }
  return { anchor: oppAnchor, score: best!.score, verdict: best!.verdict, myBring: best!.myIdx.map(i => mine[i]!.species) };
}
