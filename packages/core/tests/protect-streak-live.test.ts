// A LIVE match must tell the search when a mon protected last turn. Gen 9 divides
// Protect's success by 3 for each consecutive use, and the search already models that
// (myProtectStreak → the PROTECT option is withheld) — but searchInputFromMatch never
// populated it, so every live turn looked like a fresh streak and the recommender would
// suggest Protect on back-to-back turns. Protect is the move you lean on to stall Trick
// Room / Tailwind / weather and to dodge Fake Out, so over-suggesting it is costly.
import { describe, test, expect } from 'vitest';
import { searchInputFromMatch } from '../src/domain/endgameSearch.js';
import type { Match, MoveAction, OpponentEntry, PokemonSet } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
const ACTIVE = { mine: [0, 1] as [number | null, number | null], theirs: [0, 1] as [number | null, number | null] };

const freshMatch = (): Match => ({
  id: 't', startedAt: '2026-07-25T00:00:00.000Z',
  myTeam: [
    mon({ species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake', 'Protect'] }),
    mon({ species: 'Glimmora', ability: 'Toxic Debris', moves: ['Power Gem', 'Spiky Shield'] }),
  ],
  opponentTeam: [
    { species: 'Incineroar', knownMoves: ['Fake Out', 'Protect'] } as OpponentEntry,
    { species: 'Amoonguss', knownMoves: ['Spore'] } as OpponentEntry,
  ],
  bring: [0, 1], opponentBrought: [0, 1], turns: [], field: { ...NEUTRAL_FIELD },
  active: { mine: [0, 1], theirs: [0, 1] },
});

describe('protect streak reaches the live search', () => {
  test('no protect last turn → fresh streak on both sides', () => {
    const m = freshMatch();
    m.turns = [{ index: 1, actions: [{ side: 'mine', kind: 'move', attackerTeamIndex: 0, move: 'Earthquake' } as MoveAction], field: { ...NEUTRAL_FIELD } }];
    const inp = searchInputFromMatch(m, ACTIVE);
    expect(inp.mine[0]!.protectedLastTurn).toBe(false);
    expect(inp.opp[0]!.protectedLastTurn).toBe(false);
  });

  test('my mon protected last turn → the search is told', () => {
    const m = freshMatch();
    m.turns = [{ index: 1, actions: [{ side: 'mine', kind: 'move', attackerTeamIndex: 0, move: 'Protect' } as MoveAction], field: { ...NEUTRAL_FIELD } }];
    expect(searchInputFromMatch(m, ACTIVE).mine[0]!.protectedLastTurn).toBe(true);
  });

  test('a protect VARIANT counts — Spiky Shield is still a protect', () => {
    const m = freshMatch();
    m.turns = [{ index: 1, actions: [{ side: 'mine', kind: 'move', attackerTeamIndex: 1, move: 'Spiky Shield' } as MoveAction], field: { ...NEUTRAL_FIELD } }];
    const inp = searchInputFromMatch(m, ACTIVE);
    expect(inp.mine[1]!.protectedLastTurn).toBe(true);
    expect(inp.mine[0]!.protectedLastTurn).toBe(false);   // per-mon, not per-side
  });

  test('the OPPONENT protecting is tracked too', () => {
    const m = freshMatch();
    m.turns = [{ index: 1, actions: [{ side: 'theirs', kind: 'move', attackerTeamIndex: 0, move: 'Protect' } as MoveAction], field: { ...NEUTRAL_FIELD } }];
    const inp = searchInputFromMatch(m, ACTIVE);
    expect(inp.opp[0]!.protectedLastTurn).toBe(true);
    expect(inp.mine[0]!.protectedLastTurn).toBe(false);
  });

  test('only the MOST RECENT turn counts — an older protect has worn off', () => {
    const m = freshMatch();
    m.turns = [
      { index: 1, actions: [{ side: 'mine', kind: 'move', attackerTeamIndex: 0, move: 'Protect' } as MoveAction], field: { ...NEUTRAL_FIELD } },
      { index: 2, actions: [{ side: 'mine', kind: 'move', attackerTeamIndex: 0, move: 'Earthquake' } as MoveAction], field: { ...NEUTRAL_FIELD } },
    ];
    expect(searchInputFromMatch(m, ACTIVE).mine[0]!.protectedLastTurn).toBe(false);
  });
});
