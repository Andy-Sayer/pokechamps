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
    // The nickname tracks the SLOT (the move resolves), but its switch line is
    // suppressed — `o1 > switch > Fluffy` would choke the parser (no such species).
    expect(a.endTurnLines()).toEqual(['o1 > Trick Room > self']);
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

// Confusion self-damage. Banner wording is VERBATIM from the archived live trace
// (fixtures/live-debug-archive-231556): the game prints "X is confused!" immediately
// before the sideless "It hurt itself in its confusion!", which is what makes the
// self-hit attributable at all.
describe('BattleAssembler — confusion self-damage', () => {
  const ROSTER = { m1: 'Talonflame', m2: 'Kingambit', o1: 'Pelipper', o2: 'Archaludon' };

  test('the self-hit is not billed to an untargeted foe move, and HP is synced instead', () => {
    const a = new BattleAssembler(ROSTER);
    // The sharp case: NO per-frame samples (so per-action windows can't help) and an
    // offensive move whose target the banner never named. o1 self-hits for 35 while the
    // real victim o2 loses 10 — the turn-scoped "biggest HP drop" signal would hand the
    // move to o1 on drop size alone, inventing a 35% damage observation on a mon nobody
    // attacked. That is the exact inference poison this reconciler exists to stop.
    // Order matters: the confused mon moves FIRST, so its self-hit lands before any
    // action exists to window-scope it. Only the turn-scoped guard can catch this one.
    feed(a, [
      'The opposing Pelipper is confused!',
      'It hurt itself in its confusion!',
      'Talonflame used Brave Bird!',
    ]);
    const lines = a.endTurnLines({ o1: 65, o2: 90 }, { o1: 100, o2: 100 });
    expect(lines).toContain('m1 > Brave Bird > o2 > 90');
    expect(lines.some(l => /Brave Bird > o1/.test(l))).toBe(false);
    // The 35 isn't lost, it's just billed to nobody — the sync line carries it.
    expect(lines).toContain('hp o1=65');
  });

  test("a foe move in the SAME turn keeps its own window's damage", () => {
    const a = new BattleAssembler(ROSTER);
    a.recordHp('o1', 100, true);
    feed(a, ['The opposing Pelipper is confused!', 'It hurt itself in its confusion!']);
    a.recordHp('o1', 82, true);                       // self-hit window
    feed(a, ['Talonflame used Brave Bird!']);
    a.recordHp('o1', 30, true);                       // Brave Bird's own window
    const lines = a.endTurnLines({ o1: 30 }, { o1: 100 });
    // Brave Bird is billed 82→30, NOT 100→30: the self-hit sits in the prior window.
    expect(lines).toContain('m1 > Brave Bird > o1 > 30');
  });

  test('confusion is a volatile — it does not follow the slot to a new occupant', () => {
    const a = new BattleAssembler(ROSTER);
    feed(a, ['The opposing Pelipper became confused!']);
    a.endTurn();
    feed(a, ['The opposing Pelipper went back to Vell!', 'Vell sent out Kingdra!']);
    a.endTurn();
    // A sideless self-hit now has nobody to attribute to → flagged, never guessed onto
    // the slot's NEW tenant.
    feed(a, ['It hurt itself in its confusion!']);
    const obs = a.endTurn({ o1: 70 }, { o1: 100 });
    expect(obs.notes.some(n => /unattributed/.test(n))).toBe(true);
    expect(obs.stateLines ?? []).not.toContain('hp o1=70');
  });

  test('the INFLICTION line pins the confusing move\'s target; the reminder does not', () => {
    // Verbatim from the archived live match (f4881-4908), including the species clash —
    // BOTH sides had a Pelipper. The opposing Pelipper's Hurricane hit mine and confused
    // it, so the target is real data even though no effectiveness line was printed.
    // Suppressing the self-damage without this pin pushed Hurricane onto m1 instead.
    const a = new BattleAssembler({ m1: 'Dragonite', m2: 'Pelipper', o1: 'Pelipper', o2: 'Swampert' });
    feed(a, [
      'The opposing Swampert used Waterfall!',
      "It's not very effective on Dragonite.",
      'The opposing Pelipper used Hurricane!',
      'Pelipper became confused!',          // infliction → names who Hurricane hit
      'Pelipper is confused!',              // per-turn nag → names who is about to act
      'It hurt itself in its confusion!',
    ]);
    const lines = a.endTurnLines({ m1: 17, m2: 33 }, { m1: 40, m2: 100 });
    expect(lines).toContain('o1 > Hurricane > m2');   // right target, no damage slot
    expect(lines.some(l => /Hurricane > m1/.test(l))).toBe(false);
    expect(lines).toContain('hp m2=33%');
  });

  test('a mine-side self-hit syncs RAW on-screen HP, not a percent', () => {
    const a = new BattleAssembler(ROSTER);
    feed(a, ['Talonflame is confused!', 'It hurt itself in its confusion!']);
    a.recordHp('m1', 62, true, 109);                  // "109/175" on the nameplate
    expect(a.endTurnLines({ m1: 62 }, { m1: 100 })).toContain('hp m1=109');
  });
});

// A status INFLICTION names who the move hit. Will-O-Wisp and Thunder Wave print no
// effectiveness line, so this is often the only target evidence in the whole turn —
// without it those moves emitted `> self` and the engine learned nothing about the aim.
describe('BattleAssembler — status inflictions pin the target', () => {
  const ROSTER = { m1: 'Talonflame', m2: 'Kingambit', o1: 'Rotom-Wash', o2: 'Amoonguss' };

  test('"X was burned!" pins the Will-O-Wisp that caused it', () => {
    const a = new BattleAssembler(ROSTER);
    feed(a, ['The opposing Rotom-Wash used Will-O-Wisp!', 'Kingambit was burned!']);
    expect(a.endTurnLines()).toContain('o1 > Will-O-Wisp > m2');
  });

  test('paralysis pins Thunder Wave the same way', () => {
    const a = new BattleAssembler(ROSTER);
    feed(a, ['The opposing Rotom-Wash used Thunder Wave!', 'Talonflame is paralyzed! It may be unable to move!']);
    expect(a.endTurnLines()).toContain('o1 > Thunder Wave > m1');
  });

  test('REST does not pin — it sleeps its own user, not a foe\'s target', () => {
    const a = new BattleAssembler(ROSTER);
    feed(a, ['The opposing Rotom-Wash used Hydro Pump!', 'Kingambit used Rest!', 'Kingambit fell asleep!']);
    const lines = a.endTurnLines();
    // Hydro Pump must NOT be credited with putting Kingambit to sleep.
    expect(lines.some(l => /Hydro Pump > m2/.test(l))).toBe(false);
    expect(lines).toContain('m2 slp');
  });

  test('a CONTACT attacker burned by the defender\'s ability does not pin either', () => {
    // Flame Body / Static punish the attacker; the status names my mon but the foe's
    // move never targeted it.
    const a = new BattleAssembler(ROSTER);
    // The foe's move here is SELF-targeting so the ordinary target-inference pass can't
    // claim m1 either — otherwise this test would pass or fail for reasons that have
    // nothing to do with the status pin (the first cut used Pollen Puff, an offensive
    // move, and the default-target pass claimed m1 regardless of the guard).
    feed(a, ['The opposing Amoonguss used Tailwind!', 'Talonflame used Brave Bird!', 'Talonflame was burned!']);
    const lines = a.endTurnLines();
    expect(lines).toContain('o2 > Tailwind > self');   // never repointed at m1
    expect(lines).toContain('m1 brn');                  // …but the burn is still recorded
  });

  test('the state line is still emitted in every case', () => {
    const a = new BattleAssembler(ROSTER);
    feed(a, ['The opposing Rotom-Wash used Will-O-Wisp!', 'Kingambit was burned!']);
    expect(a.endTurnLines()).toContain('m2 brn');
  });
});

describe('BattleAssembler — side-wide guard suppresses damage on BOTH slots', () => {
  test('a spread into a Wide Guarded side emits no damage', () => {
    const a = new BattleAssembler({ m1: 'Garchomp', m2: 'Kingambit', o1: 'Raichu', o2: 'Sylveon' });
    for (const r of ['o1', 'o2'] as const) a.recordHp(r, 100, true);
    feed(a, [
      'The opposing Raichu used Wide Guard!',
      'Wide Guard now protects the opposing side!',
      'Garchomp used Rock Slide!',
    ]);
    // Residual/animation noise must not become a damage observation on either slot.
    a.recordHp('o1', 97, true); a.recordHp('o2', 96, true);
    const lines = a.endTurnLines({ o1: 97, o2: 96 });
    expect(lines.some(l => /Rock Slide > (spread|o1|o2).*\d/.test(l))).toBe(false);
  });
});

describe('BattleAssembler — perish clock', () => {
  test('the count becomes a state line the engine can tick', () => {
    const a = new BattleAssembler({ m1: 'Garchomp', m2: 'Dragonite', o1: 'Gengar', o2: 'Blastoise' });
    feed(a, [
      'The opposing Gengar used Perish Song!',
      'The opposing Gengar’s perish count fell to 2!',
      'Garchomp’s perish count fell to 2!',
    ]);
    const lines = a.endTurnLines();
    expect(lines).toContain('o1 perish 2');
    expect(lines).toContain('m1 perish 2');
  });

  test('the lethal turn is reported as 0', () => {
    const a = new BattleAssembler({ m1: 'Garchomp', m2: 'Dragonite', o1: 'Gengar', o2: 'Blastoise' });
    feed(a, ['The opposing Gengar used Protect!', "Garchomp's perish count fell to 0!"]);
    expect(a.endTurnLines()).toContain('m1 perish 0');
  });
});
