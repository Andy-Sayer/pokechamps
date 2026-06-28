// Training-data extraction for the purpose-trained model (future-directions §1 /
// training-data-plan.md). Task A = bring/outcome value: learn which BRING (4 of 6)
// wins, from real games. This turns a parsed replay BattleTranscript into rows of
// (team, bring, opp team, opp bring, won). Pure + deterministic; the dataset
// exporter (scripts/export-training.ts) walks the replay corpus through it.
//
// NOTE on fidelity: Showdown replays are a gen9-VGC PROXY (not Champions) and
// only OTS (`fromTeamSheet`) games reveal the full 6 — which bring SELECTION
// training needs (you can't learn to choose 4-of-6 without knowing the 6). Rows
// carry `source` + `fullTeam` so a trainer can weight/filter accordingly.
import type { BattleTranscript, Side } from './showdownReplay.js';

export interface BringOutcomeRow {
  source: 'showdown-replay' | 'match-snapshot';
  gameId: string;
  format?: string;
  side: Side;
  player?: string;
  /** This side's KNOWN team species — the full 6 when `fullTeam` (OTS), else just
   *  the brought (seen) mons. */
  team: string[];
  /** Species this side actually brought (appeared on the field). */
  bring: string[];
  oppTeam: string[];
  oppBring: string[];
  /** null when the winner is unknown (tie / truncated log). */
  won: boolean | null;
  /** The full 6 is known (OTS) — required to train bring SELECTION, not just
   *  outcome correlation. */
  fullTeam: boolean;
}

const OTHER: Record<Side, Side> = { p1: 'p2', p2: 'p1' };

/** Extract per-side bring/outcome rows from a parsed replay transcript. */
export function bringOutcomeRows(t: BattleTranscript, gameId: string): BringOutcomeRow[] {
  // Brought = the distinct species that appeared (lead + every switch).
  const brought: Record<Side, Set<string>> = { p1: new Set(), p2: new Set() };
  for (const e of [...t.leadEvents, ...t.turns.flatMap(tn => tn.events)]) {
    if (e.kind === 'switch') brought[e.pos.side].add(e.species);
  }
  const speciesOf = (s: Side) => (t.teams[s] ?? []).map(m => m.species);
  // A real, complete 6-mon team (OTS) — bring SELECTION needs the bench, so a
  // partial sighting (≤4) doesn't count even if it carried a team-sheet flag.
  const isFull = (s: Side) => speciesOf(s).length === 6;
  const wonBy = (s: Side): boolean | null => (t.winner == null ? null : t.players[s] === t.winner);

  return (['p1', 'p2'] as const).map((s): BringOutcomeRow => {
    const o = OTHER[s];
    return {
      source: 'showdown-replay', gameId, format: t.format, side: s, player: t.players[s],
      team: speciesOf(s), bring: [...brought[s]], oppTeam: speciesOf(o), oppBring: [...brought[o]],
      won: wonBy(s), fullTeam: isFull(s),
    };
  });
}
