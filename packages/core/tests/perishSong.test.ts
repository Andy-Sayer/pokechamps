// Perish Song: all active mons get a countdown of 3; each EOT decrements the
// counter; at 0 the mon faints. Counter persists through switch (does NOT clear
// on switch-out). Shadow Tag (Mega Gengar) prevents non-Ghost types from
// switching, but that trap logic is display/search-side — this test covers the
// state tracking and EOT countdown.
import { describe, test, expect } from 'vitest';
import { parseTurnLine, type ParseContext } from '../src/domain/turnparser.js';
import { endOfTurn } from '../src/domain/endOfTurn.js';
import type { Match, PokemonSet, OpponentEntry } from '../src/domain/types.js';
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
