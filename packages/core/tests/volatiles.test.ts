// Move-restricting volatiles: Taunt / Encore / Disable. Parse + apply + their
// effect on the opp threat pool (Encore locks, Disable removes), plus
// clear-on-switch and cure.
import { describe, test, expect } from 'vitest';
import { parseTurnLine, type ParseContext } from '../src/domain/turnparser.js';
import { applyStateUpdate, finalizeTurn, type ActiveIdx } from '../src/match/engine.js';
import { predictThreat } from '../src/domain/predictions.js';
import type { Match, PokemonSet, OpponentEntry, MoveAction } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves?: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, moves: [], ...p };
}

const ctx: ParseContext = {
  myTeam: [mon({ species: 'Sneasler' }), mon({ species: 'Rillaboom' })],
  opponentTeam: [{ species: 'Incineroar', knownMoves: [] }, { species: 'Amoonguss', knownMoves: [] }],
  myActiveTeamIndex: [0, 1],
  theirActiveTeamIndex: [0, 1],
};

describe('volatile parsing', () => {
  test('taunt / encore <move> / disable <move>', () => {
    const t = parseTurnLine('o1 taunt', ctx, 1);
    expect(t.ok && t.kind === 'state' && t.update.taunt).toBe(true);
    const e = parseTurnLine('o1 encore Fake Out', ctx, 1);
    expect(e.ok && e.kind === 'state' ? e.update.encoreMove : null).toBe('Fake Out');
    const d = parseTurnLine('o1 disable Flare Blitz', ctx, 1);
    expect(d.ok && d.kind === 'state' ? d.update.disableMove : null).toBe('Flare Blitz');
  });
});

function freshMatch(): Match {
  return {
    id: 't', startedAt: '', myTeam: ctx.myTeam,
    opponentTeam: [
      { species: 'Incineroar', knownMoves: ['Flare Blitz', 'Knock Off', 'Fake Out'], currentHpPercent: 100 } as OpponentEntry,
      { species: 'Amoonguss', knownMoves: [] } as OpponentEntry,
    ],
    bring: [0, 1, 2, 3], opponentBrought: [0, 1], turns: [], field: NEUTRAL_FIELD,
    active: { mine: [null, null], theirs: [null, null] },
  };
}
const startActive: ActiveIdx = { mine: [0, 1], theirs: [0, 1] };

describe('volatile apply + clearing', () => {
  test('apply taunt/encore/disable to opp; cure clears all', () => {
    let m = freshMatch();
    m = applyStateUpdate({ match: m, update: { side: 'theirs', teamIndex: 0, taunt: true }, activeIdx: startActive }).match;
    m = applyStateUpdate({ match: m, update: { side: 'theirs', teamIndex: 0, disableMove: 'Flare Blitz' }, activeIdx: startActive }).match;
    expect(m.opponentTeam[0]!.taunted).toBe(true);
    expect(m.opponentTeam[0]!.disabledMove).toBe('Flare Blitz');
    m = applyStateUpdate({ match: m, update: { side: 'theirs', teamIndex: 0, cureStatus: true }, activeIdx: startActive }).match;
    expect(m.opponentTeam[0]!.taunted).toBeUndefined();
    expect(m.opponentTeam[0]!.disabledMove).toBeUndefined();
  });

  test('switching the opp out clears its volatiles', () => {
    let m = freshMatch();
    m = applyStateUpdate({ match: m, update: { side: 'theirs', teamIndex: 0, encoreMove: 'Fake Out' }, activeIdx: startActive }).match;
    expect(m.opponentTeam[0]!.encoreMove).toBe('Fake Out');
    // Opp slot 0 switches to team index... use a switch action via finalizeTurn.
    const sw: MoveAction = { side: 'theirs', attackerSlot: 0, kind: 'switch', move: 'x', target: 'self', targetTeamIndex: 1, order: 1 };
    const r = finalizeTurn({ match: m, turn: { actions: [sw], field: m.field }, activeIdx: startActive });
    expect(r.match.opponentTeam[0]!.encoreMove).toBeUndefined();
  });
});

describe('volatiles affect the opp threat pool', () => {
  const mySet = mon({ species: 'Rillaboom' });
  test('Encore locks the threat move; Disable removes it', () => {
    const oppEncore: OpponentEntry = { species: 'Incineroar', knownMoves: ['Flare Blitz', 'Knock Off'], encoreMove: 'Knock Off' };
    const t = predictThreat({ opponent: oppEncore, defender: mySet, field: NEUTRAL_FIELD });
    expect(t?.move).toBe('Knock Off');

    const oppDisable: OpponentEntry = { species: 'Incineroar', knownMoves: ['Flare Blitz', 'Knock Off'], disabledMove: 'Flare Blitz' };
    const t2 = predictThreat({ opponent: oppDisable, defender: mySet, field: NEUTRAL_FIELD });
    expect(t2?.move).toBe('Knock Off');
  });
});
