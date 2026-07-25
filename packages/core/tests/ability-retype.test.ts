// The "-ate" abilities and Champions' Dragonize change a move's TYPE. The calc prices
// the damage right, but the search's Cell.type fed the raw DEX type to everything that
// keys off type — resist berries, Weakness Policy, Misty Terrain halving Dragon,
// terrain boosts, Storm Drain / Lightning Rod absorb.
// This is a meta case, not an exotic one: Sylveon is Pixilate, so its Hyper Voice — a
// SPREAD move you meet constantly — read as Normal instead of Fairy.
import { describe, test, expect } from 'vitest';
import { buildTablesForTest, type SearchInput } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
const oppOf = (set: PokemonSet): OpponentEntry =>
  ({ species: set.species, knownMoves: set.moves, ability: set.ability, item: set.item, candidates: [set] });
const PLAN = { myMega: null, oppMega: null };

function tablesFor(my: PokemonSet, opp: PokemonSet) {
  const input: SearchInput = {
    mine: [{ set: my, hpPercent: 100, active: true }],
    opp: [{ entry: oppOf(opp), hpPercent: 100, active: true }],
    field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
  };
  return buildTablesForTest(input, PLAN);
}
const chomp = mon({ species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake'] });

describe('ability retyping reaches Cell.type', () => {
  test('Pixilate Sylveon: Hyper Voice is Fairy, not Normal — including the SPREAD option', () => {
    const sylv = mon({ species: 'Sylveon', ability: 'Pixilate', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Hyper Voice'] });
    const t = tablesFor(sylv, chomp);
    expect(t.off[0]![0]!.type).toBe('Fairy');
    expect(t.mySpread[0]!.type).toBe('Fairy');   // Hyper Voice is allAdjacentFoes
  });

  test('the same Sylveon WITHOUT Pixilate keeps the dex type (control)', () => {
    const plain = mon({ species: 'Sylveon', ability: 'Cute Charm', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Hyper Voice'] });
    expect(tablesFor(plain, chomp).off[0]![0]!.type).toBe('Normal');
  });

  test('Dragonize (Feraligatr-Mega) turns a Normal move Dragon', () => {
    const gatr = mon({ species: 'Feraligatr-Mega', ability: 'Dragonize', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Body Slam'] });
    expect(tablesFor(gatr, chomp).off[0]![0]!.type).toBe('Dragon');
  });

  test('it converts NORMAL moves only — a Fairy move is untouched by Pixilate', () => {
    const sylv = mon({ species: 'Sylveon', ability: 'Pixilate', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Moonblast'] });
    expect(tablesFor(sylv, chomp).off[0]![0]!.type).toBe('Fairy');   // already Fairy, not "retyped"
    const aurorus = mon({ species: 'Aurorus', ability: 'Refrigerate', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Earth Power'] });
    expect(tablesFor(aurorus, chomp).off[0]![0]!.type).toBe('Ground');  // Ground stays Ground
  });

  test('the OPPONENT side is retyped too', () => {
    const sylv = mon({ species: 'Sylveon', ability: 'Pixilate', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Hyper Voice'] });
    const t = tablesFor(chomp, sylv);
    expect(t.thr[0]![0]!.type).toBe('Fairy');
    expect(t.oppSpread[0]!.type).toBe('Fairy');
  });
});
