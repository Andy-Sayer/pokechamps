import { describe, test, expect } from 'vitest';
import {
  getSpecies,
  getItem,
  loadFormat,
  isLegalSpecies,
  isLegalItem,
  searchLegalSpecies,
} from '../src/domain/data.js';

describe('getSpecies', () => {
  test('returns the species with name "Charizard"', () => {
    const s = getSpecies('Charizard');
    expect(s).toBeDefined();
    expect((s as any).name).toBe('Charizard');
  });

  test('handles odd casing / punctuation via toId stripping', () => {
    const a = getSpecies('CHARIZARD');
    const b = getSpecies('char-izard');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect((a as any).name).toBe('Charizard');
    expect((b as any).name).toBe('Charizard');
  });
});

describe('getItem', () => {
  test('returns Charizardite Y with a megaStone field', () => {
    const item = getItem('Charizardite Y') as any;
    expect(item).toBeDefined();
    expect(item.name).toBe('Charizardite Y');
    expect(item.megaStone).toBeDefined();
    // Mega stone payload maps base species -> mega forme name.
    expect(item.megaStone.Charizard).toBe('Charizard-Mega-Y');
  });
});

describe('loadFormat', () => {
  test('returns the live format.champions.json content with gimmick === "mega"', () => {
    const fmt = loadFormat();
    expect(fmt.gimmick).toBe('mega');
    expect(fmt.gameType).toBe('doubles');
    expect(fmt.level).toBe(50);
    expect(fmt.teamSize).toBe(6);
    expect(fmt.bringSize).toBe(4);
    expect(fmt.gimmickAllowancePerSide).toBe(1);
    expect(Array.isArray(fmt.legality.allow)).toBe(true);
    expect(fmt.legality.allow.length).toBeGreaterThan(0);
    // __notes should be stripped from the returned object.
    expect((fmt as any).__notes).toBeUndefined();
  });
});

describe('isLegalSpecies', () => {
  test('incineroar is legal (in the Reg M-A allow list)', () => {
    expect(isLegalSpecies('incineroar')).toBe(true);
  });

  test('respects display-form input with the toId normalizer', () => {
    expect(isLegalSpecies('Incineroar')).toBe(true);
  });

  test('formes inherit legality from their base species', () => {
    // Rotom is in the allow list — every Rotom forme should pass too.
    expect(isLegalSpecies('rotomwash')).toBe(true);
    expect(isLegalSpecies('Rotom-Heat')).toBe(true);
    expect(isLegalSpecies('rotomfrost')).toBe(true);
    expect(isLegalSpecies('Rotom-Fan')).toBe(true);
    expect(isLegalSpecies('rotommow')).toBe(true);
    // Lycanroc → Midnight + Dusk also legal.
    expect(isLegalSpecies('Lycanroc-Midnight')).toBe(true);
    expect(isLegalSpecies('lycanrocdusk')).toBe(true);
  });

  test('formes of a NON-allowed base species are still illegal', () => {
    // Landorus isn't in M-A — so neither is Landorus-Therian.
    expect(isLegalSpecies('landorus')).toBe(false);
    expect(isLegalSpecies('Landorus-Therian')).toBe(false);
  });

  test('mega formes are NOT pickable — they only exist as in-battle transformations', () => {
    // Charizard + Lucario are both in M-A; their mega formes must still
    // be rejected as pickable species.
    expect(isLegalSpecies('Charizard')).toBe(true);
    expect(isLegalSpecies('Charizard-Mega-X')).toBe(false);
    expect(isLegalSpecies('Charizard-Mega-Y')).toBe(false);
    expect(isLegalSpecies('Lucario')).toBe(true);
    expect(isLegalSpecies('Lucario-Mega')).toBe(false);
    // Primal Reversion + Gigantamax + Ash-Greninja are battle-only too.
    expect(isLegalSpecies('Kyogre-Primal')).toBe(false);
    expect(isLegalSpecies('Greninja-Ash')).toBe(false);
  });
});

describe('isLegalItem', () => {
  test('focussash is legal', () => {
    expect(isLegalItem('focussash')).toBe(true);
  });

  test('Focus Sash (display form) is legal via toId', () => {
    expect(isLegalItem('Focus Sash')).toBe(true);
  });
});

describe('searchLegalSpecies', () => {
  test('returns Charizard for query "char" and ranks prefix matches above pure substring matches', () => {
    const results = searchLegalSpecies('char');
    expect(results).toContain('Charizard');
    // Prefix matches (e.g. Charizard, Chandelure, Chesnaught) should come
    // before any pure substring match. None of the M-A allow list contains
    // "char" in a non-prefix position today, but we still assert the ordering
    // invariant for safety: every entry that starts with the query must come
    // before any entry that only contains it.
    const ids = results.map(n => n.toLowerCase().replace(/[^a-z0-9]/g, ''));
    let seenSubstring = false;
    for (const id of ids) {
      if (id.startsWith('char')) {
        expect(seenSubstring).toBe(false);
      } else {
        seenSubstring = true;
      }
    }
  });

  test('returns at most the limit (default 8) species for empty query', () => {
    const results = searchLegalSpecies('');
    expect(results.length).toBeLessThanOrEqual(8);
    expect(results.length).toBeGreaterThan(0);
  });

  test('respects an explicit limit', () => {
    const results = searchLegalSpecies('', 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  test('autocomplete surfaces formes whose base species is allowed', () => {
    // Query "rotom" should surface every Rotom forme, not just the base.
    const results = searchLegalSpecies('rotom');
    expect(results).toContain('Rotom');
    expect(results).toContain('Rotom-Wash');
    expect(results).toContain('Rotom-Heat');
    // Lycanroc: query "lycan" should pull Midnight + Dusk too.
    const lycan = searchLegalSpecies('lycan');
    expect(lycan).toContain('Lycanroc');
    expect(lycan).toContain('Lycanroc-Midnight');
    expect(lycan).toContain('Lycanroc-Dusk');
  });

  test('autocomplete does NOT surface mega/primal/gigantamax formes', () => {
    // Charizard appears, but its Mega-X / Mega-Y do not.
    const char = searchLegalSpecies('charizard');
    expect(char).toContain('Charizard');
    expect(char).not.toContain('Charizard-Mega-X');
    expect(char).not.toContain('Charizard-Mega-Y');
    const luc = searchLegalSpecies('lucario');
    expect(luc).toContain('Lucario');
    expect(luc).not.toContain('Lucario-Mega');
  });
});
