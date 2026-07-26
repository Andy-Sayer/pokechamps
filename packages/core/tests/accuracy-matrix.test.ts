// ACCURACY BELONGS IN MATRIX BUILDING (user ruling): otherwise the search picks whichever
// move has the biggest number and never pays for the whiff — "everything running 30%
// accuracy OHKOs". It enters at move SELECTION: the cell for a pair is the move with the
// best EXPECTED damage (damage x accuracy), and the numbers it then reports are the
// move's true roll envelope.
//
// Why not scale the damage VALUE instead: that turns "80% chance of 100" into "certain
// 80", so an 80%-accurate OHKO stops reading as lethal. Tried, and it flipped a
// genuinely losing position to WINNING — the regimes depend on min/max meaning the real
// roll envelope on both sides.
import { describe, test, expect } from 'vitest';
import { buildTablesForTest, type SearchInput } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
const oppOf = (set: PokemonSet): OpponentEntry =>
  ({ species: set.species, knownMoves: set.moves, ability: set.ability, candidates: [set] });
const wall = mon({ species: 'Dondozo', ability: 'Unaware', nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Wave Crash'] });

function chosen(moves: string[]): string {
  const me = mon({ species: 'Lucario', ability: 'Inner Focus', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252, atk: 252 }, moves });
  const input: SearchInput = {
    mine: [{ set: me, hpPercent: 100, active: true }],
    opp: [{ entry: oppOf(wall), hpPercent: 100, active: true }],
    field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
  };
  return buildTablesForTest(input, { myMega: null, oppMega: null }).off[0]![0]!.move;
}

describe('accuracy in matrix building', () => {
  test('a coin-flip nuke loses to a reliable move: Zap Cannon (50%) → Thunderbolt', () => {
    expect(chosen(['Zap Cannon', 'Thunderbolt'])).toBe('Thunderbolt');
  });

  test('Dynamic Punch (50%) → Drain Punch', () => {
    expect(chosen(['Dynamic Punch', 'Drain Punch'])).toBe('Drain Punch');
  });

  test('but a SMALL accuracy gap still favours real power — Focus Blast beats Aura Sphere', () => {
    // 120bp x 0.70 = 84 effective vs 80bp x 1.00 = 80. Expected damage says take the
    // nuke, and it should: this isn't "always prefer the accurate move".
    expect(chosen(['Focus Blast', 'Aura Sphere'])).toBe('Focus Blast');
  });

  test('the reported damage stays the move’s TRUE envelope, not a scaled one', () => {
    const me = mon({ species: 'Lucario', ability: 'Inner Focus', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Focus Blast'] });
    const input: SearchInput = {
      mine: [{ set: me, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(wall), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    };
    const c = buildTablesForTest(input, { myMega: null, oppMega: null }).off[0]![0]!;
    // mid sits inside [min,max] — it has NOT been multiplied down by 0.7.
    expect(c.dmgMid).toBeGreaterThan(c.dmgMin);
    expect(c.dmgMid).toBeLessThan(c.dmgMax);
  });
});
