// Spicy Spray (Scovillain-Mega, Champions custom): any damaging hit on the holder burns
// the attacker. The live engine has modelled this since M-A; the SEARCH did not, so the
// lookahead over-rated physical attackers into it — a burn halves their damage from then
// on, which is exactly the kind of thing the recommendation should price.
import { describe, test, expect } from 'vitest';
import { resolveOneTurn, type SearchInput, type TurnAction } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
const oppOf = (set: PokemonSet): OpponentEntry =>
  ({ species: set.species, knownMoves: set.moves, ability: set.ability, item: set.item, candidates: [set] });
function input1v1(my: PokemonSet, opp: PokemonSet, over: Partial<SearchInput> = {}): SearchInput {
  return {
    mine: [{ set: my, hpPercent: 100, active: true }],
    opp: [{ entry: oppOf(opp), hpPercent: 100, active: true }],
    field: { ...NEUTRAL_FIELD }, ...over,
  };
}
const A = (a: TurnAction): Map<number, TurnAction> => new Map([[0, a]]);
const ATTACK = A({ kind: 'attack', target: 0 });

const kingambit = mon({ species: 'Kingambit', ability: 'Defiant', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Kowtow Cleave'] });
const scov = (ability: string) => mon({ species: 'Scovillain-Mega', ability, nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Leaf Storm'] });

describe('Spicy Spray in the lookahead', () => {
  test('hitting the holder burns my attacker', () => {
    const r = resolveOneTurn(input1v1(kingambit, scov('Spicy Spray')), ATTACK, ATTACK);
    expect(r.mine[0]!.status).toBe('brn');
  });

  test('a different defender ability does not burn (control)', () => {
    const r = resolveOneTurn(input1v1(kingambit, scov('Chlorophyll')), ATTACK, ATTACK);
    expect(r.mine[0]!.status).toBe('');
  });

  test('the burn respects immunity — a Fire-type attacker is unaffected', () => {
    const incin = mon({ species: 'Incineroar', ability: 'Intimidate', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Flare Blitz'] });
    const r = resolveOneTurn(input1v1(incin, scov('Spicy Spray')), ATTACK, ATTACK);
    expect(r.mine[0]!.status).toBe('');
  });

  test('a status berry cures it immediately, as with any other inflicted burn', () => {
    const lumGambit = mon({ species: 'Kingambit', ability: 'Defiant', item: 'Lum Berry', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Kowtow Cleave'] });
    const r = resolveOneTurn(input1v1(lumGambit, scov('Spicy Spray')), ATTACK, ATTACK);
    expect(r.mine[0]!.status).toBe('');
  });

  test('it works in the other direction too — MY holder burns the opp attacker', () => {
    const mineScov = scov('Spicy Spray');
    const r = resolveOneTurn(input1v1(mineScov, kingambit), ATTACK, ATTACK);
    expect(r.opp[0]!.status).toBe('brn');
  });
});
