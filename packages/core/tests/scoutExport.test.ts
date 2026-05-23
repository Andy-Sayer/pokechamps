// scoutExport — synthesises a Showdown export from observed opponent state.
// We don't need full Match fixtures; we just need to verify the
// per-opponent translation honors knownMoves / candidates / speed bounds.
import { describe, expect, it } from 'vitest';
import { exportScoutedOpponents, opponentToScoutedSet } from '../src/domain/scoutExport.js';
import type { Match, OpponentEntry, PokemonSet } from '../src/domain/types.js';
import { MAX_IVS, ZERO_EVS, NEUTRAL_FIELD } from '../src/domain/types.js';

function emptyMatch(opponentTeam: OpponentEntry[]): Match {
  return {
    id: 'm1',
    startedAt: '2026-05-21T00:00:00.000Z',
    myTeam: [],
    opponentTeam,
    bring: [0, 1, 2, 3],
    opponentBrought: [],
    turns: [],
    field: { ...NEUTRAL_FIELD },
    active: { mine: [null, null], theirs: [null, null] },
  };
}

describe('opponentToScoutedSet', () => {
  it('uses the top candidate when one exists', () => {
    const candidate: PokemonSet = {
      species: 'Incineroar', level: 50,
      ability: 'Intimidate', item: 'Safety Goggles', nature: 'Careful',
      evs: { hp: 252, atk: 0, def: 0, spa: 0, spd: 252, spe: 4 },
      ivs: { ...MAX_IVS }, moves: ['Knock Off'],
    };
    const opp: OpponentEntry = {
      species: 'Incineroar',
      knownMoves: ['Knock Off', 'Fake Out'],
      candidates: [candidate],
    };
    const set = opponentToScoutedSet(opp);
    expect(set.species).toBe('Incineroar');
    expect(set.ability).toBe('Intimidate');
    expect(set.item).toBe('Safety Goggles');
    expect(set.nature).toBe('Careful');
    expect(set.evs.spd).toBe(252);
    // knownMoves win over candidate.moves — those are the ones we actually saw.
    expect(set.moves).toEqual(['Knock Off', 'Fake Out']);
  });

  it('falls back to placeholders when no candidates are known', () => {
    const opp: OpponentEntry = {
      species: 'Garchomp',
      knownMoves: [],
    };
    const set = opponentToScoutedSet(opp);
    expect(set.species).toBe('Garchomp');
    expect(set.ability).toBeUndefined();
    expect(set.item).toBeUndefined();
    expect(set.nature).toBe('Hardy');
    expect(set.evs).toEqual(ZERO_EVS);
    expect(set.moves).toEqual([]);
  });

  it('itemConsumed (e.g. Sitrus) takes precedence over candidate item', () => {
    const candidate: PokemonSet = {
      species: 'Aerodactyl', level: 50,
      item: 'Focus Sash', ability: 'Pressure', nature: 'Jolly',
      evs: { ...ZERO_EVS, atk: 252, spe: 252 }, ivs: { ...MAX_IVS }, moves: [],
    };
    const opp: OpponentEntry = {
      species: 'Aerodactyl', knownMoves: [],
      candidates: [candidate],
      itemConsumed: 'Air Balloon',
    };
    const set = opponentToScoutedSet(opp);
    expect(set.item).toBe('Air Balloon');
  });
});

describe('exportScoutedOpponents', () => {
  it('emits a Showdown-compatible export with annotation header', () => {
    const opp: OpponentEntry = {
      species: 'Incineroar', knownMoves: ['Knock Off'],
      candidates: [{
        species: 'Incineroar', level: 50, ability: 'Intimidate',
        item: 'Safety Goggles', nature: 'Careful',
        evs: { hp: 252, atk: 0, def: 0, spa: 0, spd: 252, spe: 4 },
        ivs: { ...MAX_IVS }, moves: [],
      }],
      speedFloor: 100, speedCeiling: 130, scarfChance: 30,
    };
    const m = emptyMatch([opp]);
    m.opponentBrought = [0];
    const txt = exportScoutedOpponents(m);

    expect(txt).toContain('// Scouted opponents from match m1');
    expect(txt).toContain('// Incineroar:');
    // effectiveSpeedRange tightens against the candidate-derived range too,
    // so the final number may differ from the raw speedFloor/Ceiling we set
    // on the entry. Just assert the speed line is present + tagged with a
    // source.
    expect(txt).toMatch(/speed \d+-\d+ \((inferred|candidates|envelope|mixed)\)/);
    expect(txt).toContain('scarf 30%');
    // Standard Showdown block:
    expect(txt).toContain('Incineroar @ Safety Goggles');
    expect(txt).toContain('Ability: Intimidate');
    // EVs are emitted in PoChamps stat-point units (0–32), not standard
    // EVs (0–252) — Champions Showdown expects the SP scale.
    // spFromEv(252) = 32, spFromEv(4) = 1.
    expect(txt).toContain('32 HP / 32 SpD / 1 Spe');
    expect(txt).toContain('Careful Nature');
    expect(txt).toContain('- Knock Off');
  });

  it('falls back to the full opp team when nothing was brought yet', () => {
    const a: OpponentEntry = { species: 'Garchomp', knownMoves: [] };
    const b: OpponentEntry = { species: 'Tinkaton', knownMoves: [] };
    const m = emptyMatch([a, b]);
    // opponentBrought left empty (pre-battle preview)
    const txt = exportScoutedOpponents(m);
    expect(txt).toContain('Garchomp');
    expect(txt).toContain('Tinkaton');
  });
});
