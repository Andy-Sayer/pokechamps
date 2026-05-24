// A.3 calc-path fix: item-removing moves (Knock Off etc.) mark the target's
// item gone, and the prediction calc stops applying a removed item.
import { describe, test, expect } from 'vitest';
import { isItemRemovingMove } from '../src/domain/data.js';
import { predictOffense } from '../src/domain/predictions.js';
import { finalizeTurn, type ActiveIdx } from '../src/match/engine.js';
import type { Match, PokemonSet, OpponentEntry, MoveAction } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}

describe('isItemRemovingMove', () => {
  test('Knock Off / Thief / Covet remove items; Earthquake does not', () => {
    expect(isItemRemovingMove('Knock Off')).toBe(true);
    expect(isItemRemovingMove('Thief')).toBe(true);
    expect(isItemRemovingMove('Covet')).toBe(true);
    expect(isItemRemovingMove('Earthquake')).toBe(false);
  });
});

describe('predictOffense honours item removal', () => {
  // Special attacker vs a defender holding Assault Vest (1.5x SpD). Once the
  // item is marked consumed, the calc should report higher damage.
  const attacker = mon({
    species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid',
    evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 },
    moves: ['Moonblast'],
  });
  const oppBase: OpponentEntry = {
    species: 'Incineroar', knownMoves: [],
    candidates: [mon({
      species: 'Incineroar', ability: 'Intimidate', item: 'Assault Vest', nature: 'Careful',
      evs: { hp: 252, atk: 0, def: 0, spa: 0, spd: 252, spe: 4 },
      moves: ['Knock Off'],
    })],
  };

  test('stripping Assault Vest raises predicted damage', () => {
    const withItem = predictOffense({ attacker, opponent: oppBase, field: NEUTRAL_FIELD })!;
    const removed = predictOffense({ attacker, opponent: { ...oppBase, itemConsumed: 'knocked off' }, field: NEUTRAL_FIELD })!;
    expect(withItem).not.toBeNull();
    expect(removed.maxPercent).toBeGreaterThan(withItem.maxPercent);
  });
});

// ---------------- engine integration ----------------

function freshMatch(): Match {
  const myTeam = [
    mon({ species: 'Sneasler', ability: 'Unburden', item: 'Focus Sash', moves: ['Knock Off'] }),
    mon({ species: 'Rillaboom', ability: 'Grassy Surge', item: 'Assault Vest', moves: ['Grassy Glide'] }),
    mon({ species: 'Iron Hands', ability: 'Quark Drive', moves: ['Drain Punch'] }),
    mon({ species: 'Flutter Mane', ability: 'Protosynthesis', moves: ['Moonblast'] }),
  ];
  const opponentTeam: OpponentEntry[] = ['Incineroar', 'Amoonguss', 'Garchomp', 'Talonflame']
    .map(species => ({ species, knownMoves: [] }));
  return {
    id: 'test', startedAt: '2026-05-24T00:00:00.000Z',
    myTeam, opponentTeam, bring: [0, 1, 2, 3],
    opponentBrought: [0, 1], turns: [], field: NEUTRAL_FIELD,
    active: { mine: [null, null], theirs: [null, null] },
  };
}

const startActive: ActiveIdx = { mine: [0, 1], theirs: [0, 1] };

describe('finalizeTurn: Knock Off marks item gone', () => {
  test('my Knock Off marks the opp target item consumed', () => {
    const match = freshMatch();
    const ko: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Knock Off', target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      damageHpPercent: 20, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [ko], field: match.field }, activeIdx: startActive });
    expect(r.match.opponentTeam[0]!.itemConsumed).toMatch(/Knock Off/);
  });

  test('opp Knock Off on my mon records the lost item name', () => {
    const match = freshMatch();
    const ko: MoveAction = {
      side: 'theirs', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Knock Off', target: { side: 'mine', slot: 1 }, targetTeamIndex: 1,
      targetRemainingHpPercent: 80, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [ko], field: match.field }, activeIdx: startActive });
    // Rillaboom (myTeam[1]) held Assault Vest.
    expect(r.match.myItemConsumed?.[1]).toBe('Assault Vest');
  });
});
