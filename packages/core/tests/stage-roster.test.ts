import { describe, test, expect } from 'vitest';
import { parseRoster, classifyIds, diffAllow, formatAllowBlock } from '../src/scripts/stage-roster.js';

describe('parseRoster', () => {
  test('handles names, mixed separators, bullets, and dedups via toId', () => {
    const ids = parseRoster(`
      Garchomp, Sneasler
      - Indeedee-F
      1. Flutter Mane
      garchomp
    `);
    expect(ids).toEqual(['garchomp', 'sneasler', 'indeedeef', 'fluttermane']);
  });
});

describe('classifyIds', () => {
  test('separates base species, item-gated mega formes, and unresolved ids', () => {
    const { species, megaFormes, unresolved } = classifyIds(['garchomp', 'raichumegax', 'notarealmon123']);
    expect(species).toContain('garchomp');
    expect(megaFormes).toContain('raichumegax');   // requiredItem → belongs in items.allow, not legality.allow
    expect(unresolved).toContain('notarealmon123');
  });
});

describe('diffAllow', () => {
  const current = ['absol', 'garchomp', 'sneasler'];
  test('add mode merges and never removes', () => {
    const { added, removed, merged } = diffAllow(current, ['garchomp', 'torkoal'], 'add');
    expect(added).toEqual(['torkoal']);
    expect(removed).toEqual([]);
    expect(merged).toEqual(['absol', 'garchomp', 'sneasler', 'torkoal']);
  });
  test('replace mode treats input as authoritative and reports removals', () => {
    const { added, removed, merged } = diffAllow(current, ['garchomp', 'torkoal'], 'replace');
    expect(added).toEqual(['torkoal']);
    expect(removed).toEqual(['absol', 'sneasler']);
    expect(merged).toEqual(['garchomp', 'torkoal']);
  });
});

describe('formatAllowBlock', () => {
  test('is valid, paste-ready JSON array body that round-trips to the sorted set', () => {
    const ids = ['sneasler', 'absol', 'garchomp', 'torkoal', 'incineroar', 'raichu', 'pelipper', 'dragonite', 'aegislash'];
    const block = formatAllowBlock(ids);
    // Wrapping it in [ ] must parse as JSON and equal the sorted, deduped ids.
    expect(JSON.parse(`[${block}]`)).toEqual([...new Set(ids)].sort());
  });
  test('wraps 7 per line at a 6-space indent with a trailing comma on all but the last line', () => {
    const ids = Array.from({ length: 9 }, (_, i) => `mon${i}`);
    const lines = formatAllowBlock(ids).split('\n');
    expect(lines).toHaveLength(2);                       // 9 ids → 7 + 2
    expect(lines[0]!.startsWith('      "')).toBe(true);  // 6-space indent
    expect(lines[0]!.endsWith(',')).toBe(true);          // mid-array trailing comma
    expect(lines[1]!.endsWith(',')).toBe(false);         // last line: no trailing comma
  });
});
