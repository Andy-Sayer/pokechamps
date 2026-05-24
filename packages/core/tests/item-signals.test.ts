import { describe, test, expect } from 'vitest';
import { detectChoiceLock } from '../src/domain/itemSignals.js';
import type { Match, MoveAction, Turn } from '../src/domain/types.js';
import { NEUTRAL_FIELD } from '../src/domain/types.js';

function oppMove(idx: number, move: string): MoveAction {
  return { side: 'theirs', attackerSlot: 0, attackerTeamIndex: idx, kind: 'move', move, target: { side: 'mine', slot: 0 }, order: 1 };
}
function oppSwitch(outIdx: number, inIdx: number): MoveAction {
  return { side: 'theirs', attackerSlot: 0, kind: 'switch', move: 'switch', attackerTeamIndex: outIdx, targetTeamIndex: inIdx, target: { side: 'theirs', slot: 0 }, order: 1 };
}
function turn(i: number, actions: MoveAction[]): Turn {
  return { index: i, actions, field: NEUTRAL_FIELD };
}
function matchWith(turns: Turn[]): Match {
  return {
    id: 't', startedAt: '', myTeam: [], opponentTeam: [], bring: [], turns,
    field: NEUTRAL_FIELD, active: { mine: [null, null], theirs: [null, null] },
  } as unknown as Match;
}

describe('detectChoiceLock', () => {
  test('same move two turns running → suspected lock', () => {
    const m = matchWith([turn(1, [oppMove(0, 'Flare Blitz')]), turn(2, [oppMove(0, 'Flare Blitz')])]);
    expect(detectChoiceLock(m, 0)).toEqual({ move: 'Flare Blitz', turns: 2 });
  });

  test('different moves → no lock', () => {
    const m = matchWith([turn(1, [oppMove(0, 'Flare Blitz')]), turn(2, [oppMove(0, 'Knock Off')])]);
    expect(detectChoiceLock(m, 0)).toBeNull();
  });

  test('a switch resets the run', () => {
    const m = matchWith([
      turn(1, [oppMove(0, 'Flare Blitz')]),
      turn(2, [oppSwitch(0, 1)]),
      turn(3, [oppMove(0, 'Flare Blitz')]), // back in, only 1 since reset
    ]);
    expect(detectChoiceLock(m, 0)).toBeNull();
  });

  test('counts only the trailing consecutive run', () => {
    const m = matchWith([
      turn(1, [oppMove(0, 'Earthquake')]),
      turn(2, [oppMove(0, 'Rock Slide')]),
      turn(3, [oppMove(0, 'Rock Slide')]),
      turn(4, [oppMove(0, 'Rock Slide')]),
    ]);
    expect(detectChoiceLock(m, 0)).toEqual({ move: 'Rock Slide', turns: 3 });
  });

  test('multi-hit (several actions, one turn) counts once per turn', () => {
    const m = matchWith([
      turn(1, [oppMove(0, 'Bullet Seed'), oppMove(0, 'Bullet Seed')]),
      turn(2, [oppMove(0, 'Bullet Seed')]),
    ]);
    expect(detectChoiceLock(m, 0)).toEqual({ move: 'Bullet Seed', turns: 2 });
  });

  test('only tracks the requested mon', () => {
    const m = matchWith([turn(1, [oppMove(1, 'Moonblast')]), turn(2, [oppMove(1, 'Moonblast')])]);
    expect(detectChoiceLock(m, 0)).toBeNull();
    expect(detectChoiceLock(m, 1)).toEqual({ move: 'Moonblast', turns: 2 });
  });
});
