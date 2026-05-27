// summarizeMatch projection: brought mons, HP labels (raw→% on mine, % on
// opp), and the KO tally.
import { describe, test, expect } from 'vitest';
import { summarizeMatch } from '../src/ui/MatchSummary.js';
import type { Match, PokemonSet, OpponentEntry } from '@pokechamps/core/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '@pokechamps/core/domain/types.js';
import { maxHpFor } from '@pokechamps/core/domain/damage.js';

function mon(p: Partial<PokemonSet> & { species: string }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, moves: ['Tackle'], ...p };
}

function freshMatch(): Match {
  return {
    id: 't', startedAt: '2026-05-26T00:00:00.000Z',
    myTeam: [mon({ species: 'Sneasler' }), mon({ species: 'Rillaboom' }), mon({ species: 'Iron Hands' }), mon({ species: 'Flutter Mane' })],
    opponentTeam: ['Incineroar', 'Amoonguss', 'Garchomp', 'Talonflame'].map(species => ({ species, knownMoves: [] } as OpponentEntry)),
    bring: [0, 1, 2, 3], opponentBrought: [0, 1], turns: [], field: { ...NEUTRAL_FIELD },
    active: { mine: [null, null], theirs: [null, null] },
  };
}

describe('summarizeMatch', () => {
  test('projects brought mons, date, and turn count', () => {
    const m = freshMatch();
    m.turns = [{ index: 1, actions: [], field: m.field } as any];
    const r = summarizeMatch(m);
    expect(r.turns).toBe(1);
    expect(r.date).toBe('2026-05-26');
    expect(r.mine.map(x => x.species)).toEqual(['Sneasler', 'Rillaboom', 'Iron Hands', 'Flutter Mane']);
    expect(r.opp.map(x => x.species)).toEqual(['Incineroar', 'Amoonguss']);
  });

  test('HP labels: fainted, raw→% on mine, % on opp, default 100%', () => {
    const m = freshMatch();
    m.myFainted = [0];
    // Rillaboom at half HP (raw).
    const rilla = m.myTeam[1]!;
    m.myCurrentHp = { 1: Math.round(maxHpFor(rilla) / 2) };
    m.opponentTeam[0]!.fainted = true;
    m.opponentTeam[1]!.currentHpPercent = 40;

    const r = summarizeMatch(m);
    expect(r.mine[0]!.hp).toBe('fainted');
    expect(r.mine[0]!.fainted).toBe(true);
    expect(r.mine[1]!.hp).toBe('50%');
    expect(r.mine[2]!.hp).toBe('100%');     // untouched → full
    expect(r.opp[0]!.hp).toBe('fainted');
    expect(r.opp[1]!.hp).toBe('40%');
  });

  test('KO tally counts opp faints (myKos) and my brought faints (oppKos)', () => {
    const m = freshMatch();
    m.myFainted = [0, 2];
    m.opponentTeam[0]!.fainted = true;
    m.opponentTeam[1]!.fainted = true;
    m.opponentTeam[2]!.fainted = true;
    const r = summarizeMatch(m);
    expect(r.myKos).toBe(3);
    expect(r.oppKos).toBe(2);
  });
});
