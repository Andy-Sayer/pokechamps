// The BEHAVIOUR the plumbing buys: a Taunted mon must stop being offered status moves,
// and an Encored one must be restricted to the move it's locked into. The search modelled
// both already — nothing was seeding them from a live match.
import { describe, test, expect } from 'vitest';
import { searchToDepth, type SearchInput } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
const oppOf = (set: PokemonSet): OpponentEntry =>
  ({ species: set.species, knownMoves: set.moves, ability: set.ability, candidates: [set] });

// A support mon whose best play is normally its status move.
const supporter = mon({ species: 'Amoonguss', ability: 'Regenerator', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Spore', 'Sludge Bomb'] });
const foe = mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Earthquake'] });

const input = (over: Partial<SearchInput['mine'][0]> = {}): SearchInput => ({
  mine: [{ set: supporter, hpPercent: 100, active: true, ...over }],
  opp: [{ entry: oppOf(foe), hpPercent: 100, active: true }],
  field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
});

describe('Taunt restricts the live recommendation', () => {
  test('untaunted, Spore is available as a play', () => {
    const r = searchToDepth(input(), 2);
    expect(r.plays.some(p => p.move === 'Spore')).toBe(true);
  });

  test('taunted, Spore is never recommended', () => {
    const r = searchToDepth(input({ tauntTurns: 3 }), 2);
    expect(r.plays.some(p => p.move === 'Spore')).toBe(false);
    expect(r.plays.length).toBeGreaterThan(0);   // it still has an attack to make
  });
});

describe('Encore restricts the live recommendation', () => {
  test('encored into Sludge Bomb, that is the only move played', () => {
    const r = searchToDepth(input({ encoreMove: 'Sludge Bomb' }), 2);
    const moves = new Set(r.plays.filter(p => p.mySpecies === 'Amoonguss').map(p => p.move));
    expect(moves.has('Spore')).toBe(false);
    if (moves.size) expect([...moves]).toEqual(['Sludge Bomb']);
  });
});
