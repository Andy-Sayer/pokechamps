// resolveOneTurn used to leave `moveUsed` blank on a Protect turn: the action set the
// PROTECT target but never recorded WHICH protect the mon has. That made ResolvedSlot
// lie, and it left the sim diff-harness with no move to send — it fell back to
// 'default' (= "sim, pick for me"), so the two engines played different turns and
// Protect could never be compared. Hence "protect/switch deferred" in simDiff.
import { describe, test, expect } from 'vitest';
import { resolveOneTurn, type SearchInput, type TurnAction } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
const oppOf = (set: PokemonSet): OpponentEntry =>
  ({ species: set.species, knownMoves: set.moves, ability: set.ability, item: set.item, candidates: [set] });
const A = (a: TurnAction): Map<number, TurnAction> => new Map([[0, a]]);

function input1v1(my: PokemonSet, opp: PokemonSet): SearchInput {
  return {
    mine: [{ set: my, hpPercent: 100, active: true }],
    opp: [{ entry: oppOf(opp), hpPercent: 100, active: true }],
    field: { ...NEUTRAL_FIELD },
  };
}
const chomp = mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Earthquake', 'Protect'] });

describe('Protect reports the variant it actually used', () => {
  test('a plain Protect user names Protect', () => {
    const r = resolveOneTurn(input1v1(chomp, chomp), A({ kind: 'protect' }), A({ kind: 'attack', target: 0 }));
    expect(r.mine[0]!.moveUsed).toBe('Protect');
    expect(r.mine[0]!.hpPct).toBe(100);      // and it actually blocked
  });

  test('a Spiky Shield user names Spiky Shield, not Protect', () => {
    // The variant matters: the harness sends this exact move id to the real engine, and
    // the variants differ (Spiky Shield chips on contact, King's Shield drops Atk).
    const glimmora = mon({ species: 'Glimmora', ability: 'Toxic Debris', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Power Gem', 'Spiky Shield'] });
    const r = resolveOneTurn(input1v1(glimmora, chomp), A({ kind: 'protect' }), A({ kind: 'attack', target: 0 }));
    expect(r.mine[0]!.moveUsed).toBe('Spiky Shield');
  });

  test('the opponent side reports its variant too', () => {
    const r = resolveOneTurn(input1v1(chomp, chomp), A({ kind: 'attack', target: 0 }), A({ kind: 'protect' }));
    expect(r.opp[0]!.moveUsed).toBe('Protect');
    expect(r.opp[0]!.hpPct).toBe(100);
  });
});
