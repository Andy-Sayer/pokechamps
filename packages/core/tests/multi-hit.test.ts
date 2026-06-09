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

  test('interleaves a mid-sequence item trigger (sitrus) as a checkpoint action', () => {
    const r = parseTurnLine('m1 > Beat Up > o1 > 75, 20, sitrus 50, 30', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') throw new Error('expected action result');
    expect(r.actions).toHaveLength(4);
    // Hits keep their remaining-HP percents…
    expect(r.actions[0]!.targetRemainingHpPercent).toBe(75);
    expect(r.actions[1]!.targetRemainingHpPercent).toBe(20);
    expect(r.actions[3]!.targetRemainingHpPercent).toBe(30);
    // …the 3rd token is the item checkpoint: midHitItem set, no crit, resulting HP 50.
    expect(r.actions[2]!.midHitItem).toBe('Sitrus Berry');
    expect(r.actions[2]!.targetRemainingHpPercent).toBe(50);
    expect(r.actions[2]!.critical).toBeFalsy();
    expect(r.actions[0]!.midHitItem).toBeUndefined();
  });

  test('bare `sash` mid-sequence defaults to a 1-HP sliver', () => {
    const r = parseTurnLine('m1 > Beat Up > o1 > 40, sash, 0', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') throw new Error('expected action result');
    expect(r.actions).toHaveLength(3);
    expect(r.actions[1]!.midHitItem).toBe('Focus Sash');
    expect(r.actions[1]!.targetRemainingHpPercent).toBe(1);
  });

  test('rejects an unknown item word and a heal-berry without a resulting HP', () => {
    expect(parseTurnLine('m1 > Beat Up > o1 > 75, foo 50, 30', ctx, 1).ok).toBe(false);
    expect(parseTurnLine('m1 > Beat Up > o1 > 75, sitrus, 30', ctx, 1).ok).toBe(false);
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

  test('a mid-sequence Sitrus heal restores HP so the next hit deltas off the healed value', () => {
    const match = freshMatch();
    const r = parseTurnLine('m1 > Beat Up > o1 > 75, 20, sitrus 50, 30', {
      myTeam: match.myTeam,
      opponentTeam: match.opponentTeam,
      myActiveTeamIndex: [0, null],
      theirActiveTeamIndex: [0, null],
    }, 1);
    if (!r.ok || r.kind !== 'action') throw new Error('expected action result');
    const res = finalizeTurn({ match, turn: { actions: r.actions, field: match.field }, activeIdx: startActive });
    const acts = res.match.turns[0]!.actions;
    // Hit deltas: 100->75 = 25, 75->20 = 55, then 50->30 = 20 (off the healed 50).
    expect(acts[0]!.damageHpPercent).toBeCloseTo(25, 5);
    expect(acts[1]!.damageHpPercent).toBeCloseTo(55, 5);
    expect(acts[3]!.damageHpPercent).toBeCloseTo(20, 5);
    // The checkpoint records no damage (excluded from inference) and carries the item.
    expect(acts[2]!.midHitItem).toBe('Sitrus Berry');
    expect(acts[2]!.damageHpPercent).toBeUndefined();
    // Final HP is the last hit value; the Sitrus is learned + spent on the opp.
    expect(res.match.opponentTeam[0]!.currentHpPercent).toBe(30);
    expect(res.match.opponentTeam[0]!.item).toBe('Sitrus Berry');
    expect(res.match.opponentTeam[0]!.itemConsumed).toBe('Sitrus Berry');
  });
});

describe('finalizeTurn: Focus Sash always consumes when logged', () => {
  function ccMatch(): Match {
    return {
      id: 'test', startedAt: '2026-05-24T00:00:00.000Z',
      myTeam: [mon({ species: 'Sneasler', ability: 'Unburden', moves: ['Close Combat'] })],
      opponentTeam: [{ species: 'Garchomp', knownMoves: [], currentHpPercent: 100 } as OpponentEntry],
      bring: [0, 1, 2, 3], opponentBrought: [0], turns: [], field: NEUTRAL_FIELD,
      active: { mine: [null, null], theirs: [null, null] },
    };
  }
  const startActive: ActiveIdx = { mine: [0, null], theirs: [0, null] };
  const pctx = (m: Match): ParseContext => ({
    myTeam: m.myTeam, opponentTeam: m.opponentTeam,
    myActiveTeamIndex: [0, null], theirActiveTeamIndex: [0, null],
  });

  test('procced sash (1-HP sliver): consumed, mon kept alive at 1', () => {
    const match = ccMatch();
    const r = parseTurnLine('m1 > Close Combat > o1 > 1 sash', pctx(match), 1);
    if (!r.ok || r.kind !== 'action') throw new Error('expected action result');
    const res = finalizeTurn({ match, turn: { actions: r.actions, field: match.field }, activeIdx: startActive });
    const o = res.match.opponentTeam[0]!;
    expect(o.itemConsumed).toBe('Focus Sash');
    expect(o.currentHpPercent).toBe(1);
    expect(o.fainted).toBeFalsy();
  });

  test('survived-with-HP sash: still consumed (it fired), damage stands', () => {
    const match = ccMatch();
    const r = parseTurnLine('m1 > Close Combat > o1 > 50 sash', pctx(match), 1);
    if (!r.ok || r.kind !== 'action') throw new Error('expected action result');
    const res = finalizeTurn({ match, turn: { actions: r.actions, field: match.field }, activeIdx: startActive });
    const o = res.match.opponentTeam[0]!;
    expect(o.itemConsumed).toBe('Focus Sash');   // the user logged `sash` → it was used
    expect(o.currentHpPercent).toBe(50);          // damage stands (real output for inference)
  });
});
