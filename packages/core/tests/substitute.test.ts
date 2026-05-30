// Substitute: the move costs 25% HP, creates a sub that absorbs incoming
// damage. Status moves blocked. Leech Seed blocked. Sound moves bypass.
// Inference skipped when sub absorbed the hit. Sub clears on switch-out.
import { describe, test, expect } from 'vitest';
import { finalizeTurn, type ActiveIdx } from '../src/match/engine.js';
import type { Match, MoveAction } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function baseMatch(): Match {
  return {
    id: 't', startedAt: '',
    myTeam: [
      { species: 'Clefable', level: 50, nature: 'Bold', evs: ZERO_EVS, ivs: MAX_IVS, ability: 'Magic Guard', moves: ['Moonblast', 'Substitute', 'Soft-Boiled'] },
    ],
    opponentTeam: [
      { species: 'Gengar', knownMoves: ['Substitute', 'Will-O-Wisp', 'Shadow Ball'], currentHpPercent: 100 },
    ],
    bring: [0, 1, 2, 3],
    opponentBrought: [0],
    turns: [],
    field: NEUTRAL_FIELD,
    active: { mine: [null, null], theirs: [null, null] },
    myCurrentHp: { 0: 100 },
  };
}

const active: ActiveIdx = { mine: [0, null], theirs: [0, null] };

// ─── Substitute creation ──────────────────────────────────────────────────────

describe('Substitute — creation', () => {
  test('mine: Substitute move deducts 25% HP and creates sub at 25%', () => {
    const m = baseMatch();
    const action: MoveAction = {
      kind: 'move', side: 'mine', move: 'Substitute',
      attackerSlot: 0, attackerTeamIndex: 0,
      target: 'self',
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.myCurrentHp![0]).toBe(75);
    expect(r.match.myCurrentSub![0]).toBe(25);
  });

  test('opp: Substitute move deducts 25% and sets substitute', () => {
    const m = baseMatch();
    const action: MoveAction = {
      kind: 'move', side: 'theirs', move: 'Substitute',
      attackerSlot: 0, attackerTeamIndex: 0,
      target: 'self',
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.opponentTeam[0]!.currentHpPercent).toBe(75);
    expect(r.match.opponentTeam[0]!.substitute).toBe(25);
  });

  test('Substitute fails when HP ≤ 25%', () => {
    const m = baseMatch();
    m.myCurrentHp![0] = 25;
    const action: MoveAction = {
      kind: 'move', side: 'mine', move: 'Substitute',
      attackerSlot: 0, attackerTeamIndex: 0,
      target: 'self',
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.myCurrentHp![0]).toBe(25); // no change
    expect(r.match.myCurrentSub?.[0]).toBeUndefined();
  });
});

// ─── Damage absorption ────────────────────────────────────────────────────────

describe('Substitute — damage absorption', () => {
  test('damage to opp sub reduces sub HP, not real mon HP', () => {
    const m = baseMatch();
    m.opponentTeam[0]!.substitute = 25;
    const action: MoveAction = {
      kind: 'move', side: 'mine', move: 'Moonblast',
      attackerSlot: 0, attackerTeamIndex: 0,
      target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      damageHpPercent: 15,
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.opponentTeam[0]!.currentHpPercent).toBe(100); // real HP unchanged
    expect(r.match.opponentTeam[0]!.substitute).toBe(10); // sub took the hit
  });

  test('overkill on sub: sub breaks (cleared), real mon survives', () => {
    const m = baseMatch();
    m.opponentTeam[0]!.substitute = 10;
    const action: MoveAction = {
      kind: 'move', side: 'mine', move: 'Moonblast',
      attackerSlot: 0, attackerTeamIndex: 0,
      target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      damageHpPercent: 40,
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.opponentTeam[0]!.currentHpPercent).toBe(100); // real HP unchanged
    expect(r.match.opponentTeam[0]!.substitute).toBeUndefined(); // sub broken
    expect(r.match.opponentTeam[0]!.fainted).toBeFalsy();
  });

  test('my sub absorbs opp hit: real HP unchanged', () => {
    const m = baseMatch();
    m.myCurrentSub = { 0: 25 };
    m.myCurrentHp![0] = 75;
    const action: MoveAction = {
      kind: 'move', side: 'theirs', move: 'Shadow Ball',
      attackerSlot: 0, attackerTeamIndex: 0,
      target: { side: 'mine', slot: 0 }, targetTeamIndex: 0,
      damageHpPercent: 20,
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.myCurrentHp![0]).toBe(75); // real HP unchanged
    expect(r.match.myCurrentSub![0]).toBe(5); // sub took the hit
  });

  test('sound move bypasses sub and hits real mon', () => {
    const m = baseMatch();
    m.opponentTeam[0]!.substitute = 25;
    const action: MoveAction = {
      kind: 'move', side: 'mine', move: 'Hyper Voice',
      attackerSlot: 0, attackerTeamIndex: 0,
      target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      damageHpPercent: 30,
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    // Real mon takes the hit; sub remains at 25%
    expect(r.match.opponentTeam[0]!.currentHpPercent).toBe(70);
    expect(r.match.opponentTeam[0]!.substitute).toBe(25);
  });
});

// ─── Inference skip ───────────────────────────────────────────────────────────

describe('Substitute — inference skip', () => {
  test('hit to subbed opp is skipped for inference (candidates unchanged)', () => {
    const m = baseMatch();
    // Give the opp a prior candidate set
    m.opponentTeam[0]!.candidates = [{
      species: 'Gengar', level: 50, nature: 'Timid', evs: ZERO_EVS, ivs: MAX_IVS, moves: [],
    }];
    m.opponentTeam[0]!.substitute = 25;
    const action: MoveAction = {
      kind: 'move', side: 'mine', move: 'Moonblast',
      attackerSlot: 0, attackerTeamIndex: 0,
      target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      damageHpPercent: 20,
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    // Candidates should stay exactly one entry (inference skipped)
    expect(r.match.opponentTeam[0]!.candidates).toHaveLength(1);
  });
});

// ─── Status and Leech Seed blocked ───────────────────────────────────────────

describe('Substitute — blocks status + Leech Seed', () => {
  test('Will-O-Wisp does not burn a subbed opp', () => {
    const m = baseMatch();
    m.opponentTeam[0]!.substitute = 25;
    const action: MoveAction = {
      kind: 'move', side: 'mine', move: 'Will-O-Wisp',
      attackerSlot: 0, attackerTeamIndex: 0,
      target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.opponentTeam[0]!.status).toBeUndefined();
  });

  test('Toxic does not poison my subbed mon', () => {
    const m = baseMatch();
    m.myCurrentSub = { 0: 25 };
    const action: MoveAction = {
      kind: 'move', side: 'theirs', move: 'Toxic',
      attackerSlot: 0, attackerTeamIndex: 0,
      target: { side: 'mine', slot: 0 }, targetTeamIndex: 0,
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.myStatus?.[0]).toBeUndefined();
  });

  test('Leech Seed does not seed a subbed opp', () => {
    const m = baseMatch();
    m.opponentTeam[0]!.substitute = 25;
    const action: MoveAction = {
      kind: 'move', side: 'mine', move: 'Leech Seed',
      attackerSlot: 0, attackerTeamIndex: 0,
      target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.opponentTeam[0]!.leechSeeded).toBeUndefined();
  });
});

// ─── Sub clears on switch-out ─────────────────────────────────────────────────

describe('Substitute — clears on switch-out', () => {
  test('opp sub cleared when opp switches out', () => {
    const m = baseMatch();
    m.opponentTeam = [
      { species: 'Gengar', knownMoves: [], currentHpPercent: 75, substitute: 25 },
      { species: 'Garchomp', knownMoves: [], currentHpPercent: 100 },
    ];
    m.opponentBrought = [0, 1];
    const switchAction: MoveAction = {
      kind: 'switch', side: 'theirs',
      attackerSlot: 0, attackerTeamIndex: 0,
      targetTeamIndex: 1,
      move: 'Garchomp',
      target: { side: 'theirs', slot: 0 },
    };
    const r = finalizeTurn({ match: m, turn: { actions: [switchAction], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.opponentTeam[0]!.substitute).toBeUndefined(); // cleared
  });
});
