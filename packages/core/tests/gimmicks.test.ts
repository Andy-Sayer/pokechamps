import { describe, test, expect } from 'vitest';
import { megaGimmick } from '../src/domain/gimmicks/mega.js';
import { noneGimmick } from '../src/domain/gimmicks/none.js';
import { getGimmick, activeGimmick } from '../src/domain/gimmicks/index.js';
// Importing data.ts has the side effect of installing the format loader so
// that activeGimmick() can resolve the configured gimmick (Mega).
import { loadFormat } from '../src/domain/data.js';
import type { PokemonSet } from '../src/domain/types.js';

function mon(partial: Partial<PokemonSet> & { species: string }): PokemonSet {
  return {
    level: 50,
    nature: 'Modest',
    evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    moves: ['Flamethrower', 'Air Slash', 'Solar Beam', 'Protect'],
    ...partial,
  };
}

describe('megaGimmick.enumerateOpponentVariants', () => {
  test('charizard yields at least two mega stone variants (X and Y)', () => {
    const variants = megaGimmick.enumerateOpponentVariants!('charizard');
    expect(variants.length).toBeGreaterThanOrEqual(2);
    const items = variants.map(v => (v.item ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''));
    expect(items.some(i => i.includes('charizarditex'))).toBe(true);
    expect(items.some(i => i.includes('charizarditey'))).toBe(true);
  });

  test('ditto yields no mega variants', () => {
    const variants = megaGimmick.enumerateOpponentVariants!('ditto');
    expect(variants).toEqual([]);
  });
});

describe('megaGimmick.battleControl', () => {
  test('Charizard + Charizardite Y + inactive → Mega Evolve control with hotkey "m"', () => {
    const set = mon({ species: 'Charizard', item: 'Charizardite Y', ability: 'Blaze' });
    const ctrl = megaGimmick.battleControl!(set, false);
    expect(ctrl).not.toBeNull();
    expect(ctrl!.hotkey).toBe('m');
    expect(ctrl!.label).toBe('Mega Evolve');
  });

  test('Charizard + Charizardite Y + active → null', () => {
    const set = mon({ species: 'Charizard', item: 'Charizardite Y', ability: 'Blaze' });
    expect(megaGimmick.battleControl!(set, true)).toBeNull();
  });

  test('Charizard without a mega stone → null', () => {
    const set = mon({ species: 'Charizard', item: 'Leftovers', ability: 'Blaze' });
    expect(megaGimmick.battleControl!(set, false)).toBeNull();
  });

  test('Charizard with no item → null', () => {
    const set = mon({ species: 'Charizard', ability: 'Blaze' });
    expect(megaGimmick.battleControl!(set, false)).toBeNull();
  });
});

describe('megaGimmick.validateSet', () => {
  test('Charizard + Charizardite Y under live format → no errors', () => {
    const format = loadFormat();
    const set = mon({ species: 'Charizard', item: 'Charizardite Y', ability: 'Blaze' });
    expect(megaGimmick.validateSet!(set, format)).toEqual([]);
  });

  test('Charizard + Audinite → wrong-species error', () => {
    const format = loadFormat();
    const set = mon({ species: 'Charizard', item: 'Audinite', ability: 'Blaze' });
    const errors = megaGimmick.validateSet!(set, format);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toMatch(/wrong species/i);
  });

  test('Pikachu + Charizardite Y → wrong-species error', () => {
    const format = loadFormat();
    const set = mon({ species: 'Pikachu', item: 'Charizardite Y', ability: 'Static', moves: ['Thunderbolt'] });
    const errors = megaGimmick.validateSet!(set, format);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toMatch(/wrong species/i);
  });

  test('no item → no errors', () => {
    const format = loadFormat();
    const set = mon({ species: 'Charizard', ability: 'Blaze' });
    expect(megaGimmick.validateSet!(set, format)).toEqual([]);
  });
});

describe('megaGimmick.describeSet', () => {
  test('returns non-null string when holding a mega stone', () => {
    const set = mon({ species: 'Charizard', item: 'Charizardite Y', ability: 'Blaze' });
    const desc = megaGimmick.describeSet!(set);
    expect(desc).not.toBeNull();
    expect(typeof desc).toBe('string');
    expect(desc!).toMatch(/Charizardite Y/);
  });

  test('returns null when not holding a mega stone', () => {
    const set = mon({ species: 'Charizard', item: 'Leftovers', ability: 'Blaze' });
    expect(megaGimmick.describeSet!(set)).toBeNull();
  });

  test('returns null when no item', () => {
    const set = mon({ species: 'Charizard', ability: 'Blaze' });
    expect(megaGimmick.describeSet!(set)).toBeNull();
  });
});

describe('gimmick registry', () => {
  test('getGimmick("mega") returns megaGimmick', () => {
    const g = getGimmick('mega');
    expect(g).toBe(megaGimmick);
    expect(g.id).toBe('mega');
  });

  test('getGimmick("none") returns noneGimmick', () => {
    expect(getGimmick('none')).toBe(noneGimmick);
  });

  test('getGimmick("tera") returns the Tera gimmick', () => {
    const g = getGimmick('tera');
    expect(g.id).toBe('tera');
    expect(g).not.toBe(noneGimmick);
  });

  test('getGimmick("zmove") returns the Z-Move gimmick', () => {
    const g = getGimmick('zmove');
    expect(g.id).toBe('zmove');
    expect(g).not.toBe(noneGimmick);
  });

  test('getGimmick("dynamax") returns the Dynamax gimmick', () => {
    const g = getGimmick('dynamax');
    expect(g.id).toBe('dynamax');
    expect(g).not.toBe(noneGimmick);
  });

  test('Tera parses "Tera Type:" lines and writes teraType', () => {
    const g = getGimmick('tera');
    const draft: any = {};
    expect(g.parseShowdownLine?.('Tera Type: Fire', draft)).toBe(true);
    expect(draft.teraType).toBe('Fire');
  });

  test('Tera enrichCalcPokemon sets teraType and isTera when active', () => {
    const g = getGimmick('tera');
    const opts: any = {};
    g.enrichCalcPokemon?.({ set: { teraType: 'Water' } as any, active: true, opts });
    expect(opts.teraType).toBe('Water');
    expect(opts.isTera).toBe(true);
  });

  test('Z-Move enrichCalcMove flips useZ when active', () => {
    const opts: any = {};
    getGimmick('zmove').enrichCalcMove?.({ set: {} as any, active: true, move: 'Fire Blast', opts });
    expect(opts.useZ).toBe(true);
  });

  test('Dynamax enrichCalcPokemon sets isDynamaxed when active', () => {
    const opts: any = {};
    getGimmick('dynamax').enrichCalcPokemon?.({ set: {} as any, active: true, opts });
    expect(opts.isDynamaxed).toBe(true);
  });

  test('activeGimmick() resolves to megaGimmick under the current format', () => {
    // Touch loadFormat so the format loader is definitely registered.
    expect(loadFormat().gimmick).toBe('mega');
    expect(activeGimmick()).toBe(megaGimmick);
  });
});

describe('noneGimmick', () => {
  test('id and label are populated', () => {
    expect(noneGimmick.id).toBe('none');
    expect(noneGimmick.label).toBe('None');
  });

  test('all optional hooks are absent (null-object pattern)', () => {
    expect(noneGimmick.parseShowdownLine).toBeUndefined();
    expect(noneGimmick.formatShowdownLines).toBeUndefined();
    expect(noneGimmick.enrichCalcPokemon).toBeUndefined();
    expect(noneGimmick.enrichCalcMove).toBeUndefined();
    expect(noneGimmick.enumerateOpponentVariants).toBeUndefined();
    expect(noneGimmick.battleControl).toBeUndefined();
    expect(noneGimmick.validateSet).toBeUndefined();
    expect(noneGimmick.describeSet).toBeUndefined();
  });
});
