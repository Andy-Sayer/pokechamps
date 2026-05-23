import { describe, test, expect } from 'vitest';
import { parseTurnLine, type ParseContext } from '../src/domain/turnparser.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

const my: PokemonSet[] = [
  { species: 'Sneasler', level: 50, nature: 'Jolly', evs: { ...ZERO_EVS }, ivs: MAX_IVS, moves: [] },
  { species: 'Garchomp', level: 50, nature: 'Jolly', evs: { ...ZERO_EVS }, ivs: MAX_IVS, moves: [] },
  { species: 'Kingambit', level: 50, nature: 'Adamant', evs: { ...ZERO_EVS }, ivs: MAX_IVS, moves: [] },
];
const opp: OpponentEntry[] = [
  { species: 'Incineroar', knownMoves: [] },
  { species: 'Pelipper', knownMoves: [] },
  { species: 'Sinistcha', knownMoves: [] },
];

const ctx: ParseContext = {
  myTeam: my,
  opponentTeam: opp,
  myActiveTeamIndex: [0, 1],
  theirActiveTeamIndex: [0, 1],
};

describe('parseTurnLine', () => {
  test('basic move with damage (target=theirs → remaining %)', () => {
    const r = parseTurnLine('m1 > Close Combat > o1 > 67', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.side).toBe('mine');
    expect(r.actions[0]!.attackerSlot).toBe(0);
    expect(r.actions[0]!.kind).toBe('move');
    expect(r.actions[0]!.move).toBe('Close Combat');
    // Bare number, target on opp → REMAINING %
    expect(r.actions[0]!.targetRemainingHpPercent).toBe(67);
    expect(r.actions[0]!.damageHpPercent).toBeUndefined();
    expect(r.actions[0]!.order).toBe(1);
    expect(r.actions[0]!.attackerTeamIndex).toBe(0);
    expect(r.actions[0]!.targetTeamIndex).toBe(0);
    expect(r.actions[0]!.mega).toBeUndefined();
  });

  test('+quick modifier sets quickClaw=true', () => {
    const r = parseTurnLine('m1+quick > Knock Off > o1 > 67', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.quickClaw).toBe(true);
    // Mega + crit not set when only +quick was used.
    expect(r.actions[0]!.mega).toBeUndefined();
    expect(r.actions[0]!.critical).toBeUndefined();
  });

  test('+qc alias also sets quickClaw=true', () => {
    const r = parseTurnLine('o2+qc > Sucker Punch > m1 > 41%', ctx, 2);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.quickClaw).toBe(true);
  });

  test('mega modifier sets mega=true', () => {
    const r = parseTurnLine('m1+mega > Flamethrower > o2 > 45', ctx, 3);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.mega).toBe(true);
    expect(r.actions[0]!.move).toBe('Flamethrower');
  });

  test('opp action with explicit % → targetRemainingHpPercent', () => {
    // `41%` explicit suffix forces percent interpretation regardless of side.
    const r = parseTurnLine('o2 > Sucker Punch > m1 > 41%', ctx, 2);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.side).toBe('theirs');
    expect(r.actions[0]!.move).toBe('Sucker Punch');
    expect(r.actions[0]!.targetRemainingHpPercent).toBe(41);
  });

  test('opp action with bare number on mine target → raw HP remaining', () => {
    const r = parseTurnLine('o2 > Sucker Punch > m1 > 145', ctx, 2);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.side).toBe('theirs');
    expect(r.actions[0]!.targetRemainingHpRaw).toBe(145);
    expect(r.actions[0]!.targetRemainingHpPercent).toBeUndefined();
  });

  test('explicit "80 raw" still means damage-dealt in raw HP', () => {
    const r = parseTurnLine('m1 > Close Combat > o1 > 80 raw', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.damageRaw).toBe(80);
    expect(r.actions[0]!.targetRemainingHpPercent).toBeUndefined();
  });

  test('switch to a species name resolves the teamIndex', () => {
    const r = parseTurnLine('m1 > switch > Kingambit', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.kind).toBe('switch');
    expect(r.actions[0]!.move).toBe('switch');
    expect(r.actions[0]!.targetTeamIndex).toBe(2);
  });

  test('switch using my3 teamRef syntax', () => {
    const r = parseTurnLine('m1 > switch > my2', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.targetTeamIndex).toBe(1);
  });

  test('opp switch using op2 teamRef syntax', () => {
    const r = parseTurnLine('o1 > switch > op3', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.side).toBe('theirs');
    expect(r.actions[0]!.targetTeamIndex).toBe(2);
  });

  test('status move with self target — no damage required', () => {
    const r = parseTurnLine('m1 > Protect > self', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.move).toBe('Protect');
    expect(r.actions[0]!.target).toBe('self');
    expect(r.actions[0]!.damageHpPercent).toBeUndefined();
  });

  test('spread target parses as foes', () => {
    const r = parseTurnLine('m1 > Heat Wave > spread', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.target).toBe('foes');
  });

  test('bad actor returns helpful error', () => {
    const r = parseTurnLine('p1 > Tackle > o1', ctx, 1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/bad actor/);
  });

  test('switch to unknown species returns error', () => {
    const r = parseTurnLine('m1 > switch > Bulbasaur', ctx, 1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/couldn't resolve/);
  });

  test('raw damage suffix parses', () => {
    const r = parseTurnLine('m1 > Close Combat > o1 > 132 raw', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.damageRaw).toBe(132);
    expect(r.actions[0]!.damageHpPercent).toBeUndefined();
  });
});

describe('parseTurnLine — state updates', () => {
  test('o3 = 45% sets HP on opp team index 2', () => {
    const r = parseTurnLine('o3 = 45%', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'state') return;
    expect(r.update.side).toBe('theirs');
    expect(r.update.teamIndex).toBe(2);
    expect(r.update.hpPercent).toBe(45);
    expect(r.update.fainted).toBeUndefined();
  });

  test('m1 = 145 (bare on mine) → hpRaw', () => {
    const r = parseTurnLine('m1 = 145', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'state') return;
    expect(r.update.side).toBe('mine');
    expect(r.update.teamIndex).toBe(0);
    expect(r.update.hpRaw).toBe(145);
    expect(r.update.hpPercent).toBeUndefined();
  });

  test('m1 = 50% (explicit percent on mine) → hpPercent', () => {
    const r = parseTurnLine('m1 = 50%', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'state') return;
    expect(r.update.hpPercent).toBe(50);
    expect(r.update.hpRaw).toBeUndefined();
  });

  test('o2 ko marks fainted with hp=0', () => {
    const r = parseTurnLine('o2 ko', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'state') return;
    expect(r.update.side).toBe('theirs');
    expect(r.update.fainted).toBe(true);
    expect(r.update.hpPercent).toBe(0);
  });

  test('o2 fainted is the same as o2 ko', () => {
    const r = parseTurnLine('o2 fainted', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'state') return;
    expect(r.update.fainted).toBe(true);
  });

  test('o3 in o1 sets bringIntoSlot=0 with teamIndex=2', () => {
    const r = parseTurnLine('o3 in o1', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'state') return;
    expect(r.update.side).toBe('theirs');
    expect(r.update.teamIndex).toBe(2);
    expect(r.update.bringIntoSlot).toBe(0);
  });

  test('m4 in m2 sets bringIntoSlot=1 with teamIndex=3 for my side', () => {
    const r = parseTurnLine('m4 in m2', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'state') return;
    expect(r.update.side).toBe('mine');
    expect(r.update.teamIndex).toBe(3);
    expect(r.update.bringIntoSlot).toBe(1);
  });

  test('"X in Y" across sides errors', () => {
    const r = parseTurnLine('m3 in o1', ctx, 1);
    expect(r.ok).toBe(false);
  });

  test('o1 heal 25 → healPercent on opp', () => {
    const r = parseTurnLine('o1 heal 25', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'state') return;
    expect(r.update.side).toBe('theirs');
    expect(r.update.healPercent).toBe(25);
  });

  test('m1 heal 30 → healRaw on mine', () => {
    const r = parseTurnLine('m1 heal 30', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'state') return;
    expect(r.update.side).toBe('mine');
    expect(r.update.healRaw).toBe(30);
    expect(r.update.healPercent).toBeUndefined();
  });

  test('o1 sitrus → namedHeal:"sitrus"', () => {
    const r = parseTurnLine('o1 sitrus', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'state') return;
    expect(r.update.namedHeal).toBe('sitrus');
  });

  test('HP percent clamped to 0-100', () => {
    const r = parseTurnLine('o3 = 150', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'state') return;
    expect(r.update.hpPercent).toBe(100);
  });

  test('action lines still parse as kind=action (regression)', () => {
    const r = parseTurnLine('m1 > Close Combat > o1 > 67', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('action');
  });
});

describe('parseTurnLine — fainted-can\'t-act enforcement', () => {
  test('move action rejected when actor slot is empty (null)', () => {
    const emptyCtx: ParseContext = { ...ctx, myActiveTeamIndex: [null, 1] };
    const r = parseTurnLine('m1 > Close Combat > o1 > 67', emptyCtx, 1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/no active mon/);
  });

  test('move action rejected when actor mon is on opp side and fainted', () => {
    const fainted: OpponentEntry[] = [
      { ...opp[0]!, fainted: true },
      opp[1]!, opp[2]!,
    ];
    const oppCtx: ParseContext = { ...ctx, opponentTeam: fainted };
    const r = parseTurnLine('o1 > Knock Off > m1 > 50', oppCtx, 1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/fainted/);
  });

  test('move action rejected when actor mon is on my side and fainted', () => {
    const myFaintedCtx: ParseContext = { ...ctx, myFainted: [0] };
    const r = parseTurnLine('m1 > Close Combat > o1 > 67', myFaintedCtx, 1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/fainted/);
  });

  test('switch action allowed even when slot is empty (it fills the slot)', () => {
    const emptyCtx: ParseContext = { ...ctx, myActiveTeamIndex: [null, 1] };
    const r = parseTurnLine('m1 > switch > Kingambit', emptyCtx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.kind).toBe('switch');
  });

  test('state-update lines still work even with fainted/empty actors', () => {
    const emptyCtx: ParseContext = { ...ctx, myActiveTeamIndex: [null, 1] };
    // o3 = 45% uses direct team-index (3>2), doesn't need an active slot
    const r = parseTurnLine('o3 = 45%', emptyCtx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'state') return;
    expect(r.update.hpPercent).toBe(45);
  });
});

describe('parseTurnLine — new round (spread, boosts, damage, triggers, crit)', () => {
  test('spread move emits one action per target', () => {
    const r = parseTurnLine('m1 > Heat Wave > spread > o1:40, o2:35', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions).toHaveLength(2);
    expect(r.actions[0]!.targetRemainingHpPercent).toBe(40);
    expect(r.actions[1]!.targetRemainingHpPercent).toBe(35);
    expect(r.actions[0]!.order).toBe(r.actions[1]!.order);
    expect(r.actions[0]!.move).toBe('Heat Wave');
  });

  test('+crit modifier on actor sets critical:true', () => {
    const r = parseTurnLine('m1+crit > Close Combat > o1 > 30', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.critical).toBe(true);
    expect(r.actions[0]!.mega).toBeUndefined();
  });

  test('+mega+crit combines both modifiers', () => {
    const r = parseTurnLine('m1+mega+crit > Flamethrower > o1 > 0', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.critical).toBe(true);
    expect(r.actions[0]!.mega).toBe(true);
  });

  test('o1 +2 atk → boosts state with atk:2', () => {
    const r = parseTurnLine('o1 +2 atk', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'state') return;
    expect(r.update.boosts).toEqual({ atk: 2 });
  });

  test('multi-stat o1 +2 atk +2 spa → both', () => {
    const r = parseTurnLine('o1 +2 atk +2 spa', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'state') return;
    expect(r.update.boosts).toEqual({ atk: 2, spa: 2 });
  });

  test('negative boost m1 -1 def → def:-1', () => {
    const r = parseTurnLine('m1 -1 def', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'state') return;
    expect(r.update.boosts).toEqual({ def: -1 });
    expect(r.update.side).toBe('mine');
  });

  test('o1 damage 25 → damagePercent on opp', () => {
    const r = parseTurnLine('o1 damage 25', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'state') return;
    expect(r.update.damagePercent).toBe(25);
  });

  test('m1 damage 30 → damageRaw on mine', () => {
    const r = parseTurnLine('m1 damage 30', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'state') return;
    expect(r.update.damageRaw).toBe(30);
  });

  test('o1 wp → namedTrigger:"wp"', () => {
    const r = parseTurnLine('o1 wp', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'state') return;
    expect(r.update.namedTrigger).toBe('wp');
  });

  test('o1 sash / o1 balloon also parse as namedTrigger', () => {
    const a = parseTurnLine('o1 sash', ctx, 1);
    const b = parseTurnLine('o1 balloon', ctx, 1);
    expect(a.ok && a.kind === 'state' && a.update.namedTrigger).toBe('sash');
    expect(b.ok && b.kind === 'state' && b.update.namedTrigger).toBe('balloon');
  });
});

describe('parseTurnLine — standalone mega declaration', () => {
  test('"m1 mega" emits a kind:mega action on my side', () => {
    const r = parseTurnLine('m1 mega', ctx, 3);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    const a = r.actions[0]!;
    expect(a.side).toBe('mine');
    expect(a.attackerSlot).toBe(0);
    expect(a.kind).toBe('mega');
    expect(a.move).toBe('mega');
    expect(a.attackerTeamIndex).toBe(0);
    expect(a.target).toBe('self');
    expect(a.order).toBe(3);
  });

  test('"o2 mega" emits a kind:mega action on opp side', () => {
    const r = parseTurnLine('o2 mega', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    const a = r.actions[0]!;
    expect(a.side).toBe('theirs');
    expect(a.attackerSlot).toBe(1);
    expect(a.kind).toBe('mega');
  });

  test('"m1 mega" with an empty slot errors out', () => {
    const ctxEmpty: ParseContext = { ...ctx, myActiveTeamIndex: [null, null] };
    const r = parseTurnLine('m1 mega', ctxEmpty, 1);
    expect(r.ok).toBe(false);
  });
});

describe('parseTurnLine — non-damaging moves', () => {
  test('m1 > Gravity (no target) parses as a self-targeted action', () => {
    const r = parseTurnLine('m1 > Gravity', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.kind).toBe('move');
    expect(r.actions[0]!.move).toBe('Gravity');
    expect(r.actions[0]!.target).toBe('self');
    expect(r.actions[0]!.damageHpPercent).toBeUndefined();
    expect(r.actions[0]!.damageRaw).toBeUndefined();
  });

  test('o2 > Trick Room (no target) parses on opp side', () => {
    const r = parseTurnLine('o2 > Trick Room', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.side).toBe('theirs');
    expect(r.actions[0]!.move).toBe('Trick Room');
  });

  test('m1 > Will-O-Wisp > o1 (status move with target, no damage) parses', () => {
    const r = parseTurnLine('m1 > Will-O-Wisp > o1', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.move).toBe('Will-O-Wisp');
    expect(r.actions[0]!.targetTeamIndex).toBe(0);
    expect(r.actions[0]!.damageHpPercent).toBeUndefined();
    expect(r.actions[0]!.targetRemainingHpPercent).toBeUndefined();
  });
});

describe('parseTurnLine — bring restriction on mine switches', () => {
  // Brought 2 of 3 to this battle: Sneasler (idx 0) + Garchomp (idx 1).
  // Kingambit (idx 2) is on the team but NOT brought.
  const ctxBring: ParseContext = { ...ctx, myBring: [0, 1] };

  test('switch by species to a brought mon succeeds', () => {
    const r = parseTurnLine('m1 > switch > Garchomp', ctxBring, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.targetTeamIndex).toBe(1);
  });

  test('switch by species to an UNBROUGHT mon errors', () => {
    const r = parseTurnLine('m1 > switch > Kingambit', ctxBring, 1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('Kingambit');
    expect(r.error).toContain('brought');
  });

  test('switch by my-team-ref my3 to an unbrought slot errors', () => {
    const r = parseTurnLine('m1 > switch > my3', ctxBring, 1);
    expect(r.ok).toBe(false);
  });

  test('"m3 in m1" state update to an unbrought slot errors', () => {
    const r = parseTurnLine('m3 in m1', ctxBring, 1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('brought');
  });

  test('"m2 in m1" state update to a brought slot succeeds', () => {
    const r = parseTurnLine('m2 in m1', ctxBring, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'state') return;
    expect(r.update.bringIntoSlot).toBe(0);
    expect(r.update.teamIndex).toBe(1);
  });

  test('opp side is unaffected by myBring (opps switch from full team)', () => {
    const r = parseTurnLine('o1 > switch > op3', ctxBring, 1);
    expect(r.ok).toBe(true);
  });

  test('without myBring the parser falls back to the full team (legacy/replay)', () => {
    const r = parseTurnLine('m1 > switch > Kingambit', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    expect(r.actions[0]!.targetTeamIndex).toBe(2);
  });
});
