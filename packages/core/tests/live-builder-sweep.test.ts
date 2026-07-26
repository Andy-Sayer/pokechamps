// A SWEEP of searchInputFromMatch against everything the search reads. Three bugs in one
// night came from the same shape — the mechanic modelled correctly, the LIVE builder
// never populating it (Eelevate's grounding, the protect streak, the Rage Fist counter).
// Unit tests that construct SearchInput directly cannot catch that class by design, so
// these assert the plumbing itself.
import { describe, test, expect } from 'vitest';
import { searchInputFromMatch } from '../src/domain/endgameSearch.js';
import type { Match, MoveAction, OpponentEntry, PokemonSet } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
const ACTIVE = { mine: [0, null] as [number | null, number | null], theirs: [0, null] as [number | null, number | null] };
const move = (side: 'mine' | 'theirs', attacker: number, mv: string, target?: number): MoveAction =>
  ({ side, kind: 'move', attackerTeamIndex: attacker, move: mv, ...(target != null ? { targetTeamIndex: target } : {}) } as MoveAction);
const turn = (n: number, actions: MoveAction[]) => ({ index: n, actions, field: { ...NEUTRAL_FIELD } });

const base = (): Match => ({
  id: 't', startedAt: '2026-07-26T00:00:00.000Z',
  myTeam: [mon({ species: 'Kingambit', ability: 'Defiant', moves: ['Kowtow Cleave', 'Iron Head'] })],
  opponentTeam: [{ species: 'Sableye', knownMoves: ['Torment', 'Knock Off'] } as OpponentEntry],
  bring: [0], opponentBrought: [0], turns: [], field: { ...NEUTRAL_FIELD },
  active: { mine: [0, null], theirs: [0, null] },
});

describe('live builder threads Substitute HP', () => {
  test('my sub reaches the search', () => {
    const m = base();
    m.myCurrentSub = { 0: 25 };
    expect(searchInputFromMatch(m, ACTIVE).mine[0]!.subHpPercent).toBe(25);
  });

  test('the opponent’s sub does too', () => {
    const m = base();
    m.opponentTeam[0]!.substitute = 25;
    expect(searchInputFromMatch(m, ACTIVE).opp[0]!.subHpPercent).toBe(25);
  });

  test('no sub → undefined, not 0 (0 would read as a broken sub)', () => {
    expect(searchInputFromMatch(base(), ACTIVE).mine[0]!.subHpPercent).toBeUndefined();
  });
});

describe('live builder threads Torment + last move', () => {
  test('the last move I used is reported', () => {
    const m = base();
    m.turns = [turn(1, [move('mine', 0, 'Kowtow Cleave')])];
    expect(searchInputFromMatch(m, ACTIVE).mine[0]!.lastMove).toBe('Kowtow Cleave');
  });

  test('a Torment aimed at me sets the flag', () => {
    const m = base();
    m.turns = [turn(1, [move('theirs', 0, 'Torment', 0), move('mine', 0, 'Kowtow Cleave')])];
    const inp = searchInputFromMatch(m, ACTIVE);
    expect(inp.mine[0]!.tormented).toBe(true);
    expect(inp.mine[0]!.lastMove).toBe('Kowtow Cleave');
  });

  test('Torment is a VOLATILE — switching out clears it', () => {
    const m = base();
    m.turns = [
      turn(1, [move('theirs', 0, 'Torment', 0)]),
      turn(2, [{ side: 'mine', kind: 'switch', attackerTeamIndex: 0 } as MoveAction]),
    ];
    expect(searchInputFromMatch(m, ACTIVE).mine[0]!.tormented).toBe(false);
  });

  test('a Torment on someone ELSE does not flag me', () => {
    const m = base();
    m.myTeam.push(mon({ species: 'Dragonite', ability: 'Multiscale', moves: ['Extreme Speed'] }));
    m.bring = [0, 1];
    m.turns = [turn(1, [move('theirs', 0, 'Torment', 1)])];
    const inp = searchInputFromMatch(m, { mine: [0, 1], theirs: [0, null] });
    expect(inp.mine[0]!.tormented).toBe(false);
    expect(inp.mine[1]!.tormented).toBe(true);
  });
});
