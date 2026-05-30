// Resist berries inclusion is weakness-aware — only mons weak to the matching
// type carry the berry. Chilan is an exception: included for neutral-Normal
// mons too because halving a Normal hit at neutral effectiveness is its niche.
import { describe, test, expect } from 'vitest';
import { resistBerryForType, resistBerriesForSpecies } from '../src/domain/resistBerries.js';

describe('resistBerryForType', () => {
  test('maps each offensive type to its matching berry', () => {
    expect(resistBerryForType('Ice')).toBe('Yache Berry');
    expect(resistBerryForType('Fire')).toBe('Occa Berry');
    expect(resistBerryForType('Dragon')).toBe('Haban Berry');
    expect(resistBerryForType('Fairy')).toBe('Roseli Berry');
    expect(resistBerryForType('Steel')).toBe('Babiri Berry');
  });

  test('returns undefined for non-existent types', () => {
    expect(resistBerryForType('NotAType')).toBeUndefined();
  });
});

describe('resistBerriesForSpecies', () => {
  test('Garchomp (Dragon/Ground) gets Ice/Dragon/Fairy resist berries', () => {
    const out = resistBerriesForSpecies('Garchomp');
    expect(out).toContain('Yache Berry'); // weak to Ice (4×)
    expect(out).toContain('Haban Berry'); // weak to Dragon
    expect(out).toContain('Roseli Berry'); // weak to Fairy
  });

  test('Charizard (Fire/Flying) gets Rock/Water/Electric resist berries (+ Chilan for neutral Normal)', () => {
    const out = resistBerriesForSpecies('Charizard');
    expect(out).toContain('Charti Berry'); // weak to Rock (4×)
    expect(out).toContain('Passho Berry'); // weak to Water
    expect(out).toContain('Wacan Berry'); // weak to Electric
    expect(out).toContain('Chilan Berry'); // neutral to Normal → Chilan included
  });

  test('does NOT include berries for resisted types', () => {
    // Charizard resists Grass — Rindo Berry would be wasted.
    const out = resistBerriesForSpecies('Charizard');
    expect(out).not.toContain('Rindo Berry');
    expect(out).not.toContain('Tanga Berry'); // Bug 4× resist on Charizard
  });

  test('Fighting/Poison Sneasler gets Psychic/Ground/Flying resist berries (but NOT Roseli)', () => {
    // Sneasler (Hisuian, Fighting/Poison) is 4× weak to Psychic, 2× to Ground
    // (via Poison) and 2× to Flying (via Fighting). It is NOT weak to Fairy —
    // Poison RESISTS Fairy (0.5×), which cancels the Fighting 2× to neutral.
    const out = resistBerriesForSpecies('Sneasler');
    expect(out).toContain('Payapa Berry'); // 4× weak to Psychic
    expect(out).toContain('Shuca Berry');  // weak to Ground via Poison
    expect(out).toContain('Coba Berry');   // weak to Flying via Fighting
    expect(out).not.toContain('Roseli Berry'); // Fairy is neutral, not SE
  });

  test('empty for unknown species (graceful)', () => {
    expect(resistBerriesForSpecies('NotAMon')).toEqual([]);
  });
});
