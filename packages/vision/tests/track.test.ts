import { describe, test, expect } from 'vitest';
import { parseBanner } from '../src/bannerParse.js';
import { segmentEvents, assembleMatch, BattleTracker } from '../src/track.js';

// The real captured Oni timeline (two turns, split by the sandstorm EOT cluster).
const RAW = [
  "The opposing Raichu's Raichunite Y is reacting to Oni's Omni Ring!",
  'The opposing Raichu has Mega Evolved into Mega Raichu!',
  'The opposing Raichu used Fake Out!',
  'Grimmsnarl used Light Screen!',
  'Light Screen made your side stronger against special moves!',
  "Staraptor flinched and couldn't move!",
  'The opposing Raichu is buffeted by the sandstorm!',
  'Grimmsnarl is buffeted by the sandstorm!',
  // ── turn boundary ──
  'Grimmsnarl used Parting Shot!',
  'Grimmsnarl went back to Kaglish!',
  'Go! Sinistcha the Rank Master!',
  'Staraptor drank down all the matcha that Sinistcha made!',
  'Staraptor used Close Combat!',
  'The opposing Raichu fainted!',
  'The opposing Sylveon used Hyper Voice!',
  "It's super effective on Staraptor!",
  'The opposing Sylveon is buffeted by the sandstorm!',
];
const EVENTS = RAW.map(parseBanner);
const LEADS = { m1: 'Staraptor', m2: 'Grimmsnarl', o1: 'Raichu', o2: 'Sylveon' };

describe('segmentEvents', () => {
  test('splits the real stream into 2 turns at the residual→action boundary', () => {
    const turns = segmentEvents(EVENTS);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.at(-1)!.kind).toBe('weather');                 // turn 1 ends on the EOT cluster
    expect(turns[1]![0]).toMatchObject({ kind: 'move', move: 'Parting Shot' }); // turn 2 opens with the next action
  });

  test('a stream with no residuals stays one turn (needs frame-gap signal)', () => {
    const ev = ['Staraptor used Close Combat!', 'The opposing Raichu used Fake Out!'].map(parseBanner);
    expect(segmentEvents(ev)).toHaveLength(1);
  });
});

describe('assembleMatch — full timeline → per-turn turn-log lines', () => {
  test('reconstructs both turns with persistent roster', () => {
    const turns = assembleMatch(EVENTS, LEADS);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual([
      'o1+mega > Fake Out > m1',
      'm2 > Light Screen > self',
    ]);
    expect(turns[1]).toEqual([
      'm2 > Parting Shot > self',
      'm2 > switch > Sinistcha',
      'm1 > Close Combat > o1',
      'o2 > Hyper Voice > m1',
      'o1 ko',
    ]);
  });

  test('the roster carries the switch across turns (Grimmsnarl → Sinistcha)', () => {
    const t = new BattleTracker(LEADS);
    for (const e of EVENTS) t.feed(e);
    expect(t.getRoster().m2).toBe('Sinistcha');
  });
});
