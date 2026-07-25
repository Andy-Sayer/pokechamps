// Memento: the target's Atk and SpA drop 2 stages and the USER faints. Modelling the
// drops without the cost would make it a strictly better Charm — the search would spam
// a move that trades a Pokémon. Legal users are meta-real: Whimsicott, Gholdengo,
// Sinistcha, Chandelure, Polteageist, Spiritomb.
import { describe, test, expect } from 'vitest';
import { resolveOneTurn, type SearchInput, type TurnAction } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
const oppOf = (set: PokemonSet): OpponentEntry =>
  ({ species: set.species, knownMoves: set.moves, ability: set.ability, candidates: [set] });
const A = (a: TurnAction): Map<number, TurnAction> => new Map([[0, a]]);

const whims = mon({ species: 'Whimsicott', ability: 'Prankster', nature: 'Timid', evs: { ...ZERO_EVS, spe: 252 }, moves: ['Memento', 'Moonblast'] });
const chomp = mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Earthquake'] });

const input = (my: PokemonSet, opp: PokemonSet): SearchInput => ({
  mine: [{ set: my, hpPercent: 100, active: true }],
  opp: [{ entry: oppOf(opp), hpPercent: 100, active: true }],
  field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
});

describe('Memento', () => {
  test('drops the foe -2 Atk / -2 SpA', () => {
    const r = resolveOneTurn(input(whims, chomp), A({ kind: 'debuff', target: 0 }), A({ kind: 'attack', target: 0 }));
    expect(r.opp[0]!.boosts.atk).toBe(-2);
    expect(r.opp[0]!.boosts.spa).toBe(-2);
  });

  test('and the USER faints paying for it', () => {
    const r = resolveOneTurn(input(whims, chomp), A({ kind: 'debuff', target: 0 }), A({ kind: 'attack', target: 0 }));
    expect(r.mine[0]!.fainted).toBe(true);
  });

  test('a NON-self-destructing debuff leaves its caster alive (control)', () => {
    const charmer = mon({ species: 'Clefable', ability: 'Unaware', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Charm', 'Moonblast'] });
    const r = resolveOneTurn(input(charmer, chomp), A({ kind: 'debuff', target: 0 }), A({ kind: 'attack', target: 0 }));
    expect(r.opp[0]!.boosts.atk).toBe(-2);      // Charm is also -2 Atk
    expect(r.mine[0]!.fainted).toBe(false);     // …but costs nothing
  });
});
