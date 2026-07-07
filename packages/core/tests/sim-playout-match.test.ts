// Regression: set↔sim mon matching must survive BOTH directions of forme drift.
// Matching on baseSpecies alone made forme species (Rotom-Wash, baseSpecies "Rotom")
// INVISIBLE to the search in playouts — buildInput dropped them from mine/opp, the
// side's plays came back empty, and whole 4v4 matrix cells were played on greedy
// fallback (found live vs Garchomp [MrAwesome 5-0], 2026-07-06).
import { describe, test, expect } from 'vitest';
import { matchesSet } from '../src/domain/simPlayout.js';

describe('matchesSet (set ↔ live sim mon)', () => {
  test('forme species match by exact name (baseSpecies differs)', () => {
    expect(matchesSet('Rotom-Wash', 'Rotom', 'Rotom-Wash')).toBe(true);
    expect(matchesSet('Ninetales-Alola', 'Ninetales', 'Ninetales-Alola')).toBe(true);
    expect(matchesSet('Basculegion-F', 'Basculegion', 'Basculegion-F')).toBe(true);
  });

  test('mega-evolved mon matches its base set via baseSpecies fallback', () => {
    expect(matchesSet('Charizard-Mega-Y', 'Charizard', 'Charizard')).toBe(true);
    expect(matchesSet('Raichu-Mega-X', 'Raichu', 'Raichu')).toBe(true);
  });

  test('no false match across sibling formes or unrelated species', () => {
    expect(matchesSet('Rotom-Wash', 'Rotom', 'Rotom-Heat')).toBe(false);
    expect(matchesSet('Rotom-Wash', 'Rotom', 'Garchomp')).toBe(false);
    // baseSpecies "Rotom" only matches a bare-Rotom set, never a different forme's set
    expect(matchesSet('Rotom-Wash', 'Rotom', 'Rotom')).toBe(true);
  });

  test('plain species unchanged', () => {
    expect(matchesSet('Garchomp', 'Garchomp', 'Garchomp')).toBe(true);
    expect(matchesSet('Talonflame', 'Talonflame', 'Kingambit')).toBe(false);
  });
});
