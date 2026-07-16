import { describe, test, expect } from 'vitest';

describe('parseBanner — critical hits', () => {
  test('bare singles form has no named target', () => {
    expect(parseBanner('A critical hit!')).toEqual({ kind: 'crit', side: null, label: null, species: null });
  });
  test('doubles form names the target, side-aware', () => {
    expect(parseBanner('A critical hit on the opposing Raichu!')).toMatchObject({ kind: 'crit', side: 'opp', species: 'Raichu' });
    expect(parseBanner('A critical hit on Dragonite!')).toMatchObject({ kind: 'crit', side: 'mine', species: 'Dragonite' });
  });
});
import { parseBanner, repairOcr, type BattleMessage } from '../src/bannerParse.js';

// Every line below is a REAL OCR'd banner from the captured Oni match (some carry
// the f-ligature OCR error on purpose — the parser must recover them).

describe('repairOcr', () => {
  test('snaps the systematic f-ligature errors back', () => {
    expect(repairOcr('Raichu tainted!')).toBe('Raichu fainted!');
    expect(repairOcr("Staraptor tlinched and couldn't move!")).toBe("Staraptor flinched and couldn't move!");
    expect(repairOcr("It's super ettective on Staraptor!")).toBe("It's super effective on Staraptor!");
    expect(repairOcr('Raichu is butteted by the sandstorm!')).toBe('Raichu is buffeted by the sandstorm!');
    expect(repairOcr('ended due to a torteit.')).toBe('ended due to a forfeit.');
  });
});

describe('parseBanner — side & action', () => {
  const cases: [string, Partial<BattleMessage> & { kind: BattleMessage['kind'] }][] = [
    ['The opposing Raichu used Fake Out!', { kind: 'move', side: 'opp', species: 'Raichu', move: 'Fake Out' }],
    ['Grimmsnarl used Light Screen!', { kind: 'move', side: 'mine', species: 'Grimmsnarl', move: 'Light Screen' }],
    ['Staraptor used Close Combat!', { kind: 'move', side: 'mine', species: 'Staraptor', move: 'Close Combat' }],
    ['The opposing Sylveon used Hyper Voice!', { kind: 'move', side: 'opp', species: 'Sylveon', move: 'Hyper Voice' }],
    ['The opposing Raichu has Mega Evolved into Mega Raichu!', { kind: 'mega', side: 'opp', species: 'Raichu' }],
    ["The opposing Raichu's Raichunite Y is reacting to Oni's Omni Ring!", { kind: 'megaReact', side: 'opp', species: 'Raichu', item: 'Raichunite Y' }],
    ['The opposing Raichu tainted!', { kind: 'faint', side: 'opp', species: 'Raichu' }],
    ['The opposing Raichu fainted!', { kind: 'faint', side: 'opp', species: 'Raichu' }],
  ];
  for (const [raw, want] of cases) {
    test(raw, () => expect(parseBanner(raw)).toMatchObject(want));
  }
});

describe('parseBanner — switches (nicknames in the wild)', () => {
  test('"X went back to <Trainer>!" → switchOut', () => {
    expect(parseBanner('Grimmsnarl went back to Kaglish!')).toMatchObject({ kind: 'switchOut', side: 'mine', species: 'Grimmsnarl', trainer: 'Kaglish' });
  });
  test('"X, come back!" (player recall, no trainer) → switchOut mine', () => {
    const r = parseBanner('Kingambit, come back!');
    expect(r).toMatchObject({ kind: 'switchOut', side: 'mine', species: 'Kingambit' });
    if (r.kind === 'switchOut') expect(r.trainer).toBeUndefined();
  });
  test('"Go! <species> the <nickname>!" → switchIn with nickname', () => {
    expect(parseBanner('Go! Sinistcha the Rank Master!')).toMatchObject({ kind: 'switchIn', side: 'mine', species: 'Sinistcha', nickname: 'Rank Master' });
  });
  test('a pure custom nickname yields species=null (resolve by appearance)', () => {
    const r = parseBanner('Go! Destroyer9000!');
    expect(r.kind).toBe('switchIn');
    if (r.kind === 'switchIn') { expect(r.species).toBeNull(); expect(r.label).toBe('Destroyer9000'); }
  });
  test('"<Trainer> sent out X!" → opp switchIn', () => {
    expect(parseBanner('Oni sent out Garchomp!')).toMatchObject({ kind: 'switchIn', side: 'opp', species: 'Garchomp', trainer: 'Oni' });
  });
  test('recovers species embedded in an opp send-out nickname (real capture)', () => {
    // "Stephan sent out Sylveon of the Distant Past!" — nickname embeds the species.
    expect(parseBanner('Stephan sent out Sylveon of the Distant Past!')).toMatchObject({ kind: 'switchIn', side: 'opp', species: 'Sylveon', trainer: 'Stephan' });
  });
});

describe('parseBanner — status / field / effectiveness', () => {
  test('flinch (ligature-repaired)', () => {
    expect(parseBanner("Staraptor tlinched and couldn't move!")).toMatchObject({ kind: 'flinch', side: 'mine', species: 'Staraptor' });
  });
  test('weather buffet (ligature-repaired, opp side)', () => {
    expect(parseBanner('The opposing Raichu is butteted by the sandstorm!')).toMatchObject({ kind: 'weather', side: 'opp', species: 'Raichu', weather: 'sandstorm' });
  });
  test('stat change with multiple stats', () => {
    expect(parseBanner("Staraptor's Attack and Sp. Atk rose!")).toMatchObject({ kind: 'statChange', side: 'mine', species: 'Staraptor', stats: ['Attack', 'Sp. Atk'], dir: 'rose' });
  });
  test('effectiveness (ligature-repaired) keeps the target side', () => {
    expect(parseBanner("It's super ettective on Staraptor!")).toMatchObject({ kind: 'effectiveness', level: 'super', side: 'mine', species: 'Staraptor' });
  });
  test('Champions Matcha Gotcha heal flavor', () => {
    expect(parseBanner('Staraptor drank down all the matcha that Sinistcha made!')).toMatchObject({ kind: 'heal', side: 'mine', species: 'Staraptor', source: 'Sinistcha' });
  });
  test('Light Screen field message', () => {
    expect(parseBanner('Light Screen made your side stronger against special moves!')).toMatchObject({ kind: 'screen', screen: 'Light Screen' });
  });
});

describe('parseBanner — protect & status (real captures + standard wording)', () => {
  test('"X protected itself!" → protect (mine)', () => {
    expect(parseBanner('Dragonite protected itself!')).toMatchObject({ kind: 'protect', side: 'mine', species: 'Dragonite' });
  });
  test('"The opposing X protected itself!" → protect (opp)', () => {
    expect(parseBanner('The opposing Charizard protected itself!')).toMatchObject({ kind: 'protect', side: 'opp', species: 'Charizard' });
  });
  test('confusion (real capture) → status', () => {
    expect(parseBanner('The opposing Incineroar is confused!')).toMatchObject({ kind: 'status', side: 'opp', species: 'Incineroar', status: 'confusion' });
  });
  test('"X fell asleep!" → status sleep (not a stat-change "fell")', () => {
    expect(parseBanner('Garchomp fell asleep!')).toMatchObject({ kind: 'status', side: 'mine', species: 'Garchomp', status: 'sleep' });
  });
  test('"badly poisoned" resolves to toxic, not poison', () => {
    expect(parseBanner('The opposing Garchomp was badly poisoned!')).toMatchObject({ kind: 'status', side: 'opp', species: 'Garchomp', status: 'toxic' });
    expect(parseBanner('Garchomp was poisoned!')).toMatchObject({ kind: 'status', side: 'mine', species: 'Garchomp', status: 'poison' });
  });
});

describe('parseBanner — self-inflicted HP loss (real captures)', () => {
  test('confusion self-hit names no mon → sideless confusionHit', () => {
    expect(parseBanner('It hurt itself in its confusion!')).toMatchObject({ kind: 'confusionHit' });
  });
  test('"X lost some of its HP!" → hpLoss (opp)', () => {
    expect(parseBanner('The opposing Garchomp lost some of its HP!')).toMatchObject({ kind: 'hpLoss', side: 'opp', species: 'Garchomp' });
  });
  test('"X lost some of its HP!" → hpLoss (mine)', () => {
    expect(parseBanner('Dragonite lost some of its HP!')).toMatchObject({ kind: 'hpLoss', side: 'mine', species: 'Dragonite' });
  });
});

describe('parseBanner — terminal states', () => {
  test('forfeit (ligature-repaired)', () => {
    expect(parseBanner('The battle has ended due to a torteit.')).toMatchObject({ kind: 'end', reason: 'forfeit' });
  });
  test('win', () => {
    expect(parseBanner('You defeated Oni!')).toMatchObject({ kind: 'end', reason: 'win', trainer: 'Oni' });
  });
  test('animation-frame garbage → unknown', () => {
    expect(parseBanner('Ca rf QUSY BN').kind).toBe('unknown');
  });
});
