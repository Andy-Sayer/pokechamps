// Diff-harness validation: our fast search vs the real Showdown engine on the same
// position + the same concrete moves. A clean attack turn should AGREE structurally;
// known-gap mechanics (sleep, self-stat-drop secondary) should be CAUGHT as
// divergences — which is what ranks the porting backlog.
import { describe, test, expect } from 'vitest';
import { diffTurn } from '../src/domain/simDiff.js';
import type { SearchInput, TurnAction } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
function oppOf(set: PokemonSet): OpponentEntry {
  return { species: set.species, knownMoves: set.moves, candidates: [set] };
}
const atk = (target: number): TurnAction => ({ kind: 'attack', target });

describe('sim diff-harness', () => {
  // Bulky walls trading single non-secondary attacks: no status / boost / field
  // change either way → the two engines AGREE on the discrete state.
  test('plain attack turn agrees structurally (no false gaps)', () => {
    const input: SearchInput = {
      mine: [
        { set: mon({ species: 'Dondozo', ability: 'Unaware', nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Liquidation'] }), hpPercent: 100, active: true },
        { set: mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Seismic Toss'] }), hpPercent: 100, active: true },
      ],
      opp: [
        { entry: oppOf(mon({ species: 'Bronzong', ability: 'Levitate', nature: 'Sassy', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Gyro Ball'] })), hpPercent: 100, active: true },
        { entry: oppOf(mon({ species: 'Slowbro', ability: 'Own Tempo', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Body Press'] })), hpPercent: 100, active: true },
      ],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    };
    // Liquidation has a 20% Def-drop secondary the search doesn't model — exclude
    // it from the discrete check by ignoring that one probabilistic field.
    const { divergences } = diffTurn(input, new Map([[0, atk(0)], [1, atk(1)]]), new Map([[0, atk(0)], [1, atk(1)]]));
    const structural = divergences.filter(d => !(d.field === 'boost:def')); // 20% secondary, roll-dependent
    expect(structural).toEqual([]);
  });

  // Opponent's Spore is a KNOWN search gap → the harness flags the status mismatch.
  test('catches the sleep gap (Spore)', () => {
    const input: SearchInput = {
      mine: [
        { set: mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Dragon Claw'] }), hpPercent: 100, active: true },
        { set: mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Seismic Toss'] }), hpPercent: 100, active: true },
      ],
      opp: [
        // Spore-only so our engine's "attack" action resolves to Spore (it picks the
        // best DAMAGING move otherwise) — then the sim applies sleep and we don't.
        { entry: oppOf(mon({ species: 'Amoonguss', ability: 'Regenerator', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Spore'] })), hpPercent: 100, active: true },
        { entry: oppOf(mon({ species: 'Bronzong', ability: 'Levitate', nature: 'Sassy', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Gyro Ball'] })), hpPercent: 100, active: true },
      ],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    };
    // Our engine has no cell move for a status-only mon, so the sim auto-targets
    // Spore — the gap surfaces as a sleep one of my mons has that ours doesn't.
    const { divergences } = diffTurn(input, new Map([[0, atk(0)], [1, atk(1)]]), new Map([[0, atk(0)], [1, atk(1)]]));
    const sleep = divergences.find(d => d.field === 'status' && d.sim === 'slp');
    expect(sleep).toBeDefined();
    expect(sleep!.ours).toBe('-');
  });

  // Draco Meteor's self −2 SpA is a secondary the search omits → caught as a boost gap.
  test('catches the self-stat-drop gap (Draco Meteor)', () => {
    const input: SearchInput = {
      mine: [
        { set: mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Seismic Toss'] }), hpPercent: 100, active: true },
        { set: mon({ species: 'Dondozo', ability: 'Unaware', nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Liquidation'] }), hpPercent: 100, active: true },
      ],
      opp: [
        { entry: oppOf(mon({ species: 'Dragapult', ability: 'Clear Body', nature: 'Modest', evs: { ...ZERO_EVS, hp: 252, spa: 252 }, moves: ['Draco Meteor'] })), hpPercent: 100, active: true },
        { entry: oppOf(mon({ species: 'Bronzong', ability: 'Levitate', nature: 'Sassy', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Gyro Ball'] })), hpPercent: 100, active: true },
      ],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    };
    const { divergences } = diffTurn(input, new Map([[0, atk(0)], [1, atk(1)]]), new Map([[0, atk(0)], [1, atk(1)]]));
    const spaDrop = divergences.find(d => d.field === 'boost:spa' && d.who === 'Dragapult');
    expect(spaDrop).toBeDefined();
    expect(spaDrop!.sim).toBe('-2');
  });
});
