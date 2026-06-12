// Perish clock + trapping in the lookahead search. The search FORECASTS the
// manually-logged perish counts by real rules: tick at EOT on the field, faint
// at 0, switching out clears the count (which is why trapping abilities turn
// Perish Song into a kill), Baton Pass transfers it.
import { describe, test, expect } from 'vitest';
import { searchToDepth, type SearchInput } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
function oppOf(set: PokemonSet): OpponentEntry {
  return { species: set.species, ability: set.ability, knownMoves: set.moves, candidates: [set] };
}

const incin = mon({
  species: 'Incineroar', ability: 'Intimidate', nature: 'Careful',
  evs: { hp: 252, atk: 0, def: 4, spa: 0, spd: 252, spe: 0 }, moves: ['Knock Off', 'Protect'],
});
const garchomp = mon({
  species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly',
  evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 }, moves: ['Earthquake', 'Dragon Claw'],
});
const amoonguss = mon({
  species: 'Amoonguss', ability: 'Regenerator', nature: 'Calm',
  evs: { hp: 252, atk: 0, def: 4, spa: 0, spd: 252, spe: 0 }, moves: ['Pollen Puff', 'Protect'],
});

describe('perish clock in search', () => {
  test('opponent at perish 1 with no bench: position is winning', () => {
    // Their Garchomp faints at this turn's EOT no matter what it does.
    const input: SearchInput = {
      mine: [{ set: incin, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(garchomp), hpPercent: 100, active: true, perishCount: 1 }],
      field: { ...NEUTRAL_FIELD },
      allOppRevealed: true,
    };
    const r = searchToDepth(input, 2);
    expect(r.score).toBeGreaterThan(0);
    expect(r.verdict).toBe('winning');
  });

  test('my mon at perish 1 with a healthy bench: search switches out to clear it', () => {
    const input: SearchInput = {
      mine: [
        { set: incin, hpPercent: 100, active: true, perishCount: 1 },
        { set: amoonguss, hpPercent: 100, active: false },
      ],
      opp: [{ entry: oppOf(garchomp), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD },
    };
    const r = searchToDepth(input, 2);
    const play = r.plays.find(p => p.mySpecies === 'Incineroar');
    expect(play).toBeTruthy();
    expect(play!.switch).toBe(true);
  });

  test('trapped by Shadow Tag: the escape switch is not available', () => {
    const tagger = mon({ species: 'Gengar', ability: 'Shadow Tag', moves: ['Shadow Ball', 'Protect'] });
    const input: SearchInput = {
      mine: [
        { set: incin, hpPercent: 100, active: true, perishCount: 1 },
        { set: amoonguss, hpPercent: 100, active: false },
      ],
      opp: [{ entry: oppOf(tagger), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD },
    };
    const r = searchToDepth(input, 2);
    const play = r.plays.find(p => p.mySpecies === 'Incineroar');
    expect(play).toBeTruthy();
    // No switch offered — the trapped mon must act in place and will faint.
    expect(play!.switch).not.toBe(true);
  });

  test('ghosts ignore trapping: the escape switch IS available', () => {
    const tagger = mon({ species: 'Gengar', ability: 'Shadow Tag', moves: ['Shadow Ball', 'Protect'] });
    const ghost = mon({
      species: 'Basculegion', ability: 'Adaptability', nature: 'Adamant',
      evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 }, moves: ['Wave Crash', 'Protect'],
    });
    const input: SearchInput = {
      mine: [
        { set: ghost, hpPercent: 100, active: true, perishCount: 1 },
        { set: amoonguss, hpPercent: 100, active: false },
      ],
      opp: [{ entry: oppOf(tagger), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD },
    };
    const r = searchToDepth(input, 2);
    const play = r.plays.find(p => p.mySpecies === 'Basculegion');
    expect(play).toBeTruthy();
    expect(play!.switch).toBe(true);
  });
});
