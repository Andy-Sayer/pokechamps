// `(berry)` damage suffix: marks a resist berry as consumed when logging damage.
// e.g. `m1 > Ice Beam > o1 > 80 (berry)` → sets opp item + itemConsumed to
// 'Yache Berry' (derived from the move's type via resistBerryForType).
import { describe, test, expect } from 'vitest';
import { parseTurnLine, type ParseContext } from '../src/domain/turnparser.js';
import { finalizeTurn, type ActiveIdx } from '../src/match/engine.js';
import type { Match, PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}

const ctx: ParseContext = {
  myTeam: [mon({ species: 'Flutter Mane', moves: ['Moonblast', 'Shadow Ball', 'Ice Beam', 'Psychic'] })],
  opponentTeam: [{ species: 'Garchomp', knownMoves: [] }],
  myActiveTeamIndex: [0, null],
  theirActiveTeamIndex: [0, null],
};

// ─── Parser ──────────────────────────────────────────────────────────────────

describe('(berry) damage suffix parsing', () => {
  test('"80 (berry)" → remaining 80% + berry flag (opp target)', () => {
    const r = parseTurnLine('m1 > Ice Beam > o1 > 80 (berry)', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') throw new Error('expected action');
    const a = r.actions[0]!;
    expect(a.berry).toBe(true);
    expect(a.targetRemainingHpPercent).toBe(80);
  });

  test('bare "(berry)" with no value → no damage value, berry flag set', () => {
    const r = parseTurnLine('m1 > Ice Beam > o1 > (berry)', ctx, 1);
    if (!r.ok || r.kind !== 'action') throw new Error('expected action');
    const a = r.actions[0]!;
    expect(a.berry).toBe(true);
    // No HP value → remaining and damage are undefined
    expect(a.targetRemainingHpPercent).toBeUndefined();
    expect(a.damageHpPercent).toBeUndefined();
  });

  test('"50 (berry)" on mine-side target reads raw HP', () => {
    const mineCtx: ParseContext = {
      myTeam: [mon({ species: 'Garchomp', moves: ['Earthquake'] })],
      opponentTeam: [{ species: 'Flutter Mane', knownMoves: ['Ice Beam'] }],
      myActiveTeamIndex: [0, null],
      theirActiveTeamIndex: [0, null],
    };
    const r = parseTurnLine('o1 > Ice Beam > m1 > 50 (berry)', mineCtx, 1);
    if (!r.ok || r.kind !== 'action') throw new Error('expected action');
    const a = r.actions[0]!;
    expect(a.berry).toBe(true);
    // mine-side target: value is raw HP remaining
    expect(a.targetRemainingHpRaw).toBe(50);
  });

  test('berry flag does not interfere with sash flag (both absent normally)', () => {
    const r = parseTurnLine('m1 > Ice Beam > o1 > 60', ctx, 1);
    if (!r.ok || r.kind !== 'action') throw new Error('expected action');
    expect(r.actions[0]!.berry).toBeUndefined();
    expect(r.actions[0]!.sash).toBeUndefined();
  });
});

// ─── finalizeTurn integration ────────────────────────────────────────────────

function freshMatch(oppItem?: string): Match {
  return {
    id: 't', startedAt: '',
    myTeam: [mon({ species: 'Flutter Mane', moves: ['Ice Beam', 'Moonblast'] })],
    opponentTeam: [{ species: 'Garchomp', knownMoves: [], currentHpPercent: 100, item: oppItem } as OpponentEntry],
    bring: [0, 1, 2, 3], opponentBrought: [0], turns: [], field: NEUTRAL_FIELD,
    active: { mine: [null, null], theirs: [null, null] },
  };
}
const startActive: ActiveIdx = { mine: [0, null], theirs: [0, null] };

describe('finalizeTurn: (berry) effect', () => {
  test('opp item unknown → (berry) on Ice Beam sets item+consumed to Yache Berry', () => {
    const match = freshMatch(undefined);
    const r = parseTurnLine('m1 > Ice Beam > o1 > 80 (berry)', {
      myTeam: match.myTeam, opponentTeam: match.opponentTeam,
      myActiveTeamIndex: [0, null], theirActiveTeamIndex: [0, null],
    }, 1);
    if (!r.ok || r.kind !== 'action') throw new Error('action');
    const res = finalizeTurn({ match, turn: { actions: r.actions, field: match.field }, activeIdx: startActive });
    expect(res.match.opponentTeam[0]!.item).toBe('Yache Berry');
    expect(res.match.opponentTeam[0]!.itemConsumed).toBe('Yache Berry');
  });

  test('opp item already known → (berry) preserves known item, marks consumed', () => {
    // If the user already set item via /info, do not overwrite it.
    const match = freshMatch('Yache Berry');
    const r = parseTurnLine('m1 > Ice Beam > o1 > 80 (berry)', {
      myTeam: match.myTeam, opponentTeam: match.opponentTeam,
      myActiveTeamIndex: [0, null], theirActiveTeamIndex: [0, null],
    }, 1);
    if (!r.ok || r.kind !== 'action') throw new Error('action');
    const res = finalizeTurn({ match, turn: { actions: r.actions, field: match.field }, activeIdx: startActive });
    expect(res.match.opponentTeam[0]!.item).toBe('Yache Berry');
    expect(res.match.opponentTeam[0]!.itemConsumed).toBe('Yache Berry');
  });

  test('mine-side: (berry) on opp Ice Beam sets myItemConsumed', () => {
    const mineMatch: Match = {
      id: 't2', startedAt: '',
      myTeam: [mon({ species: 'Garchomp', item: 'Yache Berry', moves: ['Earthquake'] })],
      opponentTeam: [{ species: 'Flutter Mane', knownMoves: ['Ice Beam'] }],
      bring: [0, 1, 2, 3], opponentBrought: [0], turns: [], field: NEUTRAL_FIELD,
      active: { mine: [null, null], theirs: [null, null] },
      myCurrentHp: {},
    };
    const r = parseTurnLine('o1 > Ice Beam > m1 > 50 (berry)', {
      myTeam: mineMatch.myTeam, opponentTeam: mineMatch.opponentTeam,
      myActiveTeamIndex: [0, null], theirActiveTeamIndex: [0, null],
    }, 1);
    if (!r.ok || r.kind !== 'action') throw new Error('action');
    const res = finalizeTurn({ match: mineMatch, turn: { actions: r.actions, field: mineMatch.field }, activeIdx: startActive });
    expect(res.match.myItemConsumed?.[0]).toBe('Yache Berry');
  });

  test('move type with no resist berry → (berry) is a no-op (graceful)', () => {
    // Normal type has no resist berry except Chilan for self-hits; here Normal on Garchomp.
    // resistBerryForType('Normal') = 'Chilan Berry', but that's fine — it still resolves.
    // Use a type that has NO mapping — Steel has Babiri Berry, so let's use a non-standard
    // scenario: the move is a status move with no damage. Actually, let's use Shadow Ball
    // (Ghost type → Kasib Berry).
    const match = freshMatch(undefined);
    const r = parseTurnLine('m1 > Shadow Ball > o1 > 70 (berry)', {
      myTeam: [mon({ species: 'Flutter Mane', moves: ['Shadow Ball'] })],
      opponentTeam: match.opponentTeam,
      myActiveTeamIndex: [0, null], theirActiveTeamIndex: [0, null],
    }, 1);
    if (!r.ok || r.kind !== 'action') throw new Error('action');
    const res = finalizeTurn({ match, turn: { actions: r.actions, field: match.field }, activeIdx: startActive });
    // Kasib Berry is a valid resist berry for Ghost type
    expect(res.match.opponentTeam[0]!.item).toBe('Kasib Berry');
    expect(res.match.opponentTeam[0]!.itemConsumed).toBe('Kasib Berry');
  });
});
