// Item Clause cross-mon exclusion: a held/used item on one opp mon can't appear
// on another, so it's pruned from their candidate pools.
import { describe, test, expect } from 'vitest';
import { applyItemClauseExclusion } from '../src/domain/itemClause.js';
import { applyStateUpdate, type ActiveIdx } from '../src/match/engine.js';
import type { Match, OpponentEntry, PokemonSet } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

// A candidate spread for `species` carrying `item`.
function cand(species: string, item: string, ability = 'Pressure'): PokemonSet {
  return { species, level: 50, nature: 'Jolly', item, ability, evs: { ...ZERO_EVS }, ivs: MAX_IVS, moves: [] };
}

describe('applyItemClauseExclusion (unit)', () => {
  test('prunes a HELD item from another mon’s candidates', () => {
    const team: OpponentEntry[] = [
      { species: 'Garchomp', knownMoves: [], item: 'Choice Band' },
      { species: 'Tyranitar', knownMoves: [], candidates: [
        cand('Tyranitar', 'Choice Band'),
        cand('Tyranitar', 'Assault Vest'),
        cand('Tyranitar', 'Leftovers'),
      ] },
    ];
    applyItemClauseExclusion(team);
    expect(team[1]!.candidates!.map(c => c.item)).toEqual(['Assault Vest', 'Leftovers']);
  });

  test('prunes a CONSUMED item too (it was still spoken for)', () => {
    const team: OpponentEntry[] = [
      { species: 'Garchomp', knownMoves: [], itemConsumed: 'Sitrus Berry' },
      { species: 'Tyranitar', knownMoves: [], candidates: [
        cand('Tyranitar', 'Sitrus Berry'),
        cand('Tyranitar', 'Leftovers'),
      ] },
    ];
    applyItemClauseExclusion(team);
    expect(team[1]!.candidates!.map(c => c.item)).toEqual(['Leftovers']);
  });

  test('filters candidateLikelihoods in lockstep', () => {
    const team: OpponentEntry[] = [
      { species: 'Garchomp', knownMoves: [], item: 'Choice Scarf' },
      { species: 'Tyranitar', knownMoves: [],
        candidates: [cand('Tyranitar', 'Choice Scarf'), cand('Tyranitar', 'Leftovers'), cand('Tyranitar', 'Choice Scarf')],
        candidateLikelihoods: [0.5, 0.3, 0.2] },
    ];
    applyItemClauseExclusion(team);
    expect(team[1]!.candidates!.map(c => c.item)).toEqual(['Leftovers']);
    expect(team[1]!.candidateLikelihoods).toEqual([0.3]);
  });

  test('never empties a set — keeps candidates if all would be ruled out', () => {
    const team: OpponentEntry[] = [
      { species: 'Garchomp', knownMoves: [], item: 'Leftovers' },
      { species: 'Tyranitar', knownMoves: [], candidates: [cand('Tyranitar', 'Leftovers'), cand('Tyranitar', 'Leftovers')] },
    ];
    applyItemClauseExclusion(team);
    expect(team[1]!.candidates).toHaveLength(2); // contradictory data left intact
  });

  test('“no item” claims nothing, and a no-item candidate is never excluded', () => {
    const team: OpponentEntry[] = [
      { species: 'Garchomp', knownMoves: [], item: '' },            // no item — claims nothing
      { species: 'Salamence', knownMoves: [], item: 'Life Orb' },
      { species: 'Tyranitar', knownMoves: [], candidates: [
        cand('Tyranitar', ''),          // no item — always allowed
        cand('Tyranitar', 'Life Orb'),  // claimed by Salamence → excluded
        cand('Tyranitar', 'Leftovers'),
      ] },
    ];
    const notes = applyItemClauseExclusion(team);
    expect(team[2]!.candidates!.map(c => c.item)).toEqual(['', 'Leftovers']);
    expect(notes.some(n => n.includes('o3'))).toBe(true);
  });

  test('a mon’s own item never excludes its own candidates', () => {
    const team: OpponentEntry[] = [
      { species: 'Tyranitar', knownMoves: [], item: 'Leftovers',
        candidates: [cand('Tyranitar', 'Leftovers'), cand('Tyranitar', 'Choice Band')] },
    ];
    applyItemClauseExclusion(team);
    expect(team[0]!.candidates).toHaveLength(2); // self-claim is ignored
  });
});

describe('Item Clause via applyStateUpdate (integration)', () => {
  const startActive: ActiveIdx = { mine: [0, 1], theirs: [0, 1] };
  function freshMatch(): Match {
    return {
      id: 'test', startedAt: '2026-06-08T00:00:00.000Z',
      myTeam: [{ species: 'Sneasler', level: 50, nature: 'Jolly', evs: { ...ZERO_EVS }, ivs: MAX_IVS, moves: [] }],
      opponentTeam: [
        { species: 'Garchomp', knownMoves: [] },
        { species: 'Tyranitar', knownMoves: [], candidates: [
          cand('Tyranitar', 'Choice Specs'),
          cand('Tyranitar', 'Assault Vest'),
        ] },
      ] as OpponentEntry[],
      bring: [0, 1, 2, 3], opponentBrought: [0, 1], turns: [], field: NEUTRAL_FIELD,
      active: { mine: [null, null], theirs: [null, null] },
    };
  }

  test('revealing o1’s item ripples to o2’s candidate pool', () => {
    const match = freshMatch();
    const r = applyStateUpdate({ match, update: { side: 'theirs', teamIndex: 0, setItem: 'Choice Specs' }, activeIdx: startActive });
    expect(r.match.opponentTeam[0]!.item).toBe('Choice Specs');
    // o2 can no longer be Choice Specs (Garchomp has it).
    expect(r.match.opponentTeam[1]!.candidates!.map(c => c.item)).toEqual(['Assault Vest']);
  });
});
