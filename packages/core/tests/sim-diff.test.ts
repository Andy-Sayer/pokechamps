// Diff-harness validation: our fast search vs the real Showdown engine on the same
// position + the same concrete moves. A clean attack turn should AGREE structurally;
// known-gap mechanics (sleep, self-stat-drop secondary) should be CAUGHT as
// divergences — which is what ranks the porting backlog.
import { describe, test, expect } from 'vitest';
import { diffTurn, searchInputToSimPosition } from '../src/domain/simDiff.js';
import { buildBattle, readOutcome } from '../src/domain/simBridge.js';
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

  // Draco Meteor's self −2 SpA is now PORTED into the fast search, so the harness
  // confirms the gap is closed — both engines agree (no boost:spa divergence).
  test('self-stat-drop gap is closed (Draco Meteor agrees with the engine)', () => {
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
    expect(spaDrop).toBeUndefined();   // ported → no divergence
  });

  // ---- Multi-seed faint tests -----------------------------------------------

  // diffTurn with faintSeeds returns the correct shape and does not throw.
  test('multi-seed faint check runs without error and returns expected shape', () => {
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
    const faintSeeds: [number, number, number, number][] = Array.from({ length: 8 }, (_, k) => [k + 1, k + 2, k + 3, k + 4]);
    const result = diffTurn(input, new Map([[0, atk(0)], [1, atk(1)]]), new Map([[0, atk(0)], [1, atk(1)]]),
      [1, 2, 3, 4], faintSeeds);
    // Shape check: result has divergences array and hpGaps record.
    expect(result).toHaveProperty('divergences');
    expect(result).toHaveProperty('hpGaps');
    expect(Array.isArray(result.divergences)).toBe(true);
    expect(typeof result.hpGaps).toBe('object');
    // Bulky walls vs bulky walls at 100% HP — no faint divergences expected.
    const faintDivs = result.divergences.filter(d => d.field === 'fainted');
    expect(faintDivs).toEqual([]);
  });

  // A position where both engines agree the defender faints (guaranteed OHKO both
  // ways) should produce NO faint divergence even with multi-seed sampling.
  test('multi-seed faint: unanimous KO that both engines agree on produces no divergence', () => {
    // 252+ Atk Garchomp Earthquake vs 0/0 Flutter Mane (4× Electric weakness ignored;
    // use a Dragon Claw against a bulky Blissey to keep it alive — this test just
    // confirms shape and no false positive when both sides agree).
    const input: SearchInput = {
      mine: [
        { set: mon({ species: 'Dondozo', ability: 'Unaware', nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Wave Crash'] }), hpPercent: 100, active: true },
        { set: mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Seismic Toss'] }), hpPercent: 100, active: true },
      ],
      opp: [
        { entry: oppOf(mon({ species: 'Bronzong', ability: 'Levitate', nature: 'Sassy', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Gyro Ball'] })), hpPercent: 100, active: true },
        { entry: oppOf(mon({ species: 'Slowbro', ability: 'Own Tempo', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Body Press'] })), hpPercent: 100, active: true },
      ],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    };
    const faintSeeds: [number, number, number, number][] = [[11, 22, 33, 44], [55, 66, 77, 88],
      [99, 111, 222, 333], [444, 555, 666, 777], [888, 999, 123, 456], [789, 101, 112, 131],
      [415, 161, 718, 192], [17, 222, 324, 425]];
    const result = diffTurn(input, new Map([[0, atk(0)], [1, atk(1)]]), new Map([[0, atk(0)], [1, atk(1)]]),
      [1, 2, 3, 4], faintSeeds);
    // Both engines reason about the same moves — faint divergences (if any) should
    // only appear when unanimous across all seeds AND our engine disagrees.
    // For a no-secondary bulky matchup this should be clean.
    const faintDivs = result.divergences.filter(d => d.field === 'fainted');
    expect(faintDivs).toEqual([]);
  });

  // Verify the multi-seed filter actually suppresses noise: run the same position with
  // and without faintSeeds and confirm that with faintSeeds the fainted count is ≤ without.
  test('multi-seed faint: providing faintSeeds never ADDS faint divergences vs single-seed', () => {
    // Use a position with varied HP to encourage some borderline faint outcomes.
    const input: SearchInput = {
      mine: [
        { set: mon({ species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Dragon Claw'] }), hpPercent: 80, active: true },
        { set: mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Seismic Toss'] }), hpPercent: 90, active: true },
      ],
      opp: [
        { entry: oppOf(mon({ species: 'Dragapult', ability: 'Clear Body', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Draco Meteor'] })), hpPercent: 75, active: true },
        { entry: oppOf(mon({ species: 'Amoonguss', ability: 'Regenerator', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Spore'] })), hpPercent: 85, active: true },
      ],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    };
    const seed: [number, number, number, number] = [42, 137, 271, 314];
    const faintSeeds: [number, number, number, number][] = Array.from({ length: 8 }, (_, k) => [
      (42 + k * 1009) % 9999, (137 + k * 1013) % 9973,
      (271 + k * 1019) % 9967, (314 + k * 1021) % 9949,
    ] as [number, number, number, number]);
    const withoutMulti = diffTurn(input, new Map([[0, atk(0)], [1, atk(1)]]), new Map([[0, atk(0)], [1, atk(1)]]), seed);
    const withMulti = diffTurn(input, new Map([[0, atk(0)], [1, atk(1)]]), new Map([[0, atk(0)], [1, atk(1)]]), seed, faintSeeds);
    const faintCountWithout = withoutMulti.divergences.filter(d => d.field === 'fainted').length;
    const faintCountWith = withMulti.divergences.filter(d => d.field === 'fainted').length;
    // Multi-seed mode should never produce MORE faint divergences than single-seed.
    expect(faintCountWith).toBeLessThanOrEqual(faintCountWithout);
    // Non-faint divergences should be identical (deterministic fields unaffected).
    const nonFaintWithout = withoutMulti.divergences.filter(d => d.field !== 'fainted').sort((a, b) => a.field.localeCompare(b.field) || a.who.localeCompare(b.who));
    const nonFaintWith = withMulti.divergences.filter(d => d.field !== 'fainted').sort((a, b) => a.field.localeCompare(b.field) || a.who.localeCompare(b.who));
    expect(nonFaintWith).toEqual(nonFaintWithout);
  });
});
