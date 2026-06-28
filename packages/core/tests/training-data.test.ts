// Task-A bring/outcome extraction: a replay transcript → per-side
// (team, bring, opp, won) rows. Pins the contract the exporter relies on.
import { describe, test, expect } from 'vitest';
import { bringOutcomeRows } from '../src/domain/trainingData.js';
import type { BattleTranscript, TranscriptMon } from '../src/domain/showdownReplay.js';

const mon = (species: string): TranscriptMon => ({ species, level: 50, moves: [] });
const sw = (side: 'p1' | 'p2', species: string) =>
  ({ kind: 'switch' as const, pos: { side, slot: 0, nickname: species }, species, level: 50, hpPct: 100 });

const t: BattleTranscript = {
  format: 'test', players: { p1: 'Alice', p2: 'Bob' }, teamSize: { p1: 4, p2: 4 },
  teams: {
    p1: ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'].map(mon),     // full 6 (OTS)
    p2: ['Q0', 'Q1', 'Q2', 'Q3'].map(mon),                 // only 4 known (non-OTS)
  },
  leadEvents: [sw('p1', 'P0'), sw('p2', 'Q0')],
  turns: [{ index: 1, events: [sw('p1', 'P3'), sw('p2', 'Q1')] }],
  winner: 'Alice',
};

describe('bringOutcomeRows', () => {
  const rows = bringOutcomeRows(t, 'g1');

  test('one row per side', () => expect(rows).toHaveLength(2));

  test('p1: full team, correct bring (leads + switch-ins), won', () => {
    const p1 = rows.find(r => r.side === 'p1')!;
    expect(p1.team).toHaveLength(6);
    expect(p1.fullTeam).toBe(true);
    expect(new Set(p1.bring)).toEqual(new Set(['P0', 'P3']));
    expect(p1.won).toBe(true);
    expect(new Set(p1.oppBring)).toEqual(new Set(['Q0', 'Q1']));
  });

  test('p2: partial team (4 known) → not full; lost', () => {
    const p2 = rows.find(r => r.side === 'p2')!;
    expect(p2.team).toHaveLength(4);
    expect(p2.fullTeam).toBe(false);
    expect(p2.won).toBe(false);
  });
});
