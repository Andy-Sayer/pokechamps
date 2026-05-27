// Audit follow-ups: Trick/Switcheroo item swap + Sucker Punch (attack-
// conditional move) prediction caveat.
import { describe, test, expect } from 'vitest';
import { isItemSwapMove, isAttackConditionalMove } from '../src/domain/data.js';
import { predictOffense } from '../src/domain/predictions.js';
import { finalizeTurn, type ActiveIdx } from '../src/match/engine.js';
import type { Match, PokemonSet, OpponentEntry, MoveAction } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}

describe('move classifiers', () => {
  test('Trick/Switcheroo are swap moves; Knock Off is not', () => {
    expect(isItemSwapMove('Trick')).toBe(true);
    expect(isItemSwapMove('Switcheroo')).toBe(true);
    expect(isItemSwapMove('Knock Off')).toBe(false);
  });
  test('Sucker Punch / Thunderclap are attack-conditional; Close Combat is not', () => {
    expect(isAttackConditionalMove('Sucker Punch')).toBe(true);
    expect(isAttackConditionalMove('Thunderclap')).toBe(true);
    expect(isAttackConditionalMove('Close Combat')).toBe(false);
  });
});

function freshMatch(): Match {
  const myTeam = [
    mon({ species: 'Sneasler', ability: 'Unburden', item: 'Choice Band', moves: ['Trick'] }),
    mon({ species: 'Rillaboom', ability: 'Grassy Surge', item: 'Assault Vest', moves: ['Grassy Glide'] }),
    mon({ species: 'Iron Hands', ability: 'Quark Drive', moves: ['Drain Punch'] }),
    mon({ species: 'Flutter Mane', ability: 'Protosynthesis', moves: ['Moonblast'] }),
  ];
  const opponentTeam: OpponentEntry[] = ['Incineroar', 'Amoonguss', 'Garchomp', 'Talonflame']
    .map(species => ({ species, knownMoves: [], item: undefined }));
  return {
    id: 'test', startedAt: '2026-05-26T00:00:00.000Z',
    myTeam, opponentTeam, bring: [0, 1, 2, 3],
    opponentBrought: [0, 1], turns: [], field: NEUTRAL_FIELD,
    active: { mine: [null, null], theirs: [null, null] },
  };
}

const startActive: ActiveIdx = { mine: [0, 1], theirs: [0, 1] };

describe('finalizeTurn: Trick swaps items', () => {
  test('my Trick puts my Choice Band on the opp and takes their item', () => {
    const match = freshMatch();
    // Opp Incineroar is holding Sitrus Berry (known).
    match.opponentTeam[0]!.item = 'Sitrus Berry';
    const trick: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Trick', target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [trick], field: match.field }, activeIdx: startActive });
    // Opp now holds my Choice Band; I now hold their Sitrus Berry.
    expect(r.match.opponentTeam[0]!.item).toBe('Choice Band');
    expect(r.match.myTeam[0]!.item).toBe('Sitrus Berry');
  });

  test('swapping onto an unknown-item opp leaves my item undefined afterwards', () => {
    const match = freshMatch(); // opp items undefined
    const trick: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Trick', target: { side: 'theirs', slot: 1 }, targetTeamIndex: 1, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [trick], field: match.field }, activeIdx: startActive });
    expect(r.match.opponentTeam[1]!.item).toBe('Choice Band');
    expect(r.match.myTeam[0]!.item).toBeUndefined();
  });
});

describe('predictOffense flags attack-conditional moves', () => {
  test('Sucker Punch carries a conditional caveat; Moonblast does not', () => {
    const sucker = mon({
      species: 'Sneasler', ability: 'Unburden', nature: 'Jolly',
      evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
      moves: ['Sucker Punch'],
    });
    const plain = mon({
      species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid',
      evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 },
      moves: ['Moonblast'],
    });
    const opp: OpponentEntry = { species: 'Incineroar', knownMoves: [] };
    expect(predictOffense({ attacker: sucker, opponent: opp, field: NEUTRAL_FIELD })!.conditional).toBeTruthy();
    expect(predictOffense({ attacker: plain, opponent: opp, field: NEUTRAL_FIELD })!.conditional).toBeUndefined();
  });
});
