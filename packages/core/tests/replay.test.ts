import { describe, test, expect } from 'vitest';
import { replayTallyUpTo, approxHpFromTaken } from '../src/domain/replay.js';
import type { Match, MoveAction, PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

const set = (species: string): PokemonSet => ({ species, level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, moves: [] });
const opp = (species: string): OpponentEntry => ({ species, knownMoves: [] });

function mineAttack(atk: number, tgt: number, dmg: number): MoveAction {
  return { side: 'mine', attackerSlot: 0, attackerTeamIndex: atk, kind: 'move', move: 'Hit', target: { side: 'theirs', slot: 0 }, targetTeamIndex: tgt, damageHpPercent: dmg, order: 1 };
}
function oppAttack(atk: number, tgt: number, dmg: number): MoveAction {
  return { side: 'theirs', attackerSlot: 0, attackerTeamIndex: atk, kind: 'move', move: 'Hit', target: { side: 'mine', slot: 0 }, targetTeamIndex: tgt, damageHpPercent: dmg, order: 2 };
}

const match: Match = {
  id: 't', startedAt: '2026-06-07T00:00:00Z',
  myTeam: [set('Flutter Mane'), set('Incineroar')],
  opponentTeam: [opp('Kingambit'), opp('Pelipper')],
  bring: [0, 1, 0, 1] as Match['bring'],
  opponentBrought: [0, 1] as Match['opponentBrought'],
  turns: [
    { index: 1, actions: [mineAttack(0, 0, 40), oppAttack(0, 1, 30)], field: { ...NEUTRAL_FIELD } },
    { index: 2, actions: [mineAttack(0, 0, 70), oppAttack(0, 1, 25)], field: { ...NEUTRAL_FIELD, weather: 'Rain' } },
  ],
  field: { ...NEUTRAL_FIELD },
  active: { mine: [0, 1], theirs: [0, 1] },
};

describe('replayTallyUpTo', () => {
  test('turn 0: only the first turn is counted', () => {
    const t = replayTallyUpTo(match, 0);
    expect(t.myDealt[0]).toBe(40);     // Flutter dealt 40 to opp 0
    expect(t.oppTaken[0]).toBe(40);
    expect(t.oppDealt[0]).toBe(30);    // Kingambit dealt 30 to my 1
    expect(t.myTaken[1]).toBe(30);
    expect(t.myDealt[1]).toBeUndefined();
  });

  test('turn 1: cumulative across both turns', () => {
    const t = replayTallyUpTo(match, 1);
    expect(t.myDealt[0]).toBe(110);    // 40 + 70
    expect(t.oppTaken[0]).toBe(110);
    expect(t.myTaken[1]).toBe(55);     // 30 + 25
  });

  test('clamps the cursor past the end', () => {
    const t = replayTallyUpTo(match, 99);
    expect(t.myDealt[0]).toBe(110);
  });

  test('approxHpFromTaken = 100 − taken, clamped to 0', () => {
    const t = replayTallyUpTo(match, 1);
    expect(approxHpFromTaken(t.myTaken, 1)).toBe(45);   // 100 − 55
    expect(approxHpFromTaken(t.oppTaken, 0)).toBe(0);   // 110 taken → clamped 0
    expect(approxHpFromTaken(t.myTaken, 0)).toBe(100);  // untouched
  });
});
