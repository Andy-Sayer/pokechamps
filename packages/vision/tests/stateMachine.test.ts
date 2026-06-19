import { describe, test, expect } from 'vitest';
import { BattleStateMachine } from '../src/stateMachine.js';
import type { FrameRead, SlotRead, SlotRef, TurnProposal } from '../src/types.js';

const LEADS = { m1: 'Staraptor', m2: 'Grimmsnarl', o1: 'Raichu', o2: 'Sylveon' };

/** Build a FrameRead: battleText + per-slot HP fractions. */
let TS = 0;
function read(text: string, hp: Partial<Record<SlotRef, number>> = {}): FrameRead {
  const slot = (side: 'mine' | 'opp', index: 0 | 1, ref: SlotRef): SlotRead => ({
    side, index, species: null, speciesRaw: '', speciesConfidence: 0,
    hpFraction: hp[ref] ?? null, status: null,
  });
  return {
    ts: TS++, battleText: text,
    slots: [slot('mine', 0, 'm1'), slot('mine', 1, 'm2'), slot('opp', 0, 'o1'), slot('opp', 1, 'o2')],
  };
}

/** Feed [text, repeatFrames] items; collect emitted proposals. */
function run(sm: BattleStateMachine, items: [string, number][], hp: Partial<Record<SlotRef, number>>): TurnProposal[] {
  const out: TurnProposal[] = [];
  for (const [text, repeat] of items)
    for (let r = 0; r < repeat; r++) { const p = sm.feed(read(text, hp)); if (p) out.push(p); }
  return out;
}

describe('BattleStateMachine', () => {
  test('dedupes a persisting banner, closes a turn at the move-select gap, attaches HP', () => {
    TS = 0;
    const sm = new BattleStateMachine(LEADS, { gapFrames: 4, clearFrames: 2 });
    const hp = { m1: 0.82, m2: 1, o1: 1, o2: 1 };          // Staraptor took Fake Out chip
    const proposals = run(sm, [
      ['The opposing Raichu has Mega Evolved into Mega Raichu!', 2],
      ['The opposing Raichu used Fake Out!', 2],
      ["Staraptor flinched and couldn't move!", 2],
      ['Grimmsnarl used Light Screen!', 2],
      ['The opposing Raichu is buffeted by the sandstorm!', 2],
      ['', 4],                                              // move-select gap → flush
    ], hp);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.lines).toEqual([
      'o1+mega > Fake Out > m1 > 82',
      'm2 > Light Screen > self',
    ]);
  });

  test('residual→action boundary fires mid-stream (no gap needed)', () => {
    TS = 0;
    const sm = new BattleStateMachine(LEADS, { gapFrames: 99 });   // disable gap; rely on residual signal
    const hp = { m1: 0.82, m2: 1, o1: 1, o2: 1 };
    const proposals = run(sm, [
      ['The opposing Raichu used Fake Out!', 1],
      ["Staraptor flinched and couldn't move!", 1],
      ['The opposing Raichu is buffeted by the sandstorm!', 1],   // residual ends turn 1
      ['Staraptor used Close Combat!', 1],                        // next action → emits turn 1
    ], hp);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.lines).toEqual(['o1 > Fake Out > m1 > 82']);
  });

  test('a mid-turn animation lull (< gapFrames) does NOT split the turn', () => {
    TS = 0;
    const sm = new BattleStateMachine(LEADS, { gapFrames: 5, clearFrames: 2 });
    const hp = { m1: 1, m2: 1, o1: 1, o2: 1 };
    const proposals = run(sm, [
      ['Grimmsnarl used Light Screen!', 2],
      ['', 3],                                              // short lull (< 5) — no flush
      ['Staraptor used Close Combat!', 2],
    ], hp);
    expect(proposals).toHaveLength(0);                      // still one open turn
    const final = sm.finish()!;
    expect(final.lines).toEqual(['m2 > Light Screen > self', 'm1 > Close Combat > self']);
  });
});
