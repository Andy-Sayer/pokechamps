// Spotlight makes a CHOSEN ally the target of the foes' single-target moves — Follow Me's
// cousin, but cast on someone else, so it carries an ally index. Legal users in M-B:
// Clefable and Starmie.
import { describe, test, expect } from 'vitest';
import { resolveOneTurn, type SearchInput, type TurnAction } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
const oppOf = (set: PokemonSet): OpponentEntry =>
  ({ species: set.species, knownMoves: set.moves, ability: set.ability, candidates: [set] });

const clef = mon({ species: 'Clefable', ability: 'Unaware', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Spotlight', 'Moonblast'] });
const wall = mon({ species: 'Dondozo', ability: 'Unaware', nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Wave Crash'] });
const hitter = mon({ species: 'Kingambit', ability: 'Defiant', nature: 'Brave', evs: { ...ZERO_EVS, hp: 252, atk: 252 }, moves: ['Iron Head'] });

const input = (): SearchInput => ({
  mine: [
    { set: clef, hpPercent: 100, active: true },   // index 0 — the caster
    { set: wall, hpPercent: 100, active: true },   // index 1 — the designated soak
  ],
  opp: [{ entry: oppOf(hitter), hpPercent: 100, active: true }],
  field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
});
// The foe aims at the CASTER (index 0).
const OPP_HITS_CASTER: Map<number, TurnAction> = new Map([[0, { kind: 'attack', target: 0 }]]);

describe('Spotlight', () => {
  test('the foe’s move is pulled onto the spotlit ALLY, not the caster', () => {
    const r = resolveOneTurn(input(), new Map([[0, { kind: 'spotlight', ally: 1 }]]), OPP_HITS_CASTER);
    expect(r.mine[0]!.hpPct).toBe(100);          // the caster is spared
    expect(r.mine[1]!.hpPct).toBeLessThan(100);  // the spotlit ally soaked it
  });

  test('without it the caster takes the hit (control)', () => {
    const r = resolveOneTurn(input(), new Map([[0, { kind: 'attack', target: 0 }]]), OPP_HITS_CASTER);
    expect(r.mine[0]!.hpPct).toBeLessThan(100);
    expect(r.mine[1]!.hpPct).toBe(100);
  });
});
