import { describe, test, expect } from 'vitest';
import { parseBanner } from '../src/bannerParse.js';
import { BattleAssembler } from '../src/assemble.js';

// Feed real banner lines end-to-end (parse → assemble) and check the turn-log lines.
const feed = (a: BattleAssembler, lines: string[]) => { for (const l of lines) a.feed(parseBanner(l)); };

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
});

describe('BattleAssembler — slot resolution & roster', () => {
  test('picks the correct same-side slot by species', () => {
    const a = new BattleAssembler({ m1: 'Staraptor', m2: 'Grimmsnarl', o1: 'Raichu', o2: 'Sylveon' });
    feed(a, ['The opposing Sylveon used Hyper Voice!']);
    expect(a.endTurnLines()).toEqual(['o2 > Hyper Voice > self']);   // o2, not o1
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
    expect(a.endTurnLines()).toEqual(['m1+mega > Close Combat > self']);
  });

  test('an unresolved species is noted, not crashed', () => {
    const a = new BattleAssembler({ m1: 'Staraptor', m2: 'Grimmsnarl', o1: 'Raichu', o2: 'Sylveon' });
    feed(a, ['The opposing Garchomp used Earthquake!']);            // Garchomp not active
    const obs = a.endTurn();
    expect(obs.actions).toHaveLength(0);
    expect(obs.notes.join(' ')).toMatch(/unresolved.*Garchomp/i);
  });
});
