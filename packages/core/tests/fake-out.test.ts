// Fake Out / First Impression / Mat Block first-turn-out gating.
import { describe, test, expect } from 'vitest';
import { firstTurnOut, isFirstTurnMove } from '../src/domain/itemSignals.js';
import { predictOffense } from '../src/domain/predictions.js';
import type { Match, PokemonSet, OpponentEntry, MoveAction, Turn } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
function move(side: 'mine' | 'theirs', idx: number, m: string): MoveAction {
  return { side, attackerSlot: 0, attackerTeamIndex: idx, kind: 'move', move: m, target: { side: side === 'mine' ? 'theirs' : 'mine', slot: 0 }, order: 1 };
}
function sw(side: 'mine' | 'theirs', inIdx: number): MoveAction {
  return { side, attackerSlot: 0, kind: 'switch', move: 'x', target: 'self', targetTeamIndex: inIdx, order: 1 };
}
function turn(i: number, actions: MoveAction[]): Turn { return { index: i, actions, field: NEUTRAL_FIELD }; }
function matchWith(turns: Turn[]): Match {
  return { id: 't', startedAt: '', myTeam: [], opponentTeam: [], bring: [], turns, field: NEUTRAL_FIELD, active: { mine: [null, null], theirs: [null, null] } } as unknown as Match;
}

describe('isFirstTurnMove', () => {
  test('Fake Out / First Impression / Mat Block only', () => {
    expect(isFirstTurnMove('Fake Out')).toBe(true);
    expect(isFirstTurnMove('First Impression')).toBe(true);
    expect(isFirstTurnMove('Mat Block')).toBe(true);
    expect(isFirstTurnMove('Close Combat')).toBe(false);
  });
});

describe('firstTurnOut', () => {
  test('a lead that has not acted is fresh', () => {
    expect(firstTurnOut(matchWith([]), 'mine', 0)).toBe(true);
  });
  test('after the mon acts, it is no longer fresh', () => {
    const m = matchWith([turn(1, [move('mine', 0, 'Fake Out')])]);
    expect(firstTurnOut(m, 'mine', 0)).toBe(false);
  });
  test('switching out and back in resets freshness', () => {
    const m = matchWith([
      turn(1, [move('mine', 0, 'Fake Out')]), // acted → spent
      turn(2, [sw('mine', 1)]),               // 0 switches out (1 in)
      turn(3, [sw('mine', 0)]),               // 0 comes back in
    ]);
    expect(firstTurnOut(m, 'mine', 0)).toBe(true);
  });
});

describe('predictOffense drops a spent Fake Out', () => {
  const attacker = mon({ species: 'Incineroar', ability: 'Intimidate', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Fake Out', 'Flare Blitz'] });
  const opp: OpponentEntry = { species: 'Amoonguss', knownMoves: [] };

  test('fresh → Fake Out is a candidate move; spent → excluded', () => {
    const fresh = predictOffense({ attacker, opponent: opp, field: NEUTRAL_FIELD, attackerFirstTurnOut: true });
    const spent = predictOffense({ attacker, opponent: opp, field: NEUTRAL_FIELD, attackerFirstTurnOut: false });
    expect(spent?.move).not.toBe('Fake Out');
    // The best damaging move when spent should be the real attack.
    expect(spent?.move).toBe('Flare Blitz');
    // (fresh may or may not pick Fake Out as max-damage, but it must be allowed.)
    expect(fresh).not.toBeNull();
  });
});
