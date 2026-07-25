// Mat Block and Crafty Shield are the team-protect siblings of Wide/Quick Guard, and
// each other's mirror image: Mat Block stops DAMAGING moves side-wide but not status;
// Crafty Shield stops STATUS moves side-wide but not damage.
// M-B legality: Mat Block is Greninja-only (and first-turn-out only, like Fake Out);
// Crafty Shield is Chimecho / Cofagrigus / Klefki / Runerigus.
import { describe, test, expect } from 'vitest';
import { resolveOneTurn, type SearchInput, type TurnAction } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
const oppOf = (set: PokemonSet): OpponentEntry =>
  ({ species: set.species, knownMoves: set.moves, ability: set.ability, candidates: [set] });

const grenin = mon({ species: 'Greninja', ability: 'Protean', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Mat Block', 'Water Shuriken'] });
const klefki = mon({ species: 'Klefki', ability: 'Prankster', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Crafty Shield', 'Foul Play'] });
const chomp = mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Earthquake'] });
const wisper = mon({ species: 'Rotom-Wash', ability: 'Levitate', nature: 'Modest', evs: { ...ZERO_EVS, hp: 252, spa: 252 }, moves: ['Will-O-Wisp', 'Hydro Pump'] });

const duo = (a: PokemonSet, opp: PokemonSet, firstTurn = true): SearchInput => ({
  mine: [{ set: a, hpPercent: 100, active: true, firstTurnOut: firstTurn }],
  opp: [{ entry: oppOf(opp), hpPercent: 100, active: true }],
  field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
});
const A = (a: TurnAction): Map<number, TurnAction> => new Map([[0, a]]);

describe('Mat Block', () => {
  test('blocks a damaging move', () => {
    const r = resolveOneTurn(duo(grenin, chomp), A({ kind: 'matblock' }), A({ kind: 'attack', target: 0 }));
    expect(r.mine[0]!.hpPct).toBe(100);
  });

  test('does NOT block a status move — that is Crafty Shield’s job', () => {
    const r = resolveOneTurn(duo(grenin, wisper), A({ kind: 'matblock' }), A({ kind: 'status', target: 0 }));
    expect(r.mine[0]!.status).toBe('brn');
  });
});

describe('Crafty Shield', () => {
  test('blocks a status move', () => {
    const r = resolveOneTurn(duo(klefki, wisper), A({ kind: 'craftyshield' }), A({ kind: 'status', target: 0 }));
    expect(r.mine[0]!.status).toBe('');
  });

  test('does NOT block damage', () => {
    const r = resolveOneTurn(duo(klefki, chomp), A({ kind: 'craftyshield' }), A({ kind: 'attack', target: 0 }));
    expect(r.mine[0]!.hpPct).toBeLessThan(100);
  });

  test('a status move lands normally without it (control)', () => {
    const r = resolveOneTurn(duo(klefki, wisper), A({ kind: 'attack', target: 0 }), A({ kind: 'status', target: 0 }));
    expect(r.mine[0]!.status).toBe('brn');
  });
});
