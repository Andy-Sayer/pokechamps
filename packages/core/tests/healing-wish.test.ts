// Healing Wish: the user faints and its replacement arrives at FULL HP with status
// cured. Legal users in M-B: Audino, Chimecho, Clefable, Gardevoir, Hatterene, Lopunny.
// (Lunar Dance has no legal user in this format at all, so it is deliberately not
// modelled — see unmodeled.ts.)
import { describe, test, expect } from 'vitest';
import { resolveOneTurn, type SearchInput, type TurnAction } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
const oppOf = (set: PokemonSet): OpponentEntry =>
  ({ species: set.species, knownMoves: set.moves, ability: set.ability, candidates: [set] });

const clef = mon({ species: 'Clefable', ability: 'Unaware', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Healing Wish', 'Moonblast'] });
const chomp = mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Earthquake'] });
const hurtBench = mon({ species: 'Kingambit', ability: 'Defiant', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Kowtow Cleave'] });

function input(benchHp: number, benchStatus?: string): SearchInput {
  return {
    mine: [
      { set: clef, hpPercent: 100, active: true },
      { set: hurtBench, hpPercent: benchHp, active: false, status: benchStatus },
    ],
    opp: [{ entry: oppOf(chomp), hpPercent: 100, active: true }],
    field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
  };
}
const HW: Map<number, TurnAction> = new Map([[0, { kind: 'healingwish' }]]);
const OPP_ATK: Map<number, TurnAction> = new Map([[0, { kind: 'attack', target: 0 }]]);

describe('Healing Wish', () => {
  test('the caster faints', () => {
    expect(resolveOneTurn(input(30), HW, OPP_ATK).mine[0]!.fainted).toBe(true);
  });

  test('the replacement comes in at FULL HP', () => {
    const r = resolveOneTurn(input(30), HW, OPP_ATK);
    expect(r.mine[1]!.hpPct).toBe(100);   // was 30
  });

  test('…and with its status cured', () => {
    const r = resolveOneTurn(input(40, 'brn'), HW, OPP_ATK);
    expect(r.mine[1]!.status).toBe('');
    expect(r.mine[1]!.hpPct).toBe(100);
  });

  test('without the sacrifice the bench mon stays hurt (control)', () => {
    const r = resolveOneTurn(input(30), new Map([[0, { kind: 'attack', target: 0 }]]), OPP_ATK);
    expect(r.mine[1]!.hpPct).toBe(30);
    expect(r.mine[0]!.fainted).toBe(false);
  });
});
