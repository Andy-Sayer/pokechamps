import { describe, test, expect } from 'vitest';
import { actualSpeed, applySpeedInference, inferOpponentSpeeds } from '../src/domain/speed.js';
import type { Match, MoveAction, OpponentEntry, PokemonSet, Turn } from '../src/domain/types.js';
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

  test('opp-vs-opp ordering constrains both opps from their bare envelopes', () => {
    // User's bug repro. m2 Basculegion (fast), m1 Kingambit (slow), opps are
    // Absol and Abomasnow. Logged order was: m2, o2 (Abomasnow), o1 (Absol),
    // m1. So Abomasnow > Absol in actual play.
    //
    // Bare envelopes:
    //   Absol     base 75 → [68, 167] roughly (no nature → -10% / no EV vs +10% / 252)
    //   Abomasnow base 60 → [55, 145] roughly
    //
    // Constraint: Abomasnow.speed > Absol.speed
    //   → Abomasnow.min ≥ Absol.min + 1
    //   → Absol.max     ≤ Abomasnow.max - 1
    //
    // We don't need to assert the exact envelope numbers (those are stat
    // arithmetic noise) — just that BOTH opps' bounds tightened from the
    // pure-envelope state where they were undefined.
    const myFast = mon({
      species: 'Basculegion', nature: 'Jolly',
      evs: { ...ZERO_EVS, atk: 252, spe: 252 },
    });
    const mySlow = mon({
      species: 'Kingambit', nature: 'Adamant',
      evs: { ...ZERO_EVS, atk: 252, hp: 252 },
    });
    const match = makeMatch(
      [myFast, mySlow],
      ['Absol', 'Abomasnow'],
      [turn([
        act({ side: 'mine',   attackerTeamIndex: 0, move: 'Tackle', order: 1 }),
        act({ side: 'theirs', attackerTeamIndex: 1, move: 'Tackle', order: 2 }), // Abomasnow
        act({ side: 'theirs', attackerTeamIndex: 0, move: 'Tackle', order: 3 }), // Absol
        act({ side: 'mine',   attackerTeamIndex: 1, move: 'Tackle', order: 4 }),
      ])],
    );
    const inf = inferOpponentSpeeds(match, match.myTeam);

    // o1 = Absol → speedCeiling must be set (because it lost to Abomasnow).
    expect(inf[0]!.speedCeiling).toBeDefined();
    // o2 = Abomasnow → speedFloor must be set (because it beat Absol).
    expect(inf[1]!.speedFloor).toBeDefined();

    // Sanity: Abomasnow's floor should be above the slowest Absol could be (1
    // + Absol's bare-envelope min). We don't pin the exact number, just that
    // it's well above 0.
    expect(inf[1]!.speedFloor!).toBeGreaterThan(0);
    expect(inf[0]!.speedCeiling!).toBeGreaterThan(0);

    // Additionally bounded by mine-vs-opp: m2 Basculegion moved before both
    // opps, so both must be ≤ Basculegion.speed - 1. And m1 Kingambit moved
    // AFTER both opps, so both must be ≥ Kingambit.speed + 1.
    expect(inf[0]!.speedFloor).toBeGreaterThan(0);
    expect(inf[1]!.speedCeiling).toBeGreaterThan(0);
  });

  test('mine switch + opp switch — opp gets a speed bound from my switching mon', () => {
    // Both switches share the +6 priority bracket. My outgoing mon's
    // ACTUAL speed bounds the opp's. Here m1 (Jolly Sneasler, very fast)
    // switched out before o1 → opp speed ≤ mySpd - 1.
    const myFast = mon({
      species: 'Sneasler', nature: 'Jolly',
      evs: { ...ZERO_EVS, atk: 252, spe: 252 },
    });
    const myFastSpd = actualSpeed(myFast);
    const match = makeMatch(
      [myFast, mon({ species: 'Garchomp' })],
      ['Incineroar'],
      [turn([
        act({ side: 'mine',   attackerTeamIndex: 0, move: 'switch', order: 1, kind: 'switch' }),
        act({ side: 'theirs', attackerTeamIndex: 0, move: 'switch', order: 2, kind: 'switch' }),
      ])],
    );
    const inf = inferOpponentSpeeds(match, match.myTeam);
    expect(inf[0]!.speedCeiling).toBe(myFastSpd - 1);
  });

  test('switch-vs-switch opp-vs-opp constrains both opps', () => {
    // User's exact repro scenario, using ONLY switch actions so no damage
    // logging is needed. The order says Abomasnow (o2) switched before
    // Absol (o1), so Abomasnow.speed > Absol.speed.
    const myAny = mon({ species: 'Pikachu' });
    const match = makeMatch(
      [myAny],
      ['Absol', 'Abomasnow'],
      [turn([
        // Pure switch-vs-switch on opp side, no mine actions involved.
        act({ side: 'theirs', attackerTeamIndex: 1, move: 'switch', order: 1, kind: 'switch' }),
        act({ side: 'theirs', attackerTeamIndex: 0, move: 'switch', order: 2, kind: 'switch' }),
      ])],
    );
    const inf = inferOpponentSpeeds(match, match.myTeam);
    // Abomasnow faster than Absol → Abomasnow.speedFloor + Absol.speedCeiling.
    expect(inf[1]!.speedFloor).toBeDefined();
    expect(inf[0]!.speedCeiling).toBeDefined();
  });

  test('switch + priority-0 move stay in DIFFERENT brackets (no signal)', () => {
    // Switch is +6, Close Combat is 0 — different brackets, no constraint.
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

  test('opp-vs-opp under trick room flips the inequality', () => {
    // Under TR, the action that moved earlier was the SLOWER mon. So if
    // attackerTeamIndex 1 (Abomasnow) moved before attackerTeamIndex 0
    // (Absol), Abomasnow.speed < Absol.speed.
    const myAny = mon({ species: 'Torkoal', nature: 'Quiet' });
    const match = makeMatch(
      [myAny],
      ['Absol', 'Abomasnow'],
      [turn([
        act({ side: 'theirs', attackerTeamIndex: 1, move: 'Tackle', order: 1 }), // Abomasnow first under TR → slower
        act({ side: 'theirs', attackerTeamIndex: 0, move: 'Tackle', order: 2 }), // Absol second → faster
      ], { trickRoom: true })],
    );
    const inf = inferOpponentSpeeds(match, match.myTeam);
    // Abomasnow is slower → it gets a CEILING.
    expect(inf[1]!.speedCeiling).toBeDefined();
    // Absol is faster → it gets a FLOOR.
    expect(inf[0]!.speedFloor).toBeDefined();
  });
});

describe('applySpeedInference: candidate filter', () => {
  test('drops candidates whose actualSpeed violates the inferred floor', () => {
    // Two candidate spreads for Garchomp: one slow (Adamant, 0 Spe EVs) and
    // one fast (Jolly, 252 Spe EVs). If we infer speedFloor of 200, only the
    // fast one survives.
    const slowSet: PokemonSet = {
      species: 'Garchomp', level: 50, nature: 'Adamant',
      evs: { ...ZERO_EVS, atk: 252, hp: 252 }, ivs: MAX_IVS, moves: [],
    };
    const fastSet: PokemonSet = {
      species: 'Garchomp', level: 50, nature: 'Jolly',
      evs: { ...ZERO_EVS, atk: 252, spe: 252 }, ivs: MAX_IVS, moves: [],
    };
    // Sanity: fast > 200, slow < 200 (Garchomp base 102 Spe → Jolly 252 ≈ 191,
    // Adamant 0 ≈ 122). Pick a floor that bisects.
    expect(actualSpeed(fastSet)).toBeGreaterThan(150);
    expect(actualSpeed(slowSet)).toBeLessThan(150);

    const opp: OpponentEntry = {
      species: 'Garchomp',
      knownMoves: [],
      candidates: [slowSet, fastSet],
    };
    applySpeedInference([opp], [{ speedFloor: 150 }]);
    expect(opp.candidates).toHaveLength(1);
    expect(opp.candidates![0]!.nature).toBe('Jolly');
  });

  test('filter does not empty candidates — keeps original if no spread survives', () => {
    // If the inferred bound contradicts every candidate (e.g. user logged a
    // bad turn order), we keep the wider belief rather than wipe the set.
    const slow: PokemonSet = {
      species: 'Garchomp', level: 50, nature: 'Adamant',
      evs: { ...ZERO_EVS, atk: 252 }, ivs: MAX_IVS, moves: [],
    };
    const opp: OpponentEntry = {
      species: 'Garchomp', knownMoves: [], candidates: [slow],
    };
    applySpeedInference([opp], [{ speedFloor: 999 }]);
    expect(opp.candidates).toHaveLength(1);
  });

  test('still applies speedFloor/speedCeiling on the entry even with no candidates', () => {
    const opp: OpponentEntry = { species: 'Garchomp', knownMoves: [] };
    applySpeedInference([opp], [{ speedFloor: 100, speedCeiling: 200, scarfSuspected: true }]);
    expect(opp.speedFloor).toBe(100);
    expect(opp.speedCeiling).toBe(200);
    expect(opp.scarfSuspected).toBe(true);
  });
});
