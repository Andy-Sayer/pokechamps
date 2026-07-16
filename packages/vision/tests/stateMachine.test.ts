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
    for (let r = 0; r < repeat; r++) { const p = sm.feed(read(text, hp)); if (p && !p.partial) out.push(p); }   // final turns only (skip live-preview partials)
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
      'o1+mega > Fake Out > m1 > 82%',
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
    expect(proposals[0]!.lines).toEqual(['o1 > Fake Out > m1 > 82%']);
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
    expect(final.lines).toEqual(['m2 > Light Screen > self', 'm1 > Close Combat > o1 > 100']);   // status stays self; offensive → foe + HP now attaches
  });

  // FINE-GRAINED HP TRACKING: two hits into the SAME target in one turn. The turn-final
  // read only gives the merged total — the settled reads BETWEEN move banners are what
  // give each hit its own damage (the per-move inference observation).
  test('two hits into the same target get per-hit HP from settled reads between banners', () => {
    TS = 0;
    const sm = new BattleStateMachine(LEADS, { gapFrames: 4, clearFrames: 2, settleFrames: 2 });
    const out: TurnProposal[] = [];
    const seq: [string, Partial<Record<SlotRef, number>>, number][] = [
      ['Staraptor used Close Combat!', { m1: 1, m2: 1, o1: 1, o2: 1 }, 2],      // banner up, pre-hit HP
      ['Staraptor used Close Combat!', { o1: 0.8 }, 1],                          // mid-drain (never settles)
      ['Staraptor used Close Combat!', { o1: 0.6 }, 2],                          // settled post-hit-1: 60
      ['Grimmsnarl used Spirit Break!', { o1: 0.6 }, 2],                         // second hit, same target
      ['Grimmsnarl used Spirit Break!', { o1: 0.45 }, 1],                        // mid-drain
      ['Grimmsnarl used Spirit Break!', { o1: 0.35 }, 2],                        // settled post-hit-2: 35
      ['', { o1: 0.35 }, 4],                                                     // move-select gap → flush
    ];
    for (const [text, hp, repeat] of seq)
      for (let r = 0; r < repeat; r++) { const p = sm.feed(read(text, hp)); if (p && !p.partial) out.push(p); }
    expect(out).toHaveLength(1);
    expect(out[0]!.lines).toEqual([
      'm1 > Close Combat > o1 > 60',      // NOT the merged 35 — its own window's settled read
      'm2 > Spirit Break > o1 > 35',      // second hit resolves to the already-claimed foe via its window drop
    ]);
  });

  // SPREAD DETECTION: a dex spread move whose window shows BOTH foes dropping emits the
  // per-target spread list instead of a single inferred target.
  test('a spread move that chunks both foes emits per-target spread damage', () => {
    TS = 0;
    const sm = new BattleStateMachine(LEADS, { gapFrames: 4, clearFrames: 2, settleFrames: 2 });
    const out: TurnProposal[] = [];
    const seq: [string, Partial<Record<SlotRef, number>>, number][] = [
      ['Staraptor used Heat Wave!', { m1: 1, m2: 1, o1: 1, o2: 1 }, 2],
      ['Staraptor used Heat Wave!', { o1: 0.7, o2: 0.65 }, 2],                   // settled post-hit reads
      ['', { o1: 0.7, o2: 0.65 }, 4],                                            // gap → flush
    ];
    for (const [text, hp, repeat] of seq)
      for (let r = 0; r < repeat; r++) { const p = sm.feed(read(text, hp)); if (p && !p.partial) out.push(p); }
    expect(out).toHaveLength(1);
    expect(out[0]!.lines).toEqual(['m1 > Heat Wave > spread > o1:70, o2:65']);
  });

  // A reader that JOINS mid-battle has NO leads and missed the send-out banners, so the roster is
  // all-null and every "X used Y" was dropped as unresolved → empty turns → nothing keyed in. The
  // per-frame species OCR must seed the roster so moves resolve. Reconstructs a live capture:
  // opp Garchomp/Mawile vs my Talonflame/Dragonite, no leads passed.
  test('mid-battle join: seeds the roster from slot OCR so move banners resolve', () => {
    TS = 0;
    const sp = { m1: 'Talonflame', m2: 'Dragonite', o1: 'Garchomp', o2: 'Mawile' } as const;
    const readSp = (text: string, hp: Partial<Record<SlotRef, number>>): FrameRead => {
      const slot = (side: 'mine' | 'opp', index: 0 | 1, ref: SlotRef): SlotRead => ({
        side, index, species: sp[ref], speciesRaw: sp[ref], speciesConfidence: 1,
        hpFraction: hp[ref] ?? null, status: null,
      });
      return { ts: TS++, battleText: text, slots: [slot('mine', 0, 'm1'), slot('mine', 1, 'm2'), slot('opp', 0, 'o1'), slot('opp', 1, 'o2')] };
    };
    const sm = new BattleStateMachine({}, { gapFrames: 4, clearFrames: 2 });   // NO leads — joined mid-game
    const hp = { m1: 1, m2: 0.09, o1: 1, o2: 1 };                              // Dragonite chunked by Play Rough
    const out: TurnProposal[] = [];
    for (const [text, repeat] of [
      ['The opposing Mawile used Play Rough!', 2],
      ["It's super effective on Dragonite!", 2],           // pins the target to m2
      ['', 4],                                              // gap → flush
    ] as [string, number][])
      for (let r = 0; r < repeat; r++) { const p = sm.feed(readSp(text, hp)); if (p && !p.partial) out.push(p); }

    expect(out).toHaveLength(1);
    expect(out[0]!.lines).toEqual(['o2 > Play Rough > m2 > 9%']);   // resolved o2=Mawile, target m2=Dragonite — was DROPPED before the fix
  });
});
