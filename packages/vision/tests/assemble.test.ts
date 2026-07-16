import { describe, test, expect } from 'vitest';
import { parseBanner } from '../src/bannerParse.js';
import { BattleAssembler } from '../src/assemble.js';

// Feed real banner lines end-to-end (parse → assemble) and check the turn-log lines.
const feed = (a: BattleAssembler, lines: string[]) => { for (const l of lines) a.feed(parseBanner(l)); };

describe('BattleAssembler — weather', () => {
  test('a weather banner (Drizzle/rain) emits a `weather rain` state line', () => {
    const a = new BattleAssembler({ m1: 'Talonflame', m2: 'Kingambit', o1: 'Pelipper', o2: 'Archaludon' });
    feed(a, [
      'The opposing Pelipper used Hurricane!',   // a move so the turn has content
      "It started to rain!",                      // weatherStart(rain)
    ]);
    expect(a.endTurnLines()).toContain('weather rain');
  });

  test('the REAL weather-end banner ("The rain stopped.") clears weather', () => {
    const a = new BattleAssembler({ m1: 'Talonflame', m2: 'Kingambit', o1: 'Pelipper', o2: 'Archaludon' });
    feed(a, ['The opposing Pelipper used Hurricane!', 'The rain stopped.']);
    expect(a.endTurnLines()).toContain('weather clear');
  });

  test('Tailwind + Trick Room (field moves) emit as targetless self actions', () => {
    const a = new BattleAssembler({ m1: 'Talonflame', m2: 'Kingambit', o1: 'Pelipper', o2: 'Hatterene' });
    feed(a, ['The opposing Pelipper used Tailwind!', 'The opposing Hatterene used Trick Room!']);
    expect(a.endTurnLines()).toEqual(['o1 > Tailwind > self', 'o2 > Trick Room > self']);
  });

  test('a nicknamed opponent resolves its move via the roster label (species-resolve gap)', () => {
    const a = new BattleAssembler({});
    feed(a, ['Vell sent out Fluffy!', 'The opposing Fluffy used Trick Room!']);
    expect(a.endTurnLines()).toEqual(['o1 > switch > Fluffy', 'o1 > Trick Room > self']);
  });
});

describe('BattleAssembler — opening turn (real Oni capture)', () => {
  test('resolves slots, attaches targets from follow-ups, emits turn-log lines', () => {
    const a = new BattleAssembler({ m1: 'Staraptor', m2: 'Grimmsnarl', o1: 'Raichu', o2: 'Sylveon' });
    feed(a, [
      'The opposing Raichu has Mega Evolved into Mega Raichu!',  // o1 mega pending
      'The opposing Raichu used Fake Out!',                      // o1 move (mega)
      "Staraptor flinched and couldn't move!",                  // → Fake Out hit m1
      'Grimmsnarl used Light Screen!',                          // m2 status
      'Staraptor used Close Combat!',                           // m1 move
      'The opposing Raichu fainted!',                           // → Close Combat hit o1 + ko
    ]);
    expect(a.endTurnLines()).toEqual([
      'o1+mega > Fake Out > m1',
      'm2 > Light Screen > self',
      'm1 > Close Combat > o1',
      'o1 ko',
    ]);
  });

  test('post-turn HP read fills the damage % on each targeted move', () => {
    const a = new BattleAssembler({ m1: 'Staraptor', m2: 'Grimmsnarl', o1: 'Raichu', o2: 'Sylveon' });
    feed(a, [
      'The opposing Raichu used Fake Out!',
      "Staraptor flinched and couldn't move!",       // Fake Out → m1
      'Staraptor used Close Combat!',
      'The opposing Raichu fainted!',                // Close Combat → o1 (KO)
    ]);
    // post-turn remaining HP%: Staraptor at 82, Raichu at 0 (fainted)
    expect(a.endTurnLines({ m1: 82, o1: 0 })).toEqual([
      'o1 > Fake Out > m1 > 82%',
      'm1 > Close Combat > o1 > 0',
      'o1 ko',
    ]);
  });
});

describe('BattleAssembler — fine-grained HP timeline (recordHp)', () => {
  test('per-action samples give each hit into the same target its own damage', () => {
    const a = new BattleAssembler({ m1: 'Staraptor', m2: 'Grimmsnarl', o1: 'Raichu', o2: 'Sylveon' });
    a.recordHp('o1', 100, true);
    feed(a, ['Staraptor used Close Combat!']);
    a.recordHp('o1', 60, true);                       // settled between the two banners
    feed(a, ['Grimmsnarl used Spirit Break!']);
    a.recordHp('o1', 35, true);
    // turn-final read alone would stamp 35 on BOTH moves (first hit merged, second 0 damage)
    expect(a.endTurnLines({ m1: 100, m2: 100, o1: 35, o2: 100 })).toEqual([
      'm1 > Close Combat > o1 > 60',
      'm2 > Spirit Break > o1 > 35',
    ]);
  });

  test('a settled read beats a later lone raw blip in the same window', () => {
    const a = new BattleAssembler({ m1: 'Staraptor', m2: 'Grimmsnarl', o1: 'Raichu', o2: 'Sylveon' });
    a.recordHp('o1', 100, true);
    feed(a, ['Staraptor used Close Combat!']);
    a.recordHp('o1', 60, true);                       // settled
    a.recordHp('o1', 55, false);                      // one-frame OCR blip — must not win
    expect(a.endTurnLines({ o1: 55 })).toEqual(['m1 > Close Combat > o1 > 60']);
  });

  test('allAdjacent spread (Earthquake) hits both foes + ally, % on the mine-side entry', () => {
    const a = new BattleAssembler({ m1: 'Garchomp', m2: 'Kingambit', o1: 'Raichu', o2: 'Sylveon' });
    for (const r of ['m1', 'm2', 'o1', 'o2'] as const) a.recordHp(r, 100, true);
    feed(a, ['Garchomp used Earthquake!']);
    a.recordHp('o1', 70, true); a.recordHp('o2', 75, true); a.recordHp('m2', 80, true);
    expect(a.endTurnLines()).toEqual(['m1 > Earthquake > spread > o1:70, o2:75, m2:80%']);
  });

  test('spread move that only one foe survives visible falls back to single-target', () => {
    const a = new BattleAssembler({ m1: 'Staraptor', m2: 'Grimmsnarl', o1: 'Raichu', o2: 'Sylveon' });
    for (const r of ['o1', 'o2'] as const) a.recordHp(r, 100, true);
    feed(a, ['Staraptor used Heat Wave!']);
    a.recordHp('o1', 70, true);                       // o2 Protected / no drop observed
    expect(a.endTurnLines({ o1: 70, o2: 100 })).toEqual(['m1 > Heat Wave > o1 > 70']);
  });

  test('a second effectiveness line converts a pinned spread move to per-target spread', () => {
    const a = new BattleAssembler({ m1: 'Garchomp', m2: 'Dragonite', o1: 'Ninetales', o2: 'Politoed' });
    feed(a, [
      'The opposing Ninetales used Blizzard!',
      "It's super effective on Garchomp!",            // pins m1
      "It's super effective on Dragonite!",           // second name → convert to spread
    ]);
    expect(a.endTurnLines({ m1: 40, m2: 55 })).toEqual(['o1 > Blizzard > spread > m1:40%, m2:55%']);
  });

  test('flinch-pinned Rock Slide still captures the other foe via its window drop', () => {
    const a = new BattleAssembler({ m1: 'Garchomp', m2: 'Kingambit', o1: 'Raichu', o2: 'Sylveon' });
    for (const r of ['o1', 'o2'] as const) a.recordHp(r, 100, true);
    feed(a, ['Garchomp used Rock Slide!', "The opposing Raichu flinched and couldn't move!"]);
    a.recordHp('o1', 70, true); a.recordHp('o2', 60, true);
    expect(a.endTurnLines({ o1: 70, o2: 60 })).toEqual(['m1 > Rock Slide > spread > o1:70, o2:60']);
  });

  test('mine-side raw samples flow through to raw emission', () => {
    const a = new BattleAssembler({ m1: 'Staraptor', m2: 'Grimmsnarl', o1: 'Raichu', o2: 'Sylveon' });
    a.recordHp('m1', 100, true, 175);
    feed(a, ['The opposing Raichu used Fake Out!', "Staraptor flinched and couldn't move!"]);
    a.recordHp('m1', 82, true, 144);
    expect(a.endTurnLines({ m1: 82 })).toEqual(['o1 > Fake Out > m1 > 144']);
  });

  test('a Protected foe with a residual chip is NOT swept into a spread hit', () => {
    const a = new BattleAssembler({ m1: 'Staraptor', m2: 'Grimmsnarl', o1: 'Raichu', o2: 'Sylveon' });
    for (const r of ['o1', 'o2'] as const) a.recordHp(r, 100, true);
    feed(a, ['The opposing Sylveon protected itself!', 'Staraptor used Heat Wave!']);
    a.recordHp('o1', 70, true);
    a.recordHp('o2', 94, true);                       // sandstorm chip on the Protect user
    expect(a.endTurnLines({ o1: 70, o2: 94 })).toEqual(['m1 > Heat Wave > o1 > 70']);
  });
});

// Banner RE-FIRES (OCR drops a persisting banner for 2 frames, the clear window
// expires, the same banner parses again) doubled real events in the 2026-06-20
// replay: switch pairs ×4, Acrobatics ×2, `m2 ko` ×2, `-2 spa` ×3.
describe('BattleAssembler — banner re-fire dedupe (live replay bugs)', () => {
  const LEADS = { m1: 'Talonflame', m2: 'Kingambit', o1: 'Garchomp', o2: 'Sinistcha' };

  test('a re-fired move banner does not double the action', () => {
    const a = new BattleAssembler(LEADS);
    feed(a, ['Talonflame used Acrobatics!', 'Talonflame used Acrobatics!']);
    expect(a.endTurnLines({ o1: 58 }).filter(l => l.includes('Acrobatics'))).toHaveLength(1);
  });

  test('a re-fired send-out banner does not double the switch', () => {
    const a = new BattleAssembler({ ...LEADS, m1: null as unknown as string });
    feed(a, ['Go! Dragonite!', 'Go! Dragonite!']);
    expect(a.endTurnLines().filter(l => l.includes('switch'))).toEqual(['m1 > switch > Dragonite']);
  });

  test('slot-OCR seeding racing the send-out banner does NOT eat the switch line', () => {
    // The per-frame species OCR can fill the roster BEFORE the send-out banner
    // parses; that must still emit the switch (deduping on roster made real
    // send-outs vanish in the 2026-06-20 replay).
    const a = new BattleAssembler({});
    a.seedActiveIfUnknown('m1', 'Kingambit');
    feed(a, ['Go! Kingambit!', 'Go! Kingambit!']);          // banner + a re-fire
    expect(a.endTurnLines().filter(l => l.includes('switch'))).toEqual(['m1 > switch > Kingambit']);
  });

  test('a re-fired faint banner does not double the ko (even after a roster re-seed)', () => {
    const a = new BattleAssembler(LEADS);
    feed(a, ['The opposing Garchomp used Dragon Claw!', 'Kingambit fainted!']);
    a.seedActiveIfUnknown('m2', 'Kingambit');           // plate lingers → slot OCR re-seeds
    feed(a, ['Kingambit fainted!']);
    expect(a.endTurnLines().filter(l => l === 'm2 ko')).toHaveLength(1);
  });

  test('a re-fired stat-change banner does not triple the state line', () => {
    const a = new BattleAssembler(LEADS);
    feed(a, [
      'Kingambit used Kowtow Cleave!',
      "Kingambit's Sp. Atk harshly fell!",
      "Kingambit's Sp. Atk harshly fell!",
      "Kingambit's Sp. Atk harshly fell!",
    ]);
    expect(a.endTurnLines({ o1: 49 }).filter(l => l === 'm2 -2 spa')).toHaveLength(1);
  });
});

describe('BattleAssembler — Protect blocks the damage observation', () => {
  test('a move into a Protected target keeps the target but emits NO damage slot', () => {
    const a = new BattleAssembler({ m1: 'Pelipper', m2: 'Dragonite', o1: 'Charizard', o2: 'Garchomp' });
    feed(a, [
      'The opposing Charizard protected itself!',
      'Dragonite used Hurricane!',
      "It's super effective on Charizard!",           // named → pinned to the Protect user
    ]);
    // `> o1 > 100` would be a 0-damage observation — poison for the spread solver.
    expect(a.endTurnLines({ o1: 100 })).toEqual(['m2 > Hurricane > o1']);
  });

  test('a missed move keeps its target but emits NO damage slot', () => {
    // Seen live: a dodged Solar Beam emitted `o1 > Solar Beam > m1 > 100%` — a
    // 0-damage observation the spread solver would choke on.
    const a = new BattleAssembler({ m1: 'Talonflame', m2: 'Kingambit', o1: 'Charizard', o2: 'Garchomp' });
    feed(a, ['The opposing Charizard used Solar Beam!', 'Talonflame avoided the attack!']);
    expect(a.endTurnLines({ m1: 100 })).toEqual(['o1 > Solar Beam > m1']);
  });

  test('zero-drop guard: an unexplained no-damage hit is suppressed once a baseline exists', () => {
    // Miss banner not OCR'd: the target's HP never moved across the whole turn. With a
    // known pre-turn baseline that's a 0-damage observation — suppress. (hpBefore is
    // the 2nd arg to endTurnLines — a previous turn closed knowing m1's HP.)
    const a = new BattleAssembler({ m1: 'Talonflame', m2: 'Kingambit', o1: 'Charizard', o2: 'Garchomp' });
    a.recordHp('m1', 100, true);
    feed(a, ['The opposing Charizard used Solar Beam!', "It's super effective on Talonflame!"]);
    a.recordHp('m1', 100, true);
    expect(a.endTurnLines({ m1: 100 }, { m1: 100 })).toEqual(['o1 > Solar Beam > m1']);
  });

  test('zero-drop guard does NOT fire without a baseline (mid-battle join state sync)', () => {
    const a = new BattleAssembler({ m1: 'Talonflame', m2: 'Kingambit', o1: 'Charizard', o2: 'Garchomp' });
    a.recordHp('m1', 9, true);            // reader joined late — 9 is all it ever saw
    feed(a, ['The opposing Charizard used Solar Beam!', "It's super effective on Talonflame!"]);
    a.recordHp('m1', 9, true);
    expect(a.endTurnLines({ m1: 9 })).toEqual(['o1 > Solar Beam > m1 > 9%']);   // state sync kept
  });

  test('a spread hit drops the Protected ref and keeps the real ones', () => {
    const a = new BattleAssembler({ m1: 'Pelipper', m2: 'Dragonite', o1: 'Charizard', o2: 'Garchomp' });
    for (const r of ['o1', 'o2'] as const) a.recordHp(r, 100, true);
    feed(a, ['The opposing Charizard protected itself!', 'Pelipper used Hurricane!']);
    a.recordHp('o2', 60, true);                        // only the unprotected foe dropped
    expect(a.endTurnLines({ o1: 100, o2: 60 })).toEqual(['m1 > Hurricane > o2 > 60']);
  });
});

describe('BattleAssembler — crits & status', () => {
  test('a named crit banner tags the move AND pins the target', () => {
    const a = new BattleAssembler({ m1: 'Staraptor', m2: 'Grimmsnarl', o1: 'Raichu', o2: 'Sylveon' });
    feed(a, ['Staraptor used Close Combat!', 'A critical hit on the opposing Raichu!']);
    expect(a.endTurnLines({ o1: 40 })).toEqual(['m1+crit > Close Combat > o1 > 40']);
  });

  test('the bare crit banner tags the most recent DAMAGING move', () => {
    const a = new BattleAssembler({ m1: 'Staraptor', m2: 'Grimmsnarl', o1: 'Raichu', o2: 'Sylveon' });
    feed(a, ['Staraptor used Close Combat!', 'Grimmsnarl used Light Screen!', 'A critical hit!']);
    expect(a.endTurnLines({ o1: 40 })).toEqual([
      'm1+crit > Close Combat > o1 > 40',       // Light Screen (status) skipped — crits only come off damaging moves
      'm2 > Light Screen > self',
    ]);
  });

  test('status banners emit the canonical state lines', () => {
    const a = new BattleAssembler({ m1: 'Staraptor', m2: 'Grimmsnarl', o1: 'Raichu', o2: 'Sylveon' });
    feed(a, [
      'The opposing Raichu used Will-O-Wisp!',
      'Staraptor was burned!',
      'The opposing Sylveon used Toxic!',
      'Grimmsnarl was badly poisoned!',
    ]);
    const lines = a.endTurnLines();
    expect(lines).toContain('m1 brn');
    expect(lines).toContain('m2 tox');
  });

  test('paralysis from a secondary (Nuzzle-style) lands as a state line too', () => {
    const a = new BattleAssembler({ m1: 'Staraptor', m2: 'Grimmsnarl', o1: 'Raichu', o2: 'Sylveon' });
    feed(a, ['The opposing Raichu used Thunder Wave!', 'Staraptor is paralyzed!']);
    expect(a.endTurnLines()).toContain('m1 par');
  });
});

describe('BattleAssembler — slot resolution & roster', () => {
  test('picks the correct same-side slot by species', () => {
    const a = new BattleAssembler({ m1: 'Staraptor', m2: 'Grimmsnarl', o1: 'Raichu', o2: 'Sylveon' });
    feed(a, ['The opposing Sylveon used Hyper Voice!']);
    expect(a.endTurnLines()).toEqual(['o2 > Hyper Voice > m1']);   // o2 actor; offensive, no naming banner → defaults to a foe
  });

  test('a switch updates the roster and emits a switch line', () => {
    const a = new BattleAssembler({ m1: 'Staraptor', m2: 'Grimmsnarl', o1: 'Raichu', o2: 'Sylveon' });
    feed(a, ['Grimmsnarl went back to Kaglish!', 'Go! Sinistcha the Rank Master!']);
    expect(a.getRoster().m2).toBe('Sinistcha');                      // freed slot refilled
    expect(a.endTurnLines()).toEqual(['m2 > switch > Sinistcha']);
  });

  test('mega flag attaches to the actor that megas, then moves', () => {
    const a = new BattleAssembler({ m1: 'Staraptor', m2: 'Whimsicott', o1: 'Aerodactyl', o2: 'Sylveon' });
    feed(a, ['Staraptor has Mega Evolved into Mega Staraptor!', 'Staraptor used Close Combat!']);
    expect(a.endTurnLines()).toEqual(['m1+mega > Close Combat > o1']);   // offensive → foe (mega flag preserved)
  });

  test('an unresolved species is noted, not crashed', () => {
    const a = new BattleAssembler({ m1: 'Staraptor', m2: 'Grimmsnarl', o1: 'Raichu', o2: 'Sylveon' });
    feed(a, ['The opposing Garchomp used Earthquake!']);            // Garchomp not active
    const obs = a.endTurn();
    expect(obs.actions).toHaveLength(0);
    expect(obs.notes.join(' ')).toMatch(/unresolved.*Garchomp/i);
  });
});
