// Tailwind turn counter: seeding via applyFieldMove + countdown/clear in endOfTurn.
import { describe, test, expect } from 'vitest';
import { applyFieldMove, fieldMoveEffect } from '../src/domain/fieldMoves.js';
import { endOfTurn } from '../src/domain/endOfTurn.js';
import { EFFECT_DURATIONS } from '../src/domain/durations.js';
import type { Match, PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';
import type { ActiveIdx } from '../src/match/engine.js';

function mon(p: Partial<PokemonSet> & { species: string }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, moves: [], ...p };
}

const myTeam = [mon({ species: 'Tornadus' })];
const oppTeam: OpponentEntry[] = [{ species: 'Incineroar', knownMoves: [], currentHpPercent: 100 }];

function freshMatch(field = NEUTRAL_FIELD): Match {
  return {
    id: 'tw', startedAt: '', myTeam, opponentTeam: oppTeam.map(o => ({ ...o })),
    bring: [0, 1, 2, 3], opponentBrought: [0], turns: [], field,
    active: { mine: [null, null], theirs: [null, null] },
  };
}

const startActive: ActiveIdx = { mine: [0, null], theirs: [0, null] };

describe('applyFieldMove: Tailwind seeds turns', () => {
  test('mine side sets myTailwind=true and myTailwindTurns=4', () => {
    const e = fieldMoveEffect('Tailwind')!;
    const f = applyFieldMove(NEUTRAL_FIELD, 'mine', e);
    expect(f.myTailwind).toBe(true);
    expect(f.myTailwindTurns).toBe(EFFECT_DURATIONS.tailwind);
    expect(f.theirTailwind).toBe(false);
    expect(f.theirTailwindTurns).toBeUndefined();
  });

  test('theirs side sets theirTailwind=true and theirTailwindTurns=4', () => {
    const e = fieldMoveEffect('Tailwind')!;
    const f = applyFieldMove(NEUTRAL_FIELD, 'theirs', e);
    expect(f.theirTailwind).toBe(true);
    expect(f.theirTailwindTurns).toBe(EFFECT_DURATIONS.tailwind);
    expect(f.myTailwind).toBe(false);
    expect(f.myTailwindTurns).toBeUndefined();
  });
});

describe('endOfTurn: Tailwind ticks down and clears at 0', () => {
  test('myTailwindTurns decrements each EOT', () => {
    const field = { ...NEUTRAL_FIELD, myTailwind: true, myTailwindTurns: 3 };
    const r = endOfTurn(freshMatch(field), field, startActive);
    expect(r.match.field.myTailwind).toBe(true);
    expect(r.match.field.myTailwindTurns).toBe(2);
  });

  test('myTailwindTurns clears myTailwind at 0', () => {
    const field = { ...NEUTRAL_FIELD, myTailwind: true, myTailwindTurns: 1 };
    const r = endOfTurn(freshMatch(field), field, startActive);
    expect(r.match.field.myTailwind).toBe(false);
    expect(r.match.field.myTailwindTurns).toBeUndefined();
    expect(r.notes.some(n => n.includes('m Tailwind ended'))).toBe(true);
  });

  test('theirTailwindTurns decrements each EOT', () => {
    const field = { ...NEUTRAL_FIELD, theirTailwind: true, theirTailwindTurns: 2 };
    const r = endOfTurn(freshMatch(field), field, startActive);
    expect(r.match.field.theirTailwind).toBe(true);
    expect(r.match.field.theirTailwindTurns).toBe(1);
  });

  test('theirTailwindTurns clears theirTailwind at 0', () => {
    const field = { ...NEUTRAL_FIELD, theirTailwind: true, theirTailwindTurns: 1 };
    const r = endOfTurn(freshMatch(field), field, startActive);
    expect(r.match.field.theirTailwind).toBe(false);
    expect(r.match.field.theirTailwindTurns).toBeUndefined();
    expect(r.notes.some(n => n.includes('o Tailwind ended'))).toBe(true);
  });

  test('untracked tailwind (turns=undefined) is not decremented', () => {
    const field = { ...NEUTRAL_FIELD, myTailwind: true }; // no myTailwindTurns
    const r = endOfTurn(freshMatch(field), field, startActive);
    expect(r.match.field.myTailwind).toBe(true);
    expect(r.match.field.myTailwindTurns).toBeUndefined();
  });
});
