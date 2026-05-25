// Turn counters for timed effects: weather / Trick Room / Taunt / Encore /
// Disable seed a default count, tick down each EOT, clear at 0, and are
// overridable via the state line.
import { describe, test, expect } from 'vitest';
import { parseTurnLine, type ParseContext } from '../src/domain/turnparser.js';
import { applyStateUpdate, type ActiveIdx } from '../src/match/engine.js';
import { endOfTurn } from '../src/domain/endOfTurn.js';
import { EFFECT_DURATIONS } from '../src/domain/durations.js';
import type { Match, PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, moves: [], ...p };
}
const ctx: ParseContext = {
  myTeam: [mon({ species: 'Sneasler' })],
  opponentTeam: [{ species: 'Incineroar', knownMoves: [] }],
  myActiveTeamIndex: [0, null],
  theirActiveTeamIndex: [0, null],
};

describe('parser: optional turn-count override', () => {
  test('taunt with and without a count', () => {
    const a = parseTurnLine('o1 taunt', ctx, 1);
    expect(a.ok && a.kind === 'state' ? a.update.volatileTurns : 'x').toBeUndefined();
    const b = parseTurnLine('o1 taunt 2', ctx, 1);
    expect(b.ok && b.kind === 'state' ? b.update.volatileTurns : null).toBe(2);
  });
  test('disable <move> <count> splits move from trailing number', () => {
    const r = parseTurnLine('o1 disable Protect 3', ctx, 1);
    if (!r.ok || r.kind !== 'state') throw new Error('state');
    expect(r.update.disableMove).toBe('Protect');
    expect(r.update.volatileTurns).toBe(3);
  });
});

function freshMatch(field = NEUTRAL_FIELD): Match {
  return {
    id: 't', startedAt: '', myTeam: ctx.myTeam,
    opponentTeam: [{ species: 'Incineroar', knownMoves: [], currentHpPercent: 100 } as OpponentEntry],
    bring: [0, 1, 2, 3], opponentBrought: [0], turns: [], field,
    active: { mine: [null, null], theirs: [null, null] },
  };
}
const startActive: ActiveIdx = { mine: [0, null], theirs: [0, null] };

describe('apply seeds default counts; override respected', () => {
  test('taunt seeds default; explicit count overrides', () => {
    let m = applyStateUpdate({ match: freshMatch(), update: { side: 'theirs', teamIndex: 0, taunt: true }, activeIdx: startActive }).match;
    expect(m.opponentTeam[0]!.tauntTurns).toBe(EFFECT_DURATIONS.taunt);
    m = applyStateUpdate({ match: freshMatch(), update: { side: 'theirs', teamIndex: 0, disableMove: 'Protect', volatileTurns: 1 }, activeIdx: startActive }).match;
    expect(m.opponentTeam[0]!.disableTurns).toBe(1);
  });
});

describe('endOfTurn ticks counters and clears at 0', () => {
  test('weather + Trick Room countdown; TR clears at 0', () => {
    const field = { ...NEUTRAL_FIELD, weather: 'Sun' as const, weatherTurns: 2, trickRoom: true, trickRoomTurns: 1 };
    const m = freshMatch(field);
    const r = endOfTurn(m, field, startActive);
    expect(r.match.field.weatherTurns).toBe(1);
    expect(r.match.field.weather).toBe('Sun');
    expect(r.match.field.trickRoom).toBe(false);
    expect(r.match.field.trickRoomTurns).toBeUndefined();
  });

  test('opp Taunt ticks to 0 and clears the volatile', () => {
    const m = freshMatch();
    m.opponentTeam[0] = { ...m.opponentTeam[0]!, taunted: true, tauntTurns: 1 };
    const r = endOfTurn(m, m.field, startActive);
    expect(r.match.opponentTeam[0]!.taunted).toBeUndefined();
    expect(r.match.opponentTeam[0]!.tauntTurns).toBeUndefined();
  });

  test('Encore with 2 turns ticks to 1 and stays', () => {
    const m = freshMatch();
    m.opponentTeam[0] = { ...m.opponentTeam[0]!, encoreMove: 'Flare Blitz', encoreTurns: 2 };
    const r = endOfTurn(m, m.field, startActive);
    expect(r.match.opponentTeam[0]!.encoreMove).toBe('Flare Blitz');
    expect(r.match.opponentTeam[0]!.encoreTurns).toBe(1);
  });
});
