// Focus Sash inline annotation: `m1 > Close Combat > o1 > 1 sash`.
import { describe, test, expect } from 'vitest';
import { parseTurnLine, type ParseContext } from '../src/domain/turnparser.js';
import { finalizeTurn, type ActiveIdx } from '../src/match/engine.js';
import type { Match, PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}

const ctx: ParseContext = {
  myTeam: [mon({ species: 'Sneasler', moves: ['Close Combat'] })],
  opponentTeam: [{ species: 'Garchomp', knownMoves: [] }],
  myActiveTeamIndex: [0, null],
  theirActiveTeamIndex: [0, null],
};

describe('sash damage suffix parsing', () => {
  test('"1 sash" → remaining 1% + sash flag (opp target)', () => {
    const r = parseTurnLine('m1 > Close Combat > o1 > 1 sash', ctx, 1);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'action') return;
    const a = r.actions[0]!;
    expect(a.sash).toBe(true);
    expect(a.targetRemainingHpPercent).toBe(1);
  });

  test('"0 sash" forces a 1-sliver (survives the lethal hit)', () => {
    const r = parseTurnLine('m1 > Close Combat > o1 > 0 sash', ctx, 1);
    if (!r.ok || r.kind !== 'action') throw new Error('action');
    expect(r.actions[0]!.sash).toBe(true);
    expect(r.actions[0]!.targetRemainingHpPercent).toBe(1);
  });

  test('bare "sash" with no value → 1-sliver', () => {
    const r = parseTurnLine('m1 > Close Combat > o1 > sash', ctx, 1);
    if (!r.ok || r.kind !== 'action') throw new Error('action');
    expect(r.actions[0]!.sash).toBe(true);
    expect(r.actions[0]!.targetRemainingHpPercent).toBe(1);
  });

  test('mine-side target reads raw remaining', () => {
    const mineCtx: ParseContext = { ...ctx, myActiveTeamIndex: [0, null], theirActiveTeamIndex: [0, null] };
    const r = parseTurnLine('o1 > Earthquake > m1 > 1 sash', mineCtx, 1);
    if (!r.ok || r.kind !== 'action') throw new Error('action');
    expect(r.actions[0]!.sash).toBe(true);
    expect(r.actions[0]!.targetRemainingHpRaw).toBe(1);
  });
});

describe('finalizeTurn: sash effect', () => {
  function freshMatch(): Match {
    return {
      id: 't', startedAt: '', myTeam: [mon({ species: 'Sneasler', ability: 'Unburden', moves: ['Close Combat'] })],
      opponentTeam: [{ species: 'Garchomp', knownMoves: [], currentHpPercent: 100 } as OpponentEntry],
      bring: [0, 1, 2, 3], opponentBrought: [0], turns: [], field: NEUTRAL_FIELD,
      active: { mine: [null, null], theirs: [null, null] },
    };
  }
  const startActive: ActiveIdx = { mine: [0, null], theirs: [0, null] };

  test('opp survives at 1 HP, item marked Focus Sash, inference skipped', () => {
    const match = freshMatch();
    const r = parseTurnLine('m1 > Close Combat > o1 > 0 sash', {
      myTeam: match.myTeam, opponentTeam: match.opponentTeam,
      myActiveTeamIndex: [0, null], theirActiveTeamIndex: [0, null],
    }, 1);
    if (!r.ok || r.kind !== 'action') throw new Error('action');
    const res = finalizeTurn({ match, turn: { actions: r.actions, field: match.field }, activeIdx: startActive });
    const opp = res.match.opponentTeam[0]!;
    expect(opp.currentHpPercent).toBe(1);
    expect(opp.fainted).toBeFalsy();
    expect(opp.itemConsumed).toBe('Focus Sash');
    // Capped damage → no spread inference ran (candidates stay empty).
    expect(opp.candidates ?? []).toHaveLength(0);
  });

  test('survives with HP to spare → item learned (held), damage drives inference', () => {
    const match = freshMatch();
    // Garchomp ends at 50% after the hit, but flagged sash → didn't proc.
    const r = parseTurnLine('m1 > Close Combat > o1 > 50 sash', {
      myTeam: match.myTeam, opponentTeam: match.opponentTeam,
      myActiveTeamIndex: [0, null], theirActiveTeamIndex: [0, null],
    }, 1);
    if (!r.ok || r.kind !== 'action') throw new Error('action');
    const res = finalizeTurn({ match, turn: { actions: r.actions, field: match.field }, activeIdx: startActive });
    const opp = res.match.opponentTeam[0]!;
    expect(opp.currentHpPercent).toBe(50);
    expect(opp.fainted).toBeFalsy();
    // Held, not consumed — a Sash only spends when it procs.
    expect(opp.item).toBe('Focus Sash');
    expect(opp.itemConsumed).toBeUndefined();
    // Full damage → inference ran (candidates populated).
    expect((opp.candidates ?? []).length).toBeGreaterThan(0);
  });
});
