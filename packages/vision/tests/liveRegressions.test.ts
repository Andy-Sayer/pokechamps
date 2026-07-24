// Regressions from the first full live ranked match (2026-07-23, vs SabaoEmPo).
// Every case here reproduces a defect observed in that match's debug trace
// (fixtures/live-debug/) — see memory live-test-2026-07-23-findings.
import { describe, test, expect } from 'vitest';
import { parseBanner } from '../src/bannerParse.js';
import { BattleTracker } from '../src/track.js';
import { BattleStateMachine } from '../src/stateMachine.js';
import { panelBrightnessRatio } from '../src/oppTeamRead.js';
import { CHAMPIONS_OPP_PANEL_BG } from '../src/regions.js';
import type { Frame, FrameRead, SlotRead, SlotRef, TurnProposal } from '../src/types.js';

const LEADS = { m1: 'Talonflame', m2: 'Kingambit', o1: 'Charizard', o2: 'Hawlucha' };

describe('banner patterns from the live match', () => {
  test('"The harsh sunlight faded." parses as weatherEnd (was unknown)', () => {
    expect(parseBanner('The harsh sunlight faded.')).toEqual({ kind: 'weatherEnd' });
  });

  test('"X grew drowsy!" parses as drowsy naming the target', () => {
    expect(parseBanner('Kingambit grew drowsy!')).toMatchObject({ kind: 'drowsy', side: 'mine', species: 'Kingambit' });
  });
});

describe('BattleTracker — live-match regressions', () => {
  test('a KO emits at its chronological position and the send-in becomes an `in` line', () => {
    const t = new BattleTracker(LEADS);
    t.feed(parseBanner('Talonflame used Brave Bird!'));
    const turn1 = t.flushPending({}, new Set());
    expect(turn1).toEqual(['m1 > Brave Bird > o1']);
    // Faint lands with no following action — the old actions-only gate dropped it.
    t.feed(parseBanner('The opposing Charizard fainted!'));
    const turn2 = t.flushPending({}, new Set());
    expect(turn2).toEqual(['o1 ko']);
    // The replacement into the vacated slot is an `in` state line, NOT a chosen
    // switch (a switch would poison the +6 speed bracket inference).
    t.feed(parseBanner('SabaoEmPo sent out Snorlax!'));
    const turn3 = t.flushPending({}, new Set());
    expect(turn3).toEqual(['oSnorlax in o1']);
  });

  test('ko precedes a same-proposal replacement so the wrong mon is never fainted', () => {
    const t = new BattleTracker(LEADS);
    t.feed(parseBanner('The opposing Charizard used Heat Wave!'));
    t.feed(parseBanner('Talonflame fainted!'));
    t.feed(parseBanner('Go! Meowscarada!'));
    const lines = t.flushPending({}, new Set())!;
    expect(lines.indexOf('m1 ko')).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf('m1 ko')).toBeLessThan(lines.indexOf('mMeowscarada in m1'));
  });

  test('a garbled re-read of the same move is a re-fire, not a boundary — and repairs the name', () => {
    const t = new BattleTracker(LEADS);
    expect(t.feed(parseBanner('The opposing Charizard used Fake Qut!'))).toBeNull();   // OCR'd Q
    expect(t.feed(parseBanner('The opposing Charizard used Fake Out!'))).toBeNull();   // re-read, clean — must NOT split
    const lines = t.flushPending({}, new Set())!;
    expect(lines.filter(l => l.includes('Fake'))).toHaveLength(1);
    expect(lines.some(l => l.includes('Fake Out'))).toBe(true);                        // clean re-read fixed the name
  });

  test('the same actor using a DIFFERENT move closes the missed turn boundary', () => {
    const t = new BattleTracker(LEADS);
    expect(t.feed(parseBanner('Talonflame used Brave Bird!'))).toBeNull();
    const closed = t.feed(parseBanner('Talonflame used Tailwind!'));
    expect(closed).toEqual(['m1 > Brave Bird > o1']);     // previous turn flushed
    // …while a SAME-move repeat stays a banner re-fire (no split, no duplicate).
    const t2 = new BattleTracker(LEADS);
    expect(t2.feed(parseBanner('Talonflame used Brave Bird!'))).toBeNull();
    expect(t2.feed(parseBanner('Talonflame used Brave Bird!'))).toBeNull();
    expect(t2.flushPending({}, new Set())).toEqual(['m1 > Brave Bird > o1']);
  });

  test('Yawn resolves its target from the "grew drowsy" banner (was `> self`)', () => {
    const t = new BattleTracker({ m1: 'Kingambit', m2: 'Dragonite', o1: 'Snorlax', o2: 'Noivern' });
    t.feed(parseBanner('The opposing Snorlax used Yawn!'));
    t.feed(parseBanner('Kingambit grew drowsy!'));
    expect(t.flushPending({}, new Set())).toEqual(['o1 > Yawn > m1']);
  });

  test('"lost some of its HP" after its own attack reveals Life Orb; after a status self-cut it does not', () => {
    const t = new BattleTracker(LEADS);
    t.feed(parseBanner('The opposing Hawlucha used Rock Slide!'));
    t.feed(parseBanner('The opposing Hawlucha lost some of its HP!'));
    expect(t.flushPending({}, new Set())).toContain('o2 item Life Orb');

    const t2 = new BattleTracker(LEADS);
    t2.feed(parseBanner('The opposing Hawlucha used Substitute!'));
    t2.feed(parseBanner('The opposing Hawlucha lost some of its HP!'));
    expect(t2.flushPending({}, new Set()) ?? []).not.toContain('o2 item Life Orb');
  });
});

describe('nicknamed opponent — garbled OCR regression (2026-07-24 vs KEDD, グーちゃん)', () => {
  // The real trace: the send-out banner re-OCR'd as different garbage each re-fire,
  // the nicknamed mon's plate never resolves, and every opp banner then failed to
  // resolve against the garbage roster.
  const G1 = 'Siâ€”72 3D and JN 2', G2 = 'Bvâ€”72 3D and JINR 2', G3 = 'Sâ€”72 5S and JX 2';

  test('re-fired garbled send-outs collapse to one pair; lines are suppressed, not garbage', () => {
    const t = new BattleTracker({});
    for (const g of [G1, G2, G3]) t.feed(parseBanner(`KEDD sent out ${g}!`));
    t.feed(parseBanner('Go! Talonflame and Kingambit!'));
    const lines = t.flushPending({}, new Set())!;
    expect(lines).toEqual(['m1 > switch > Talonflame', 'm2 > switch > Kingambit']);   // no garbage switch lines
    const roster = t.getRoster();
    expect(roster.o1).toBeTruthy();               // both opp slots CLAIMED by the garbled pair…
    expect(roster.o2).toBeTruthy();               // …so plates/elimination can bind them later
  });

  test('a confident canonical plate overrides a garbled label; elimination resolves the nicknamed slot', () => {
    const t = new BattleTracker({});
    t.feed(parseBanner(`KEDD sent out ${G1}!`));
    t.seedActive('o1', 'Absol', 1);                              // plate 0 reads clean
    expect(t.getRoster().o1).toBe('Absol');
    t.feed(parseBanner('The opposing Absol used Sucker Punch!'));
    t.feed(parseBanner('The opposing Tâ€”51 A Q used Swords Dance!'));   // nicknamed mon, fresh garble
    const lines = t.flushPending({}, new Set())!;
    expect(lines.some(l => l.startsWith('o1 > Sucker Punch'))).toBe(true);                  // Absol resolved to o1
    expect(lines.some(l => l.startsWith('o2 > Swords Dance'))).toBe(true);                  // elimination → o2
  });

  test('an unresolvable send-out never clobbers a fully-tracked (leads-seeded) side', () => {
    const t = new BattleTracker({ o1: 'Absol', o2: 'Skarmory', m1: 'Talonflame', m2: 'Kingambit' });
    t.feed(parseBanner(`KEDD sent out ${G1}!`));
    expect(t.getRoster().o1).toBe('Absol');
    expect(t.getRoster().o2).toBe('Skarmory');
    expect(t.flushPending({}, new Set())).toBeNull();            // nothing real happened
  });
});

describe('Latin nickname — Courtois regression (2026-07-24 vs Migueloncio)', () => {
  test('a plate read never duplicates a species across the pair — it corrects the order', () => {
    // Banner order put Camerupt at o2; the true plate shows Camerupt at o1. The old
    // override wrote Camerupt into BOTH slots (Earth Power → o1 while the mega → o2).
    const t = new BattleTracker({});
    t.feed(parseBanner('Migueloncio sent out Courtois and Camerupt!'));   // o1='Courtois' o2='Camerupt' by banner order
    t.seedActive('o1', 'Camerupt', 0.95);                                 // plate 0 is the real Camerupt
    const r = t.getRoster();
    expect(r.o1).toBe('Camerupt');
    expect(r.o2).toBe('Courtois');                                        // swapped, never duplicated
    t.feed(parseBanner("The opposing Camerupt's Cameruptite is reacting to Migueloncio's Omni Ring!"));
    t.feed(parseBanner('The opposing Camerupt has Mega Evolved into Mega Camerupt!'));
    t.feed(parseBanner('The opposing Camerupt used Earth Power!'));
    const lines = t.flushPending({}, new Set())!;
    expect(lines.some(l => l.startsWith('o1+mega > Earth Power'))).toBe(true);   // mega + move on the SAME slot
  });

  test('with leads seeded, the send-out pair binds the nickname as the unclaimed slot alias', () => {
    const t = new BattleTracker({ o1: 'Milotic', o2: 'Camerupt', m1: 'Talonflame', m2: 'Kingambit' });
    t.feed(parseBanner('Migueloncio sent out Courtois and Camerupt!'));
    expect(t.getRoster().o1).toBe('Milotic');                             // leads untouched
    t.feed(parseBanner('The opposing Courtois used Trick Room!'));        // nickname → aliased slot
    const lines = t.flushPending({}, new Set())!;
    expect(lines).toContain('o1 > Trick Room > self');
  });
});

describe('panelBrightnessRatio — dim team-sheet regression (2026-07-24, all-Ice read as all-Steel)', () => {
  const flat = (mul: number): Frame => {
    const w = 480, h = 270;
    const data = new Uint8ClampedArray(w * h * 4);
    const [R, G, B] = CHAMPIONS_OPP_PANEL_BG;
    for (let p = 0; p < w * h; p++) {
      data[p * 4] = Math.round(R * mul); data[p * 4 + 1] = Math.round(G * mul);
      data[p * 4 + 2] = Math.round(B * mul); data[p * 4 + 3] = 255;
    }
    return { width: w, height: h, data, ts: 0 };
  };
  test('a bright panel reads ~1.0, a mid-fade panel well under the 0.85 gate', () => {
    expect(panelBrightnessRatio(flat(1))).toBeGreaterThan(0.95);
    expect(panelBrightnessRatio(flat(0.68))).toBeLessThan(0.75);   // the live dim frame measured 0.687
  });
});

describe('BattleStateMachine — live-match regressions', () => {
  let TS = 0;
  const mk = (text: string, plates: boolean, species: Partial<Record<SlotRef, string>> = {}): FrameRead => {
    const slot = (side: 'mine' | 'opp', index: 0 | 1, ref: SlotRef): SlotRead => ({
      side, index,
      species: species[ref] ?? null,
      speciesRaw: species[ref] ?? (plates ? LEADS[ref] : ''),
      speciesConfidence: species[ref] ? 1 : 0,
      hpFraction: plates ? 1 : null, status: null,
    });
    return { ts: TS++, battleText: text, slots: [slot('mine', 0, 'm1'), slot('mine', 1, 'm2'), slot('opp', 0, 'o1'), slot('opp', 1, 'o2')] };
  };

  test('a plate-less animation lull does NOT flush at gapFrames; the plate-visible select gap does', () => {
    TS = 0;
    const sm = new BattleStateMachine(LEADS, { gapFrames: 4, longGapFrames: 50, clearFrames: 2 });
    const out: TurnProposal[] = [];
    const feed = (fr: FrameRead) => { const p = sm.feed(fr); if (p && !p.partial) out.push(p); };
    feed(mk('Talonflame used Tailwind!', false));
    feed(mk('Talonflame used Tailwind!', false));
    for (let i = 0; i < 10; i++) feed(mk('', false));      // cinematic: no banner, no plates — 10 > gapFrames
    expect(out).toHaveLength(0);                            // old code chopped the turn here
    for (let i = 0; i < 4; i++) feed(mk('', true));         // select screen: plates visible
    expect(out).toHaveLength(1);
    expect(out[0]!.lines).toEqual(['m1 > Tailwind > self']);
  });

  test('confident plates contradicting the send-out banner order swap the pair BEFORE first emission', () => {
    TS = 0;
    const sm = new BattleStateMachine(LEADS, { gapFrames: 4, longGapFrames: 50, clearFrames: 2 });
    const out: TurnProposal[] = [];
    const feed = (fr: FrameRead) => { const p = sm.feed(fr); if (p && !p.partial) out.push(p); };
    // Plates read the OPPOSITE order of the banner-seeded roster (the live match's
    // opening: "sent out Charizard and Hawlucha!" with Hawlucha on plate 0).
    const swapped = { o1: 'Hawlucha', o2: 'Charizard' } as const;
    feed(mk('', true, swapped));
    feed(mk('', true, swapped));                            // 2 consecutive contradictions → swap
    feed(mk('The opposing Charizard used Heat Wave!', false));
    for (let i = 0; i < 4; i++) feed(mk('', true, swapped));
    expect(out).toHaveLength(1);
    // Charizard now resolves to o2 (its true plate slot) — every HP read stays aligned.
    expect(out[0]!.lines[0]).toMatch(/^o2 > Heat Wave/);
  });
});
