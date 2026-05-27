// Bounded lookahead search: decisive KO lines, losing positions, turn-order
// awareness, and iterative deepening. Uses real species so predictOffense/
// predictThreat compute real damage; assertions stay on verdict/targets/score
// sign to be robust to exact rolls.
import { describe, test, expect } from 'vitest';
import { searchToDepth, searchIterative, type SearchInput } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
function oppOf(set: PokemonSet): OpponentEntry {
  return { species: set.species, knownMoves: set.moves, candidates: [set] };
}

const flutter = mon({
  species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid',
  evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 }, moves: ['Moonblast', 'Shadow Ball'],
});
const garchomp = mon({
  species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly',
  evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 }, moves: ['Earthquake', 'Dragon Claw'],
});
const incin = mon({
  species: 'Incineroar', ability: 'Intimidate', nature: 'Careful',
  evs: { hp: 252, atk: 0, def: 4, spa: 0, spd: 252, spe: 0 }, moves: ['Knock Off', 'Flare Blitz'],
});

describe('searchToDepth', () => {
  test('recommends a play for each live active and targets a live foe', () => {
    const input: SearchInput = {
      mine: [{ set: flutter, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(incin), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD },
    };
    const r = searchToDepth(input, 1);
    expect(r.plays.length).toBe(1);
    expect(r.plays[0]!.mySpecies).toBe('Flutter Mane');
    expect(r.plays[0]!.targetSpecies).toBe('Incineroar');
    expect(r.plays[0]!.move).toBeTruthy();
  });

  test('a 1v1 where I outspeed + KO is a winning verdict', () => {
    const input: SearchInput = {
      mine: [{ set: flutter, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(incin), hpPercent: 35, active: true }],
      field: { ...NEUTRAL_FIELD },
    };
    const r = searchToDepth(input, 2);
    expect(r.verdict).toBe('winning');
    expect(r.score).toBeGreaterThan(0);
  });

  test('1 frail mon vs two healthy attackers is a losing verdict', () => {
    const input: SearchInput = {
      mine: [{ set: flutter, hpPercent: 20, active: true }],
      opp: [
        { entry: oppOf(garchomp), hpPercent: 100, active: true },
        { entry: oppOf(incin), hpPercent: 100, active: true },
      ],
      field: { ...NEUTRAL_FIELD },
    };
    const r = searchToDepth(input, 2);
    expect(r.verdict).toBe('losing');
    expect(r.score).toBeLessThan(0);
  });

  test('no live opponents → no plays (position already won)', () => {
    const input: SearchInput = {
      mine: [{ set: flutter, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(incin), hpPercent: 0, active: true }],
      field: { ...NEUTRAL_FIELD },
    };
    const r = searchToDepth(input, 3);
    expect(r.plays.length).toBe(0);
  });
});

describe('searchIterative', () => {
  test('calls onDepth for each depth 1..max and returns the deepest', () => {
    const input: SearchInput = {
      mine: [{ set: flutter, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(incin), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD },
    };
    const seen: number[] = [];
    const r = searchIterative(input, 3, res => seen.push(res.depth));
    expect(seen).toEqual([1, 2, 3]);
    expect(r.depth).toBe(3);
  });
});
