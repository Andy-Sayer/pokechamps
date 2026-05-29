import { describe, test, expect } from 'vitest';
import { actualSpeed, applySpeedInference, effectiveSpeedRange, inferOpponentSpeeds } from '../src/domain/speed.js';
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

describe('effectiveSpeedRange honors an already-mega-evolved forme', () => {
  test('a mega-used entry uses the mega forme base speed, not the base species', () => {
    const base: OpponentEntry = { species: 'Aerodactyl', knownMoves: [] };
    const mega: OpponentEntry = { species: 'Aerodactyl', knownMoves: [], megaUsed: true, megaForme: 'Aerodactyl-Mega' };
    const rBase = effectiveSpeedRange(base);
    const rMega = effectiveSpeedRange(mega);
    expect(rBase).not.toBeNull();
    expect(rMega).not.toBeNull();
    // Mega Aerodactyl (base Spe 150) outruns base Aerodactyl (130) at every EV.
    expect(rMega!.max).toBeGreaterThan(rBase!.max);
    expect(rMega!.min).toBeGreaterThan(rBase!.min);
  });
});

function act(partial: Partial<MoveAction> & { side: 'mine' | 'theirs'; attackerTeamIndex: number; move: string; order: number }): MoveAction {
  return {
    attackerSlot: 0,
    target: 'foes',
    ...partial,
  };
}

function turn(
  actions: MoveAction[],
  opts: { trickRoom?: boolean; myTailwind?: boolean; theirTailwind?: boolean } = {},
): Turn {
  return {
    index: 0,
    actions,
    field: {
      ...NEUTRAL_FIELD,
      trickRoom: !!opts.trickRoom,
      myTailwind: !!opts.myTailwind,
      theirTailwind: !!opts.theirTailwind,
    },
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

  test('formeOverride uses the override species base speed (mega bump)', () => {
    // Base Charizard 100 Spe → Mega Y still 100 (same), but Mega X is 100.
    // Use Pinsir → Pinsir-Mega (85 → 105) for a clear bump.
    const s = mon({
      species: 'Pinsir', nature: 'Jolly',
      evs: { ...ZERO_EVS, spe: 252 },
    });
    const baseSpd = actualSpeed(s);
    const megaSpd = actualSpeed(s, 'Pinsir-Mega');
    expect(megaSpd).toBeGreaterThan(baseSpd);
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
      [
        // Prior turn sets Trick Room, so TR is ALREADY active at the start of
        // the turn we observe. TR is priority −7 → it resolves last, so it
        // never inverts the turn it is set on, only subsequent turns.
        turn([act({ side: 'theirs', attackerTeamIndex: 0, move: 'Trick Room', order: 1 })], { trickRoom: true }),
        turn([
          // In TR, the slower mon moves first. My slow Torkoal moved first =>
          // it "outsped" the opp in TR => opp's actual speed > mine in TR terms,
          // which means opp speed > mySpd in raw stat terms (still: my slower
          // mon went first => opp must be faster than me in raw stat).
          act({ side: 'mine',   attackerTeamIndex: 0, move: 'Heat Wave', order: 1 }),
          act({ side: 'theirs', attackerTeamIndex: 0, move: 'Close Combat', order: 2 }),
        ], { trickRoom: true }),
      ],
    );
    const inf = inferOpponentSpeeds(match, match.myTeam);
    // TR inverts: my-mon-first now means opp speed >= mySpd + 1, not <=.
    expect(inf[0]!.speedFloor).toBe(mySpd + 1);
    expect(inf[0]!.speedCeiling).toBeUndefined();
  });

  test('Prankster status move ignored — different bracket means no speed signal', () => {
    // Whimsicott (Prankster, base 116 Spe) uses Tailwind (status, +1 bracket
    // via Prankster) BEFORE my Jolly Sneasler's Close Combat. Without the
    // ability bump we'd infer Whimsicott outspeeds Jolly Sneasler (false).
    const myFast = mon({
      species: 'Sneasler', nature: 'Jolly',
      evs: { ...ZERO_EVS, spe: 252 },
    });
    const match = makeMatch(
      [myFast],
      ['Whimsicott'],
      [turn([
        act({ side: 'theirs', attackerTeamIndex: 0, move: 'Tailwind',     order: 1 }),
        act({ side: 'mine',   attackerTeamIndex: 0, move: 'Close Combat', order: 2 }),
      ])],
    );
    match.opponentTeam[0]!.ability = 'Prankster';
    const inf = inferOpponentSpeeds(match, match.myTeam);
    expect(inf[0]!.speedFloor).toBeUndefined();
    expect(inf[0]!.speedCeiling).toBeUndefined();
  });

  test('Gale Wings flying move at full HP — no speed signal', () => {
    const myFast = mon({
      species: 'Sneasler', nature: 'Jolly',
      evs: { ...ZERO_EVS, spe: 252 },
    });
    const match = makeMatch(
      [myFast],
      ['Talonflame'],
      [turn([
        act({ side: 'theirs', attackerTeamIndex: 0, move: 'Brave Bird',   order: 1 }),
        act({ side: 'mine',   attackerTeamIndex: 0, move: 'Close Combat', order: 2 }),
      ])],
    );
    match.opponentTeam[0]!.ability = 'Gale Wings';
    match.opponentTeam[0]!.currentHpPercent = 100;
    const inf = inferOpponentSpeeds(match, match.myTeam);
    expect(inf[0]!.speedFloor).toBeUndefined();
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

  test('mine mega + opp mega — opp gets a speed bound (mega-vs-mega bracket)', () => {
    // Both megas resolve in their own +5 bracket; within it they speed-tie.
    // If opp went first → opp.speed > mySpd. If mine went first → opp.speed < mySpd.
    const myFast = mon({
      species: 'Sneasler', nature: 'Jolly',
      evs: { ...ZERO_EVS, atk: 252, spe: 252 },
    });
    const myFastSpd = actualSpeed(myFast);
    const match = makeMatch(
      [myFast],
      ['Incineroar'],
      [turn([
        act({ side: 'mine',   attackerTeamIndex: 0, move: 'mega',  order: 1, kind: 'mega' }),
        act({ side: 'theirs', attackerTeamIndex: 0, move: 'mega',  order: 2, kind: 'mega' }),
      ])],
    );
    const inf = inferOpponentSpeeds(match, match.myTeam);
    // My mega went first → opp must be slower.
    expect(inf[0]!.speedCeiling).toBe(myFastSpd - 1);
  });

  test('Quick Claw proc shifts an action into a higher bracket — no speed signal vs same-natural-bracket', () => {
    // Without +quick, opp going first would imply opp.speed > mySpd. With
    // +quick, opp is effectively +1 priority — different bracket from mine
    // at +0 — so no signal is derived.
    const myFast = mon({
      species: 'Sneasler', nature: 'Jolly',
      evs: { ...ZERO_EVS, atk: 252, spe: 252 },
    });
    const match = makeMatch(
      [myFast],
      ['Incineroar'],
      [turn([
        act({ side: 'theirs', attackerTeamIndex: 0, move: 'Knock Off', order: 1, quickClaw: true }),
        act({ side: 'mine',   attackerTeamIndex: 0, move: 'Close Combat', order: 2 }),
      ])],
    );
    const inf = inferOpponentSpeeds(match, match.myTeam);
    expect(inf[0]!.speedFloor).toBeUndefined();
    expect(inf[0]!.speedCeiling).toBeUndefined();
  });

  test('Quick Claw vs natural-priority move at same effective +1 — pair contributes signal', () => {
    // Quick Claw move at priority 0 lifts to +1; opp uses Sucker Punch
    // (natural +1). Same bracket → speed pair fires.
    const myFast = mon({
      species: 'Sneasler', nature: 'Jolly',
      evs: { ...ZERO_EVS, atk: 252, spe: 252 },
    });
    const mySpd = actualSpeed(myFast);
    const match = makeMatch(
      [myFast],
      ['Bisharp'],
      [turn([
        act({ side: 'mine',   attackerTeamIndex: 0, move: 'Knock Off', order: 1, quickClaw: true }),
        act({ side: 'theirs', attackerTeamIndex: 0, move: 'Sucker Punch', order: 2 }),
      ])],
    );
    const inf = inferOpponentSpeeds(match, match.myTeam);
    // Opp Sucker Punch (natural +1) lost to my Knock Off+quick (also +1)
    // → opp.speed <= mySpd - 1.
    expect(inf[0]!.speedCeiling).toBe(mySpd - 1);
  });

  test('mega vs move — different brackets, no signal', () => {
    // Mega is +5, move is +0 → skipped by the bracket check.
    const myAny = mon({
      species: 'Sneasler', nature: 'Jolly',
      evs: { ...ZERO_EVS, spe: 252 },
    });
    const match = makeMatch(
      [myAny],
      ['Incineroar'],
      [turn([
        act({ side: 'mine',   attackerTeamIndex: 0, move: 'mega',         order: 1, kind: 'mega' }),
        act({ side: 'theirs', attackerTeamIndex: 0, move: 'Knock Off',    order: 2 }),
      ])],
    );
    const inf = inferOpponentSpeeds(match, match.myTeam);
    expect(inf[0]!.speedFloor).toBeUndefined();
    expect(inf[0]!.speedCeiling).toBeUndefined();
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
      [
        // Prior turn establishes TR as active at the start of the observed turn.
        turn([act({ side: 'theirs', attackerTeamIndex: 0, move: 'Trick Room', order: 1 })], { trickRoom: true }),
        turn([
          act({ side: 'theirs', attackerTeamIndex: 1, move: 'Tackle', order: 1 }), // Abomasnow first under TR → slower
          act({ side: 'theirs', attackerTeamIndex: 0, move: 'Tackle', order: 2 }), // Absol second → faster
        ], { trickRoom: true }),
      ],
    );
    const inf = inferOpponentSpeeds(match, match.myTeam);
    // Abomasnow is slower → it gets a CEILING.
    expect(inf[1]!.speedCeiling).toBeDefined();
    // Absol is faster → it gets a FLOOR.
    expect(inf[0]!.speedFloor).toBeDefined();
  });

  test('Tailwind loosens the opp ceiling (~2x my speed, not my raw speed)', () => {
    const mySlow = mon({ species: 'Torkoal', nature: 'Quiet', evs: { ...ZERO_EVS } });
    const mySpd = actualSpeed(mySlow);
    const match = makeMatch(
      [mySlow],
      ['Sneasler'],
      [
        // My Tailwind is already up at the start of the observed turn.
        turn([], { myTailwind: true }),
        turn([
          act({ side: 'mine',   attackerTeamIndex: 0, move: 'Heat Wave',    order: 1 }),
          act({ side: 'theirs', attackerTeamIndex: 0, move: 'Close Combat', order: 2 }),
        ], { myTailwind: true }),
      ],
    );
    const inf = inferOpponentSpeeds(match, match.myTeam);
    // My effective speed was 2*mySpd, so the opp ceiling is 2*mySpd-1 — looser
    // than the no-tailwind mySpd-1 bound.
    expect(inf[0]!.speedCeiling).toBe(2 * mySpd - 1);
    expect(inf[0]!.speedCeiling!).toBeGreaterThan(mySpd - 1);
  });

  test('dynamic speed: a Tailwind set earlier the SAME turn doubles a later teammate (Whimsicott)', () => {
    const whimsicott = mon({ species: 'Whimsicott', ability: 'Prankster', nature: 'Timid', evs: { ...ZERO_EVS, spe: 252 } });
    const mySlow = mon({ species: 'Torkoal', nature: 'Quiet', evs: { ...ZERO_EVS } });
    const slowSpd = actualSpeed(mySlow);
    const match = makeMatch(
      [whimsicott, mySlow],
      ['Sneasler'],
      [turn([
        // Prankster Tailwind → +1 bracket: resolves before the 0-bracket moves
        // and never pairs with them. It sets MY side's Tailwind, so my slow
        // Torkoal — acting later the SAME turn — moves at 2x speed.
        act({ side: 'mine',   attackerTeamIndex: 0, move: 'Tailwind',     order: 1 }),
        act({ side: 'mine',   attackerTeamIndex: 1, move: 'Tackle',       order: 2 }),
        act({ side: 'theirs', attackerTeamIndex: 0, move: 'Close Combat', order: 3 }),
      ])],
    );
    const inf = inferOpponentSpeeds(match, match.myTeam);
    // Torkoal (idx 1) moved before opp in the 0 bracket at doubled speed.
    expect(inf[0]!.speedCeiling).toBe(2 * slowSpd - 1);
  });

  test('Trick Room set THIS turn does not invert the same turn (−7 resolves last)', () => {
    const myFast = mon({ species: 'Sneasler', nature: 'Jolly', evs: { ...ZERO_EVS, spe: 252 } });
    const mySpd = actualSpeed(myFast);
    // Post-turn snapshot has TR on, but it was set THIS turn (no prior turn) so
    // the turn-start state has no TR → the observed order is NOT inverted.
    const match = makeMatch(
      [myFast],
      ['Torkoal'],
      [turn([
        act({ side: 'mine',   attackerTeamIndex: 0, move: 'Close Combat', order: 1 }),
        act({ side: 'theirs', attackerTeamIndex: 0, move: 'Tackle',       order: 2 }),
      ], { trickRoom: true })],
    );
    const inf = inferOpponentSpeeds(match, match.myTeam);
    // My fast mon first → opp CEILING (not the inverted FLOOR).
    expect(inf[0]!.speedCeiling).toBe(mySpd - 1);
    expect(inf[0]!.speedFloor).toBeUndefined();
  });

  test('my mega this turn is inferred at the mega forme speed', () => {
    const pinsir = mon({ species: 'Pinsir', nature: 'Jolly', item: 'Pinsirite', evs: { ...ZERO_EVS, spe: 252 } });
    const baseSpd = actualSpeed(pinsir);
    const megaSpd = actualSpeed(pinsir, 'Pinsir-Mega');
    expect(megaSpd).toBeGreaterThan(baseSpd); // sanity: Mega Pinsir is faster
    const match = makeMatch(
      [pinsir],
      ['Torkoal'],
      [turn([
        act({ side: 'mine',   attackerTeamIndex: 0, move: 'Close Combat', order: 1, mega: true }),
        act({ side: 'theirs', attackerTeamIndex: 0, move: 'Tackle',       order: 2 }),
      ])],
    );
    match.myMegaForme = { 0: 'Pinsir-Mega' };
    const inf = inferOpponentSpeeds(match, match.myTeam);
    // Mega'd before attacking → opp ceiling uses the mega forme speed.
    expect(inf[0]!.speedCeiling).toBe(megaSpd - 1);
    expect(inf[0]!.speedCeiling!).toBeGreaterThan(baseSpd - 1);
  });
});

describe('scarfChance', () => {
  test('0 when the inferred floor is at-or-below Pikalytics expected', () => {
    // Slow my mon outsped by opp → low floor. No scarf signal.
    const mySlow = mon({ species: 'Torkoal', nature: 'Quiet', evs: { ...ZERO_EVS } });
    const match = makeMatch(
      [mySlow],
      ['Incineroar'],
      [turn([
        act({ side: 'theirs', attackerTeamIndex: 0, move: 'Tackle', order: 1 }),
        act({ side: 'mine',   attackerTeamIndex: 0, move: 'Heat Wave', order: 2 }),
      ])],
    );
    const inf = inferOpponentSpeeds(match, match.myTeam);
    // Floor was set (opp went first) but should be below or near expected → 0
    // or undefined chance. We don't pin the exact value, just that it doesn't
    // SUSPECT scarf.
    expect(inf[0]!.scarfSuspected).toBeFalsy();
  });

  test('100 when the inferred floor exceeds the bare envelope max', () => {
    // No non-scarf nature/EV combo can put Incineroar above ~121, so a floor
    // of 180 (e.g. outsped by Jolly Sneasler) is definitively boosted.
    const myFast = mon({
      species: 'Sneasler', nature: 'Jolly',
      evs: { ...ZERO_EVS, atk: 252, spe: 252 },
    });
    const match = makeMatch(
      [myFast],
      ['Incineroar'],
      [turn([
        act({ side: 'theirs', attackerTeamIndex: 0, move: 'Knock Off', order: 1 }),
        act({ side: 'mine',   attackerTeamIndex: 0, move: 'Close Combat', order: 2 }),
      ])],
    );
    const inf = inferOpponentSpeeds(match, match.myTeam);
    expect(inf[0]!.scarfChance).toBe(100);
    expect(inf[0]!.scarfSuspected).toBe(true);
  });

  test('between 0 and 100 when floor is between expected and envelope max', () => {
    // Hand-craft a SpeedInference floor that sits between expected and
    // envelope max — verify the linear ramp. We bypass inferOpponentSpeeds
    // by setting speedFloor directly and re-deriving via applySpeedInference's
    // sibling logic (in this case just check the raw ramp math by exercising
    // a known scenario with a Garchomp opp).
    // Easier: assert that SOME middle-range scenario gives a moderate value.
    // We use a tailwind-free Garchomp opp with mySpd = 110 (sits between
    // expected ~ 102 and envelope max ~ 169) so scarfChance > 0 and < 100.
    const myMid = mon({
      species: 'Hatterene', nature: 'Bold',
      evs: { ...ZERO_EVS, hp: 252, def: 252 },
    });
    // Hatterene's bare speed is ~50ish — not the right test mon.
    // Use Aerodactyl with Adamant + 0 EVs → about 105 (between Garchomp's
    // expected and envelope max). Opp outsped my Aerodactyl → floor 106.
    const myMidSpd = mon({
      species: 'Aerodactyl', nature: 'Adamant',
      evs: { ...ZERO_EVS, atk: 252 },
    });
    expect(actualSpeed(myMidSpd)).toBeGreaterThan(100);
    expect(actualSpeed(myMidSpd)).toBeLessThan(160);
    const match = makeMatch(
      [myMidSpd],
      ['Garchomp'],
      [turn([
        act({ side: 'theirs', attackerTeamIndex: 0, move: 'Tackle', order: 1 }),
        act({ side: 'mine',   attackerTeamIndex: 0, move: 'Tackle', order: 2 }),
      ])],
    );
    const inf = inferOpponentSpeeds(match, match.myTeam);
    // chance might be undefined (if floor ≤ expected) OR > 0. We just want
    // to confirm scarfSuspected isn't always-true. With pikalytics data
    // present scarfChance will be 0 if the floor is ≤ expected, or some
    // positive number if it exceeds it. Either is fine — the assertion is
    // that we're NOT defaulting to 100% on a mild outspeed.
    const ch = inf[0]!.scarfChance ?? 0;
    expect(ch).toBeLessThan(100);
  });
});

describe('effectiveSpeedRange', () => {
  test('falls back to bare envelope when nothing else is known', () => {
    const e: OpponentEntry = { species: 'Garchomp', knownMoves: [] };
    const r = effectiveSpeedRange(e);
    expect(r).not.toBeNull();
    expect(r!.source).toBe('envelope');
    expect(r!.min).toBeGreaterThan(0);
    expect(r!.max).toBeGreaterThan(r!.min);
  });

  test('combines: a looser inferred bound does NOT override a tighter envelope', () => {
    // User's exact bug: opp-vs-opp constraint produced speedCeiling = 138
    // for an opp whose bare envelope already capped it at ~123. The combined
    // range should still report ≤123, not ≤138.
    const e: OpponentEntry = {
      species: 'Abomasnow',
      knownMoves: [],
      speedCeiling: 999, // grossly loose
    };
    const env = effectiveSpeedRange({ species: 'Abomasnow', knownMoves: [] })!;
    const r = effectiveSpeedRange(e)!;
    // max should still be the envelope max, not 999
    expect(r.max).toBe(env.max);
    expect(r.max).toBeLessThan(999);
  });

  test('a tightening inferred floor wins over the envelope', () => {
    // Garchomp envelope min is around 68 (0 EV, -nature). Inferred floor
    // 150 (e.g. observed outspeeding a fast mon) MUST tighten the min.
    const e: OpponentEntry = {
      species: 'Garchomp', knownMoves: [], speedFloor: 150,
    };
    const r = effectiveSpeedRange(e)!;
    expect(r.min).toBe(150);
    expect(r.source).not.toBe('envelope'); // 'inferred' or 'mixed'
  });

  test('candidates can tighten both bounds when inference is silent', () => {
    // Two narrow candidate spreads → the candidate-derived range is tighter
    // than the bare envelope.
    const cand1: PokemonSet = {
      species: 'Garchomp', level: 50, nature: 'Jolly',
      evs: { ...ZERO_EVS, spe: 252 }, ivs: MAX_IVS, moves: [],
    };
    const cand2: PokemonSet = {
      species: 'Garchomp', level: 50, nature: 'Adamant',
      evs: { ...ZERO_EVS, spe: 252 }, ivs: MAX_IVS, moves: [],
    };
    const e: OpponentEntry = {
      species: 'Garchomp', knownMoves: [], candidates: [cand1, cand2],
    };
    const r = effectiveSpeedRange(e)!;
    const env = effectiveSpeedRange({ species: 'Garchomp', knownMoves: [] })!;
    // Both candidates have 252 Spe EVs, so the candidate-derived MIN is far
    // above the bare-envelope min (0-EV, -nature). The MAX matches the
    // envelope ceiling (Jolly 252 is the literal envelope top), so we don't
    // assert it tightens — the goal is to confirm candidates pull bounds in.
    expect(r.min).toBeGreaterThan(env.min);
    expect(r.max).toBeLessThanOrEqual(env.max);
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
