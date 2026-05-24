// Multi-hit damage input: "o1 > Beat Up > o1 > 99,98,97,96,90(crit)".
// Comma values = successive remaining HP per hit (side-aware unit), optional
// (crit) per hit. Parser emits one action per hit; finalizeTurn converts each
// to its own damage delta.
import { describe, test, expect } from 'vitest';
import { parseTurnLine, type ParseContext } from '../src/domain/turnparser.js';
import { finalizeTurn, type ActiveIdx } from '../src/match/engine.js';
import type { Match, PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}

const ctx: ParseContext = {
  myTeam: [mon({ species: 'Sneasler', moves: ['Beat Up'] })],
  opponentTeam: [{ species: 'Garchomp', knownMoves: [] }, { species: 'Incineroar', knownMoves: [] }],
  myActiveTeamIndex: [0, null],
  theirActiveTeamIndex: [0, 1],
};

describe('multi-hit parsing', () => {
  test('emits one action per hit with per-hit crit, against a single opp target', () => {
    const r = parseTurnLine('m1 > Beat Up > o1 > 99,98,97,96,90(crit)', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') throw new Error('expected action result');
    expect(r.actions).toHaveLength(5);
    // All share actor/move/target/order.
    expect(r.actions.every(a => a.move === 'Beat Up' && a.order === 1)).toBe(true);
    expect(r.actions.every(a => typeof a.target === 'object' && a.target.side === 'theirs')).toBe(true);
    // Opp target → values are remaining-HP percents.
    expect(r.actions[0]!.targetRemainingHpPercent).toBe(99);
    expect(r.actions[4]!.targetRemainingHpPercent).toBe(90);
    // Only the last hit is a crit.
    expect(r.actions.slice(0, 4).every(a => !a.critical)).toBe(true);
    expect(r.actions[4]!.critical).toBe(true);
  });

  test('mine-side target reads values as raw remaining HP', () => {
    const mineCtx: ParseContext = { ...ctx, myActiveTeamIndex: [0, null] };
    const r = parseTurnLine('o1 > Population Bomb > m1 > 150,120,90', mineCtx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') throw new Error('expected action result');
    expect(r.actions).toHaveLength(3);
    expect(r.actions[0]!.targetRemainingHpRaw).toBe(150);
    expect(r.actions[2]!.targetRemainingHpRaw).toBe(90);
  });

  test('rejects a malformed hit value', () => {
    const r = parseTurnLine('m1 > Beat Up > o1 > 99,abc,90', ctx, 1);
    expect(r.ok).toBe(false);
  });
});

describe('finalizeTurn: multi-hit damage deltas', () => {
  function freshMatch(): Match {
    return {
      id: 'test', startedAt: '2026-05-24T00:00:00.000Z',
      myTeam: [mon({ species: 'Sneasler', ability: 'Unburden', moves: ['Beat Up'] })],
      opponentTeam: [{ species: 'Garchomp', knownMoves: [], currentHpPercent: 100 } as OpponentEntry],
      bring: [0, 1, 2, 3], opponentBrought: [0], turns: [], field: NEUTRAL_FIELD,
      active: { mine: [null, null], theirs: [null, null] },
    };
  }
  const startActive: ActiveIdx = { mine: [0, null], theirs: [0, null] };

  test('each hit becomes its own damage delta; final HP is the last value', () => {
    const match = freshMatch();
    const r = parseTurnLine('m1 > Beat Up > o1 > 99,98,97,96,90(crit)', {
      myTeam: match.myTeam,
      opponentTeam: match.opponentTeam,
      myActiveTeamIndex: [0, null],
      theirActiveTeamIndex: [0, null],
    }, 1);
    if (!r.ok || r.kind !== 'action') throw new Error('expected action result');
    const res = finalizeTurn({ match, turn: { actions: r.actions, field: match.field }, activeIdx: startActive });
    // Final remaining HP on the opp = 90.
    expect(res.match.opponentTeam[0]!.currentHpPercent).toBe(90);
    const hits = res.match.turns[0]!.actions;
    // First hit: 100 -> 99 = 1%. Last hit: 96 -> 90 = 6%, and crit.
    expect(hits[0]!.damageHpPercent).toBeCloseTo(1, 5);
    expect(hits[4]!.damageHpPercent).toBeCloseTo(6, 5);
    expect(hits[4]!.critical).toBe(true);
  });
});
