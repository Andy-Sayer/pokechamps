// Convert an OpponentEntry into a synthetic PokemonSet suitable for the
// Showdown exporter. Used to dump observed/inferred opponent info from a
// saved match — gives the user a scouting export they can paste into the
// Showdown teambuilder or hand to a friend.
//
// What's known vs guessed:
//   - species + level: known (or default 50)
//   - knownMoves: only moves we've actually seen the mon use this match.
//   - ability / item / nature / EVs: from mostLikely(candidates) when the
//     inference solver has produced a set; otherwise omitted (Showdown
//     accepts a bare species + moves list).
//   - IVs: assumed 31 across the board (PoChamps fixed-IV model).
import type { OpponentEntry, PokemonSet, Match } from './types.js';
import { MAX_IVS, ZERO_EVS } from './types.js';
import { mostLikely } from './inference.js';
import { formatShowdownTeam } from './showdown.js';

export interface ScoutOptions {
  /** Default level for unknown opp levels. PoChamps is 50 across the board. */
  defaultLevel?: number;
}

// Build a partial PokemonSet from what we know about an opponent. Missing
// fields are filled with sensible defaults; the Showdown formatter skips
// non-default sections (e.g. an all-zero EV spread emits no EVs line).
export function opponentToScoutedSet(opp: OpponentEntry, opts: ScoutOptions = {}): PokemonSet {
  const level = opp.level ?? opts.defaultLevel ?? 50;
  // Candidates are duck-typed as SpreadCandidate by the inference solver
  // (no ivs field), but stored on OpponentEntry as PokemonSet[]. Pull ivs
  // off the actual cast when present.
  const top = opp.candidates?.length ? mostLikely(opp.candidates as any) : null;
  const topSet = top as PokemonSet | null;
  return {
    species: opp.species,
    level,
    item: opp.itemConsumed ?? topSet?.item ?? opp.item ?? undefined,
    ability: topSet?.ability ?? opp.ability ?? undefined,
    nature: topSet?.nature ?? 'Hardy',
    evs: topSet?.evs ?? { ...ZERO_EVS },
    ivs: topSet?.ivs ?? { ...MAX_IVS },
    moves: opp.knownMoves.length ? [...opp.knownMoves] : [],
  };
}

// Full scouting export for a saved match: every opponent we observed gets
// a Showdown set, with a header comment block summarising what's known.
// Annotations live in single-line comments above each set so the export
// stays paste-compatible with Showdown (which ignores leading // lines if
// they're outside a set — but to be safe we put them all up top in one
// block, then emit the canonical Showdown text below).
export function exportScoutedOpponents(match: Match): string {
  const seen = match.opponentTeam.filter(o => match.opponentBrought?.includes(match.opponentTeam.indexOf(o) as any));
  const targets = seen.length ? seen : match.opponentTeam;

  const header: string[] = [];
  header.push(`// Scouted opponents from match ${match.id}`);
  header.push(`// Date: ${match.startedAt}`);
  header.push(`// Outcome: ${match.outcome ?? 'in-progress'}`);
  header.push(`//`);
  for (const opp of targets) {
    const top = opp.candidates?.length ? mostLikely(opp.candidates) : null;
    const certainty = top ? `inferred from ${opp.candidates!.length} candidate spread(s)` : 'no spread inference';
    const speed = opp.speedFloor != null || opp.speedCeiling != null
      ? `speed ${opp.speedFloor ?? '?'}-${opp.speedCeiling ?? '?'}`
      : 'speed unknown';
    const scarf = opp.scarfChance != null && opp.scarfChance > 0 ? ` · scarf ${opp.scarfChance}%` : '';
    header.push(`// ${opp.species}: ${certainty} · ${speed}${scarf}`);
  }
  header.push('');

  const sets = targets.map(o => opponentToScoutedSet(o));
  return header.join('\n') + formatShowdownTeam(sets);
}
