// Bounded lookahead search: decisive KO lines, losing positions, turn-order
// awareness, and iterative deepening. Uses real species so predictOffense/
// predictThreat compute real damage; assertions stay on verdict/targets/score
// sign to be robust to exact rolls.
import { describe, test, expect } from 'vitest';
import { searchToDepth, searchIterative, searchInputFromMatch, type SearchInput } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry, Match } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';
import { maxHpFor } from '../src/domain/damage.js';

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

describe('searchInputFromMatch', () => {
  function freshMatch(): Match {
    return {
      id: 't', startedAt: '2026-05-26T00:00:00.000Z',
      myTeam: [flutter, garchomp, incin, mon({ species: 'Rillaboom', moves: ['Grassy Glide'] })],
      opponentTeam: ['Incineroar', 'Amoonguss', 'Garchomp', 'Talonflame'].map(species => ({ species, knownMoves: [] } as OpponentEntry)),
      bring: [0, 1, 2, 3], opponentBrought: [0, 1], turns: [], field: { ...NEUTRAL_FIELD },
      active: { mine: [null, null], theirs: [null, null] },
    };
  }

  test('maps actives, bench, raw→% HP, and seen opponents', () => {
    const m = freshMatch();
    m.myFainted = [2];                          // Incineroar fainted → excluded
    m.myCurrentHp = { 1: Math.round(maxHpFor(garchomp) / 2) }; // Garchomp at 50%
    m.opponentTeam[1]!.currentHpPercent = 30;
    const input = searchInputFromMatch(m, { mine: [0, 1], theirs: [0, 1] });

    // 3 live brought mons (Incineroar excluded).
    expect(input.mine.map(x => x.set.species)).toEqual(['Flutter Mane', 'Garchomp', 'Rillaboom']);
    expect(input.mine.find(x => x.set.species === 'Garchomp')!.hpPercent).toBeCloseTo(50, 0);
    expect(input.mine.find(x => x.set.species === 'Flutter Mane')!.active).toBe(true);
    expect(input.mine.find(x => x.set.species === 'Rillaboom')!.active).toBe(false); // benched
    // Only the 2 seen opponents.
    expect(input.opp.map(x => x.entry.species)).toEqual(['Incineroar', 'Amoonguss']);
    expect(input.opp[1]!.hpPercent).toBe(30);
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
