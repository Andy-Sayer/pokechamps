// Magic Bounce: status-category moves and Leech Seed are reflected off the
// holder. Status is NOT applied; Leech Seed volatile is NOT set. Opp
// conservatism: only blocks when the ability is certain (observed or
// single-ability species).
import { describe, test, expect } from 'vitest';
import { finalizeTurn } from '../src/match/engine.js';
import type { Match, MoveAction } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function baseMatch(): Match {
  return {
    id: 't', startedAt: '',
    myTeam: [
      { species: 'Espeon', level: 50, nature: 'Timid', evs: ZERO_EVS, ivs: MAX_IVS, ability: 'Magic Bounce', moves: ['Dazzling Gleam'] },
      { species: 'Clefable', level: 50, nature: 'Bold', evs: ZERO_EVS, ivs: MAX_IVS, ability: 'Magic Guard', moves: ['Moonblast'] },
    ],
    opponentTeam: [
      { species: 'Xatu', knownMoves: ['Will-O-Wisp'], ability: 'Magic Bounce', currentHpPercent: 100 },
      { species: 'Gengar', knownMoves: ['Leech Seed'], currentHpPercent: 100 },
    ],
    bring: [0, 1, 2, 3],
    opponentBrought: [0, 1],
    turns: [],
    field: NEUTRAL_FIELD,
    active: { mine: [null, null], theirs: [null, null] },
    myCurrentHp: { 0: 100, 1: 100 },
  };
}

const active = {
  mine: [0, 1] as [number | null, number | null],
  theirs: [0, 1] as [number | null, number | null],
};

// ─── Status moves blocked ─────────────────────────────────────────────────────

describe('Magic Bounce — status moves', () => {
  test('Will-O-Wisp vs opp Magic Bounce (known) → no burn', () => {
    const m = baseMatch();
    // m1 uses Will-O-Wisp targeting o1 (Xatu, Magic Bounce ability set)
    const action: MoveAction = {
      kind: 'move', side: 'mine', move: 'Will-O-Wisp',
      attackerSlot: 0, attackerTeamIndex: 0,
      target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.opponentTeam[0]!.status).toBeUndefined();
  });

  test('Will-O-Wisp vs opp without Magic Bounce → burn applied', () => {
    const m = baseMatch();
    // Target Gengar (no magic bounce)
    const action: MoveAction = {
      kind: 'move', side: 'mine', move: 'Will-O-Wisp',
      attackerSlot: 0, attackerTeamIndex: 0,
      target: { side: 'theirs', slot: 1 }, targetTeamIndex: 1,
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.opponentTeam[1]!.status).toBe('brn');
  });

  test('Toxic vs my Magic Bounce → no poison', () => {
    const m = baseMatch();
    // o1 uses Toxic targeting m1 (Espeon, Magic Bounce)
    const action: MoveAction = {
      kind: 'move', side: 'theirs', move: 'Toxic',
      attackerSlot: 0, attackerTeamIndex: 0,
      target: { side: 'mine', slot: 0 }, targetTeamIndex: 0,
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.myStatus?.[0]).toBeUndefined();
  });

  test('Toxic vs my mon without Magic Bounce → tox applied', () => {
    const m = baseMatch();
    // o1 Toxic targeting m2 (Clefable, no Magic Bounce)
    const action: MoveAction = {
      kind: 'move', side: 'theirs', move: 'Toxic',
      attackerSlot: 0, attackerTeamIndex: 0,
      target: { side: 'mine', slot: 1 }, targetTeamIndex: 1,
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.myStatus?.[1]).toBe('tox');
  });

  test('opp Magic Bounce unknown (ability not observed, multi-ability species) → status lands', () => {
    // Gardevoir has 3 abilities → not certain → conservatism → status applies
    const m = baseMatch();
    m.opponentTeam[0] = { species: 'Gardevoir', knownMoves: [], currentHpPercent: 100 };
    const action: MoveAction = {
      kind: 'move', side: 'mine', move: 'Will-O-Wisp',
      attackerSlot: 0, attackerTeamIndex: 0,
      target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    // Gardevoir is NOT Fire-type, so burn type immunity doesn't block it either.
    // Without certain Magic Bounce, burn goes through.
    expect(r.match.opponentTeam[0]!.status).toBe('brn');
  });
});

// ─── Leech Seed blocked ───────────────────────────────────────────────────────

describe('Magic Bounce — Leech Seed', () => {
  test('Leech Seed vs opp Magic Bounce → not seeded', () => {
    const m = baseMatch();
    const action: MoveAction = {
      kind: 'move', side: 'mine', move: 'Leech Seed',
      attackerSlot: 0, attackerTeamIndex: 0,
      target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.opponentTeam[0]!.leechSeeded).toBeUndefined();
  });

  test('Leech Seed vs opp without Magic Bounce → seeded', () => {
    const m = baseMatch();
    const action: MoveAction = {
      kind: 'move', side: 'mine', move: 'Leech Seed',
      attackerSlot: 0, attackerTeamIndex: 0,
      target: { side: 'theirs', slot: 1 }, targetTeamIndex: 1,
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.opponentTeam[1]!.leechSeeded).toBeDefined();
  });

  test('Leech Seed vs my Magic Bounce → not seeded', () => {
    const m = baseMatch();
    // o2 uses Leech Seed targeting m1 (Espeon, Magic Bounce)
    const action: MoveAction = {
      kind: 'move', side: 'theirs', move: 'Leech Seed',
      attackerSlot: 1, attackerTeamIndex: 1,
      target: { side: 'mine', slot: 0 }, targetTeamIndex: 0,
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.myLeechSeeded?.[0]).toBeUndefined();
  });

  test('Leech Seed vs my non-Magic-Bounce mon → seeded', () => {
    const m = baseMatch();
    // o2 targets m2 (Clefable, Magic Guard not Magic Bounce)
    const action: MoveAction = {
      kind: 'move', side: 'theirs', move: 'Leech Seed',
      attackerSlot: 1, attackerTeamIndex: 1,
      target: { side: 'mine', slot: 1 }, targetTeamIndex: 1,
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.myLeechSeeded?.[1]).toBeDefined();
  });
});
