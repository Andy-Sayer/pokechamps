import { describe, test, expect } from 'vitest';
import { similarity, bestMatch, matchSpecies, matchMove } from '../src/fuzzyMatch.js';

describe('similarity', () => {
  test('identical (after normalise) = 1; unrelated is low', () => {
    expect(similarity('Garchomp', 'garchomp')).toBe(1);
    expect(similarity('Close Combat', 'close-combat')).toBe(1);
    expect(similarity('Garchomp', 'Pikachu')).toBeLessThan(0.4);
  });
});

describe('matchSpecies (against the legal Champions list)', () => {
  test('clean name resolves exactly', () => {
    const m = matchSpecies('Garchomp');
    expect(m?.id).toBe('garchomp');
    expect(m?.score).toBe(1);
  });
  test('OCR typos still resolve to the right species', () => {
    expect(matchSpecies('Charizrd')?.id).toBe('charizard');   // dropped char
    expect(matchSpecies('Incineroae')?.id).toBe('incineroar'); // swapped char
  });
});

describe('matchMove (against a small candidate list)', () => {
  const moves = ['Close Combat', 'Dire Claw', 'Fake Out', 'Protect'];
  test('noisy OCR resolves to the intended move', () => {
    expect(matchMove('Clos Combat', moves)?.value).toBe('Close Combat');
    expect(matchMove('Protecf', moves)?.value).toBe('Protect');
  });
  test('bestMatch returns null on an empty candidate list', () => {
    expect(bestMatch('whatever', [])).toBeNull();
  });
});
