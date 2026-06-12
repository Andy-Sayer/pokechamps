// Perish Song: a logged cast auto-sets the clock (4 → ticks to 3 the same
// turn, the in-game display) on every on-field non-Soundproof mon; each EOT
// decrements; at 0 the mon faints; switching out CLEARS the count (real rules
// — Baton Pass should carry it, which auto-tracking can't see). Trapping
// moves (Block / Mean Look …) pin the target via `trappedBy`, lazily
// validated. Manual `perish N` logs override and skip that turn's auto-tick.
import { describe, test, expect } from 'vitest';
import { parseTurnLine, type ParseContext } from '../src/domain/turnparser.js';
import { endOfTurn } from '../src/domain/endOfTurn.js';
import { finalizeTurn } from '../src/match/engine.js';
import type { Match, MoveAction, PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}

const ctx: ParseContext = {
  myTeam: [mon({ species: 'Clefable', moves: ['Moonblast'] })],
  opponentTeam: [{ species: 'Gengar', knownMoves: ['Perish Song'] }],
  myActiveTeamIndex: [0, null],
  theirActiveTeamIndex: [0, null],
};

// ─── Parser ──────────────────────────────────────────────────────────────────

describe('Perish Song parser', () => {
  test('"o1 perish" → perishCount 3 (default)', () => {
    const r = parseTurnLine('o1 perish', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'state') throw new Error('expected state');
    expect(r.update.perish).toBe(3);
  });

  test('"o1 perish 2" → perishCount 2', () => {
    const r = parseTurnLine('o1 perish 2', ctx, 1);
    if (!r.ok || r.kind !== 'state') throw new Error('expected state');
    expect(r.update.perish).toBe(2);
  });

  test('"m1 perish 1" → mine side perish 1', () => {
    const r = parseTurnLine('m1 perish 1', ctx, 1);
    if (!r.ok || r.kind !== 'state') throw new Error('expected state');
    expect(r.update.side).toBe('mine');
    expect(r.update.perish).toBe(1);
  });
});

// ─── EOT countdown ────────────────────────────────────────────────────────────

function freshMatch(oppPerish?: number, myPerish?: number): Match {
  const opp: OpponentEntry = { species: 'Gengar', knownMoves: [], currentHpPercent: 100, perishCount: oppPerish };
  return {
    id: 't', startedAt: '',
    myTeam: [mon({ species: 'Clefable', moves: ['Moonblast'] })],
    opponentTeam: [opp, { species: 'Garchomp', knownMoves: [] }],
    bring: [0, 1, 2, 3], opponentBrought: [0], turns: [], field: NEUTRAL_FIELD,
    active: { mine: [null, null], theirs: [null, null] },
    myCurrentHp: { 0: 100 },
    myPerishCount: myPerish != null ? { 0: myPerish } : undefined,
  };
}

const active = { mine: [0, null] as [number | null, number | null], theirs: [0, null] as [number | null, number | null] };

describe('Perish Song EOT countdown', () => {
  test('counter decrements each EOT: 3 → 2', () => {
    const m = freshMatch(3);
    const r = endOfTurn(m, NEUTRAL_FIELD, active);
    expect(r.match.opponentTeam[0]!.perishCount).toBe(2);
    expect(r.match.opponentTeam[0]!.fainted).toBeFalsy();
  });

  test('counter 2 → 1', () => {
    const r = endOfTurn(freshMatch(2), NEUTRAL_FIELD, active);
    expect(r.match.opponentTeam[0]!.perishCount).toBe(1);
  });

  test('counter 1 → 0 → faint', () => {
    const m = freshMatch(1);
    const r = endOfTurn(m, NEUTRAL_FIELD, active);
    expect(r.match.opponentTeam[0]!.perishCount).toBe(0);
    expect(r.match.opponentTeam[0]!.fainted).toBe(true);
    expect(r.match.opponentTeam[0]!.currentHpPercent).toBe(0);
    expect(r.notes.some(n => n.includes('Perish Song'))).toBe(true);
  });

  test('no perishCount — no effect', () => {
    const m = freshMatch(undefined);
    const r = endOfTurn(m, NEUTRAL_FIELD, active);
    expect(r.match.opponentTeam[0]!.fainted).toBeFalsy();
  });

  test('my-side perish countdown: 3 → 2', () => {
    const m = freshMatch(undefined, 3);
    const r = endOfTurn(m, NEUTRAL_FIELD, active);
    expect(r.match.myPerishCount?.[0]).toBe(2);
    expect(r.match.myFainted).not.toContain(0);
  });

  test('my-side perish 1 → faint', () => {
    const m = freshMatch(undefined, 1);
    const r = endOfTurn(m, NEUTRAL_FIELD, active);
    expect(r.match.myPerishCount?.[0]).toBe(0);
    expect(r.match.myFainted).toContain(0);
    expect(r.notes.some(n => n.includes('Perish Song'))).toBe(true);
  });
});

// ─── Engine: cast auto-set, switch-clear, trap volatile, manual override ──────

function fullMatch(over: Partial<Match> = {}): Match {
  return {
    id: 't', startedAt: '',
    myTeam: [
      mon({ species: 'Politoed', ability: 'Drizzle', moves: ['Perish Song', 'Protect', 'Surf', 'Icy Wind'] }),
      mon({ species: 'Steelix', ability: 'Sturdy', moves: ['Block', 'Iron Head', 'Protect', 'Earthquake'] }),
      mon({ species: 'Clefable', ability: 'Magic Guard', moves: ['Moonblast'] }),
      mon({ species: 'Talonflame', ability: 'Gale Wings', moves: ['Brave Bird'] }),
    ],
    opponentTeam: [
      { species: 'Garchomp', knownMoves: [], currentHpPercent: 100 },
      { species: 'Annihilape', knownMoves: [], currentHpPercent: 100 },
      { species: 'Gengar', knownMoves: [], currentHpPercent: 100 },
    ],
    bring: [0, 1, 2, 3], opponentBrought: [0, 1, 2], turns: [], field: NEUTRAL_FIELD,
    active: { mine: [0, 1], theirs: [0, 1] },
    myCurrentHp: { 0: 100, 1: 100, 2: 100, 3: 100 },
    ...over,
  } as Match;
}
const act = (p: Partial<MoveAction> & { side: 'mine' | 'theirs'; move: string }): MoveAction => ({
  attackerSlot: 0, kind: 'move', target: 'foes', ...p,
} as MoveAction);
const ACTIVE = { mine: [0, 1] as [number | null, number | null], theirs: [0, 1] as [number | null, number | null] };

describe('Perish Song engine bookkeeping', () => {
  test('logged cast sets the clock on all four actives (3 after the same-turn tick)', () => {
    const r = finalizeTurn({
      match: fullMatch(),
      turn: { actions: [act({ side: 'mine', move: 'Perish Song', attackerTeamIndex: 0 })], field: NEUTRAL_FIELD },
      activeIdx: ACTIVE,
    });
    expect(r.match.myPerishCount?.[0]).toBe(3);
    expect(r.match.myPerishCount?.[1]).toBe(3);
    expect(r.match.opponentTeam[0]!.perishCount).toBe(3);
    expect(r.match.opponentTeam[1]!.perishCount).toBe(3);
  });

  test('switching out clears the count; the staying mon keeps ticking', () => {
    const m = fullMatch({ myPerishCount: { 0: 3, 1: 3 } });
    const r = finalizeTurn({
      match: m,
      turn: { actions: [{ side: 'mine', attackerSlot: 0, kind: 'switch', move: 'Clefable', target: 'self', targetTeamIndex: 2 } as MoveAction], field: NEUTRAL_FIELD },
      activeIdx: ACTIVE,
    });
    expect(r.match.myPerishCount?.[0]).toBeUndefined();  // escaped — cleared
    expect(r.match.myPerishCount?.[2]).toBeUndefined();  // fresh switch-in: no clock
    expect(r.match.myPerishCount?.[1]).toBe(2);          // stayed — ticked
  });

  test('manual `perish N` log this turn skips the auto-tick', () => {
    const m = fullMatch({ myPerishCount: { 1: 2 } });
    const r = finalizeTurn({
      match: m,
      turn: { actions: [], field: NEUTRAL_FIELD },
      activeIdx: ACTIVE,
      skipPerishTick: new Set(['m:1']),
    });
    expect(r.match.myPerishCount?.[1]).toBe(2);          // logged value preserved
  });

  test('count 1 faints at EOT', () => {
    const m = fullMatch({ myPerishCount: { 1: 1 } });
    const r = finalizeTurn({ match: m, turn: { actions: [], field: NEUTRAL_FIELD }, activeIdx: ACTIVE });
    expect(r.match.myFainted).toContain(1);
  });
});

describe('trapping move volatile', () => {
  test('Block pins the target (trappedBy = my team index)', () => {
    const r = finalizeTurn({
      match: fullMatch(),
      turn: {
        actions: [act({ side: 'mine', move: 'Block', attackerSlot: 1, attackerTeamIndex: 1, target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0 })],
        field: NEUTRAL_FIELD,
      },
      activeIdx: ACTIVE,
    });
    expect(r.match.opponentTeam[0]!.trappedBy).toBe(1);
  });

  test('Ghost targets are immune to trapping moves', () => {
    const m = fullMatch({ active: { mine: [0, 1], theirs: [2, 1] } });
    const r = finalizeTurn({
      match: m,
      turn: {
        actions: [act({ side: 'mine', move: 'Mean Look', attackerSlot: 0, attackerTeamIndex: 0, target: { side: 'theirs', slot: 0 }, targetTeamIndex: 2 })],
        field: NEUTRAL_FIELD,
      },
      activeIdx: { mine: [0, 1], theirs: [2, 1] },
    });
    expect(r.match.opponentTeam[2]!.trappedBy).toBeUndefined();   // Gengar is Ghost
  });

  test('the pinned mon switching out drops its trap record', () => {
    const m = fullMatch();
    m.opponentTeam[0]!.trappedBy = 1;
    const r = finalizeTurn({
      match: m,
      turn: { actions: [{ side: 'theirs', attackerSlot: 0, kind: 'switch', move: 'Gengar', target: 'self', targetTeamIndex: 2 } as MoveAction], field: NEUTRAL_FIELD },
      activeIdx: ACTIVE,
    });
    expect(r.match.opponentTeam[0]!.trappedBy).toBeUndefined();
  });
});
