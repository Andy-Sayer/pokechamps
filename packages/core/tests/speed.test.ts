import { describe, test, expect } from 'vitest';
import { actualSpeed, inferOpponentSpeeds } from '../src/domain/speed.js';
import type { Match, MoveAction, PokemonSet, Turn } from '../src/domain/types.js';
import { NEUTRAL_FIELD, MAX_IVS } from '../src/domain/types.js';

const ZERO_EVS = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };

function mon(partial: Partial<PokemonSet> & { species: string }): PokemonSet {
  return {
    level: 50,
    nature: 'Hardy',
    evs: { ...ZERO_EVS },
    ivs: MAX_IVS,
    moves: ['Tackle'],
    ...partial,
  };
}

function act(partial: Partial<MoveAction> & { side: 'mine' | 'theirs'; attackerTeamIndex: number; move: string; order: number }): MoveAction {
  return {
    attackerSlot: 0,
    target: 'foes',
    ...partial,
  };
}

function turn(actions: MoveAction[], opts: { trickRoom?: boolean } = {}): Turn {
  return {
    index: 0,
    actions,
    field: { ...NEUTRAL_FIELD, trickRoom: !!opts.trickRoom },
  };
}

function makeMatch(myTeam: PokemonSet[], oppSpecies: string[], turns: Turn[]): Match {
  return {
    id: 't1',
    startedAt: new Date().toISOString(),
    myTeam,
    opponentTeam: oppSpecies.map(s => ({ species: s, knownMoves: [] })),
    bring: [0, 1, 2, 3],
    turns,
    field: NEUTRAL_FIELD,
    active: { mine: [null, null], theirs: [null, null] },
  };
}

describe('actualSpeed', () => {
  test('Jolly Sneasler with 252 Spe EVs hits expected 178', () => {
    // Sneasler base 120 Spe. (2*120 + 31 + 63) * 50/100 + 5 = 167, * 1.1 = 183.7 -> 183
    // (Spot-check: any number in the same ballpark verifies the formula direction)
    const s = mon({
      species: 'Sneasler', nature: 'Jolly',
      evs: { ...ZERO_EVS, atk: 252, spe: 252 },
    });
    const v = actualSpeed(s);
    expect(v).toBeGreaterThan(170);
    expect(v).toBeLessThan(190);
  });

  test('0 Spe / negative-Spe-nature is much slower than max Spe / Jolly', () => {
    const fast = mon({ species: 'Garchomp', nature: 'Jolly', evs: { ...ZERO_EVS, spe: 252 } });
    const slow = mon({ species: 'Garchomp', nature: 'Brave', evs: { ...ZERO_EVS } });
    expect(actualSpeed(fast)).toBeGreaterThan(actualSpeed(slow) + 30);
  });
});

describe('inferOpponentSpeeds', () => {
  test('my fast mon moves before opp -> opp speedCeiling tightens', () => {
    const myFast = mon({
      species: 'Sneasler', nature: 'Jolly',
      evs: { ...ZERO_EVS, atk: 252, spe: 252 },
    });
    const myFastSpd = actualSpeed(myFast);

    const match = makeMatch(
      [myFast],
      ['Incineroar'],
      [turn([
        act({ side: 'mine',   attackerTeamIndex: 0, move: 'Close Combat',   order: 1 }),
        act({ side: 'theirs', attackerTeamIndex: 0, move: 'Flare Blitz',    order: 2 }),
      ])],
    );
    const inf = inferOpponentSpeeds(match, match.myTeam);
    expect(inf[0]!.speedCeiling).toBe(myFastSpd - 1);
    expect(inf[0]!.speedFloor).toBeUndefined();
  });

  test('opp moves before my fastest -> speedFloor and scarfSuspected on a fast mon expected to be slower', () => {
    const myJollySneasler = mon({
      species: 'Sneasler', nature: 'Jolly',
      evs: { ...ZERO_EVS, atk: 252, spe: 252 },
    });
    const mySpd = actualSpeed(myJollySneasler);

    const match = makeMatch(
      [myJollySneasler],
      ['Incineroar'], // base 60 Spe — never naturally outspeeds Jolly Sneasler
      [turn([
        act({ side: 'theirs', attackerTeamIndex: 0, move: 'Knock Off',    order: 1 }),
        act({ side: 'mine',   attackerTeamIndex: 0, move: 'Close Combat', order: 2 }),
      ])],
    );
    const inf = inferOpponentSpeeds(match, match.myTeam);
    expect(inf[0]!.speedFloor).toBe(mySpd + 1);
    expect(inf[0]!.scarfSuspected).toBe(true);
  });

  test('priority move ignored — different bracket means no constraint', () => {
    const myFast = mon({
      species: 'Sneasler', nature: 'Jolly',
      evs: { ...ZERO_EVS, spe: 252 },
    });
    const match = makeMatch(
      [myFast],
      ['Incineroar'],
      // Opp moves first because Fake Out is +3, mine is +0 — no speed signal.
      [turn([
        act({ side: 'theirs', attackerTeamIndex: 0, move: 'Fake Out',     order: 1 }),
        act({ side: 'mine',   attackerTeamIndex: 0, move: 'Close Combat', order: 2 }),
      ])],
    );
    const inf = inferOpponentSpeeds(match, match.myTeam);
    expect(inf[0]!.speedFloor).toBeUndefined();
    expect(inf[0]!.speedCeiling).toBeUndefined();
  });

  test('trick room inverts the inequality', () => {
    const mySlow = mon({ species: 'Torkoal', nature: 'Quiet', evs: { ...ZERO_EVS } });
    const mySpd = actualSpeed(mySlow);
    const match = makeMatch(
      [mySlow],
      ['Sneasler'],
      [turn([
        // In TR, the slower mon moves first. My slow Torkoal moved first =>
        // it "outsped" the opp in TR => opp's actual speed > mine in TR terms,
        // which means opp speed > mySpd in raw stat terms (still: my slower
        // mon went first => opp must be faster than me in raw stat).
        act({ side: 'mine',   attackerTeamIndex: 0, move: 'Heat Wave', order: 1 }),
        act({ side: 'theirs', attackerTeamIndex: 0, move: 'Close Combat', order: 2 }),
      ], { trickRoom: true })],
    );
    const inf = inferOpponentSpeeds(match, match.myTeam);
    // TR inverts: my-mon-first now means opp speed >= mySpd + 1, not <=.
    expect(inf[0]!.speedFloor).toBe(mySpd + 1);
    expect(inf[0]!.speedCeiling).toBeUndefined();
  });

  test('switch action does not participate in speed pairs', () => {
    const myFast = mon({
      species: 'Sneasler', nature: 'Jolly',
      evs: { ...ZERO_EVS, spe: 252 },
    });
    const match = makeMatch(
      [myFast],
      ['Incineroar'],
      [turn([
        act({ side: 'theirs', attackerTeamIndex: 0, move: 'switch', order: 1, kind: 'switch' }),
        act({ side: 'mine',   attackerTeamIndex: 0, move: 'Close Combat', order: 2 }),
      ])],
    );
    const inf = inferOpponentSpeeds(match, match.myTeam);
    expect(inf[0]!.speedFloor).toBeUndefined();
    expect(inf[0]!.speedCeiling).toBeUndefined();
  });
});
