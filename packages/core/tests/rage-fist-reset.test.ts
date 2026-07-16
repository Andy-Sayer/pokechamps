// Rage Fist hit counter — Champions rule: the counter RESETS when the user
// switches out (mainline Gen 9 keeps it across switches).
//
// Coverage:
//  - engine tracks damaging-move hits per mon on BOTH sides (Match.myTimesHit
//    / OpponentEntry.timesHit), incremented in finalizeTurn's damage walk;
//  - sub-absorbed hits do NOT count;
//  - the counter clears on switch-out (finalizeTurn switch persist AND the
//    applyStateUpdate bringIntoSlot path) and stays cleared on re-entry;
//  - damageRange scales Rage Fist's base power off attackerOpts.timesHit
//    (50 + 50/hit, cap 350), so a reset counter is back to 50 BP.
import { describe, test, expect } from 'vitest';
import { finalizeTurn, applyStateUpdate, type ActiveIdx } from '../src/match/engine.js';
import { damageRange } from '../src/domain/damage.js';
import type {
  Match,
  PokemonSet,
  OpponentEntry,
  MoveAction,
} from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return {
    level: 50,
    nature: 'Hardy',
    evs: { ...ZERO_EVS },
    ivs: MAX_IVS,
    ...p,
  };
}

const annihilape: PokemonSet = mon({
  species: 'Annihilape', ability: 'Defiant', nature: 'Adamant',
  evs: { hp: 252, atk: 252, def: 0, spa: 0, spd: 4, spe: 0 },
  moves: ['Rage Fist', 'Drain Punch', 'Bulk Up', 'Protect'],
});

const garchomp: PokemonSet = mon({
  species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly',
  evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
  moves: ['Earthquake', 'Dragon Claw', 'Rock Slide', 'Protect'],
});

const talonflame: PokemonSet = mon({
  species: 'Talonflame', ability: 'Gale Wings', nature: 'Jolly',
  evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
  moves: ['Brave Bird', 'Flare Blitz', 'Tailwind', 'Protect'],
});

const blissey: PokemonSet = mon({
  species: 'Blissey', ability: 'Natural Cure', nature: 'Bold',
  evs: { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 },
  moves: ['Seismic Toss', 'Soft-Boiled', 'Protect', 'Helping Hand'],
});

function freshMatch(): Match {
  const opponentTeam: OpponentEntry[] = ['Incineroar', 'Amoonguss', 'Garchomp', 'Talonflame']
    .map(species => ({ species, knownMoves: [] }));
  return {
    id: 'rage-fist-test',
    startedAt: '2026-07-01T00:00:00.000Z',
    myTeam: [annihilape, garchomp, talonflame, blissey],
    opponentTeam,
    bring: [0, 1, 2, 3],
    opponentBrought: [0, 1] as Match['opponentBrought'],
    turns: [],
    field: NEUTRAL_FIELD,
    active: { mine: [null, null], theirs: [null, null] },
  };
}

const startActive: ActiveIdx = { mine: [0, 1], theirs: [0, 1] };

// My mon (team index 0) takes a hit from opp slot `oppIdx` for `dmg`%.
function oppHitsMyLead(oppIdx: number, dmg: number, order: number, move = 'Knock Off'): MoveAction {
  return {
    side: 'theirs', attackerSlot: oppIdx as 0 | 1, attackerTeamIndex: oppIdx,
    kind: 'move', move,
    target: { side: 'mine', slot: 0 }, targetTeamIndex: 0,
    damageHpPercent: dmg, order,
  };
}

// My slot 0 hits opp team index `oppIdx` for `dmg`%.
function myLeadHitsOpp(oppIdx: number, dmg: number, order: number, move = 'Drain Punch'): MoveAction {
  return {
    side: 'mine', attackerSlot: 0, attackerTeamIndex: 0,
    kind: 'move', move,
    target: { side: 'theirs', slot: oppIdx as 0 | 1 }, targetTeamIndex: oppIdx,
    damageHpPercent: dmg, order,
  };
}

function switchAction(side: 'mine' | 'theirs', slot: 0 | 1, incomingIdx: number, order: number): MoveAction {
  return {
    side, attackerSlot: slot,
    kind: 'switch', move: 'switch',
    target: 'self', targetTeamIndex: incomingIdx, order,
  };
}

describe('Rage Fist hit counter: accrual', () => {
  test('my mon accrues timesHit when hit by damaging moves (one per hit)', () => {
    const match = freshMatch();
    const r = finalizeTurn({
      match,
      turn: { actions: [oppHitsMyLead(0, 20, 1), oppHitsMyLead(1, 15, 2, 'Sludge Bomb')], field: match.field },
      activeIdx: startActive,
    });
    expect(r.match.myTimesHit?.[0]).toBe(2);
    expect(r.match.myTimesHit?.[1]).toBeUndefined(); // untouched ally: no counter
  });

  test('opp mon accrues timesHit when hit by my damaging moves', () => {
    const match = freshMatch();
    const r = finalizeTurn({
      match,
      turn: { actions: [myLeadHitsOpp(0, 30, 1)], field: match.field },
      activeIdx: startActive,
    });
    expect(r.match.opponentTeam[0]!.timesHit).toBe(1);
    expect(r.match.opponentTeam[1]!.timesHit).toBeUndefined();
  });

  test('a hit absorbed by a Substitute does not count', () => {
    const match = freshMatch();
    match.opponentTeam[0] = { ...match.opponentTeam[0]!, substitute: 25 };
    const r = finalizeTurn({
      match,
      turn: { actions: [myLeadHitsOpp(0, 20, 1)], field: match.field },
      activeIdx: startActive,
    });
    expect(r.match.opponentTeam[0]!.timesHit).toBeUndefined();
  });

  test('counter accumulates across turns while the mon stays in', () => {
    const match = freshMatch();
    const r1 = finalizeTurn({
      match, turn: { actions: [oppHitsMyLead(0, 10, 1)], field: match.field }, activeIdx: startActive,
    });
    const r2 = finalizeTurn({
      match: r1.match, turn: { actions: [oppHitsMyLead(0, 10, 1)], field: r1.match.field }, activeIdx: r1.activeIdx,
    });
    expect(r2.match.myTimesHit?.[0]).toBe(2);
  });
});

describe('Rage Fist hit counter: Champions reset on switch-out', () => {
  test('my mon: counter clears on switch-out and stays cleared on re-entry', () => {
    const match = freshMatch();
    // Turn 1: m1 takes two hits.
    const r1 = finalizeTurn({
      match,
      turn: { actions: [oppHitsMyLead(0, 20, 1), oppHitsMyLead(1, 15, 2, 'Sludge Bomb')], field: match.field },
      activeIdx: startActive,
    });
    expect(r1.match.myTimesHit?.[0]).toBe(2);
    // Turn 2: m1 switches out (Talonflame, team index 2, comes in).
    const r2 = finalizeTurn({
      match: r1.match,
      turn: { actions: [switchAction('mine', 0, 2, 1)], field: r1.match.field },
      activeIdx: r1.activeIdx,
    });
    expect(r2.match.myTimesHit?.[0]).toBeUndefined();
    expect(r2.activeIdx.mine[0]).toBe(2);
    // Turn 3: m1 (Annihilape) switches back in — counter starts fresh.
    const r3 = finalizeTurn({
      match: r2.match,
      turn: { actions: [switchAction('mine', 0, 0, 1)], field: r2.match.field },
      activeIdx: r2.activeIdx,
    });
    expect(r3.match.myTimesHit?.[0]).toBeUndefined();
    // A new hit counts from zero again.
    const r4 = finalizeTurn({
      match: r3.match,
      turn: { actions: [oppHitsMyLead(0, 10, 1)], field: r3.match.field },
      activeIdx: r3.activeIdx,
    });
    expect(r4.match.myTimesHit?.[0]).toBe(1);
  });

  test('opp mon: counter clears on switch-out (voluntary switch action)', () => {
    const match = freshMatch();
    const r1 = finalizeTurn({
      match, turn: { actions: [myLeadHitsOpp(0, 25, 1)], field: match.field }, activeIdx: startActive,
    });
    expect(r1.match.opponentTeam[0]!.timesHit).toBe(1);
    // Opp switches slot 0: o1 out, o3 (Garchomp, index 2) in.
    const r2 = finalizeTurn({
      match: r1.match,
      turn: { actions: [switchAction('theirs', 0, 2, 1)], field: r1.match.field },
      activeIdx: r1.activeIdx,
    });
    expect(r2.match.opponentTeam[0]!.timesHit).toBeUndefined();
  });

  test('pivot switch (U-turn follow-up switch action) also clears the counter', () => {
    const match = freshMatch();
    const r1 = finalizeTurn({
      match, turn: { actions: [oppHitsMyLead(0, 20, 1)], field: match.field }, activeIdx: startActive,
    });
    expect(r1.match.myTimesHit?.[0]).toBe(1);
    // A pivot's forced switch is logged as a switch action with pivot: true —
    // it goes through the same switch-persist pass, so it must also reset.
    const pivotSwitch: MoveAction = { ...switchAction('mine', 0, 2, 2), pivot: true };
    const uturn: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0,
      kind: 'move', move: 'U-turn',
      target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      damageHpPercent: 10, order: 1,
    };
    const r2 = finalizeTurn({
      match: r1.match,
      turn: { actions: [uturn, pivotSwitch], field: r1.match.field },
      activeIdx: r1.activeIdx,
    });
    expect(r2.match.myTimesHit?.[0]).toBeUndefined();
  });

  test('applyStateUpdate bringIntoSlot path clears the counter on both sides', () => {
    const match = freshMatch();
    const r1 = finalizeTurn({
      match,
      turn: { actions: [oppHitsMyLead(0, 20, 1), myLeadHitsOpp(0, 25, 2)], field: match.field },
      activeIdx: startActive,
    });
    expect(r1.match.myTimesHit?.[0]).toBe(1);
    expect(r1.match.opponentTeam[0]!.timesHit).toBe(1);
    // Mid-turn state line: my Talonflame (index 2) is brought into slot 0.
    const r2 = applyStateUpdate({
      match: r1.match,
      update: { side: 'mine', teamIndex: 2, bringIntoSlot: 0 } as any,
      activeIdx: r1.activeIdx,
    });
    expect(r2.match.myTimesHit?.[0]).toBeUndefined();
    // Opp brings Garchomp (index 2) into their slot 0 — outgoing o1 resets.
    const r3 = applyStateUpdate({
      match: r2.match,
      update: { side: 'theirs', teamIndex: 2, bringIntoSlot: 0 } as any,
      activeIdx: r2.activeIdx,
    });
    expect(r3.match.opponentTeam[0]!.timesHit).toBeUndefined();
  });
});

describe('Rage Fist damage calc: BP follows the counter', () => {
  // Defender must not be Normal-type (Rage Fist is Ghost — a Normal defender
  // is immune and the calc's kochance() throws on all-zero damage).
  const args = (timesHit?: number) => ({
    attacker: annihilape,
    defender: garchomp,
    move: 'Rage Fist',
    field: NEUTRAL_FIELD,
    attackerSide: 'mine' as const,
    ...(timesHit != null ? { attackerOpts: { timesHit } } : {}),
  });

  test('no hits taken (fresh / reset) = base 50 BP; undefined equals 0', () => {
    const fresh = damageRange(args());
    const zero = damageRange(args(0));
    expect(fresh.rolls).toEqual(zero.rolls);
    expect(fresh.max).toBeGreaterThan(0);
  });

  test('each hit taken adds 50 BP (2 hits ≈ 3x the reset damage)', () => {
    const base = damageRange(args());
    const twoHits = damageRange(args(2));
    const ratio = twoHits.max / base.max;
    // BP 150 vs 50 → ~3x (rounding wiggle allowed).
    expect(ratio).toBeGreaterThan(2.8);
    expect(ratio).toBeLessThan(3.2);
  });

  test('caps at 350 BP (6 hits); further hits change nothing', () => {
    const six = damageRange(args(6));
    const twelve = damageRange(args(12));
    expect(twelve.rolls).toEqual(six.rolls);
    const base = damageRange(args());
    const ratio = six.max / base.max;
    expect(ratio).toBeGreaterThan(6.5);
    expect(ratio).toBeLessThan(7.5);
  });

  test('reset round-trip: damage after switch-out is back to the fresh range', () => {
    // Simulates the full story: 3 hits taken → big Rage Fist; switch out and
    // back in → counter gone → calc takes timesHit undefined → base 50 again.
    const pumped = damageRange(args(3));
    const afterReset = damageRange(args(undefined));
    expect(afterReset.max).toBeLessThan(pumped.max);
    expect(afterReset.rolls).toEqual(damageRange(args(0)).rolls);
  });
});
