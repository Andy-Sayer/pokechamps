// Acrobatics: 55 BP with item held, 110 BP with no item. The roadmap's
// foundation item-permanence step relies on the existing `itemConsumed` plumb-
// through (predictions.ts strips opp item, BattleScreen.tsx strips mine via
// `myCalcSet`) flowing into @smogon/calc as `item: undefined`. These tests
// pin the calc behaviour: undefined item must roughly double the rolls.
import { describe, test, expect } from 'vitest';
import { damageRange } from '../src/domain/damage.js';
import type { PokemonSet } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

// Hawlucha is a clean test bed: Flying-type STAB + Unburden ability flavour-
// matches the no-item case. Use Adamant 252 Atk for a sharp BP signal.
const HAWLUCHA_WITH_ITEM: PokemonSet = {
  species: 'Hawlucha',
  level: 50,
  item: 'Sitrus Berry',
  ability: 'Unburden',
  nature: 'Adamant',
  evs: { ...ZERO_EVS, atk: 252, spe: 252, hp: 4 },
  ivs: MAX_IVS,
  moves: ['Acrobatics'],
};
const HAWLUCHA_NO_ITEM: PokemonSet = { ...HAWLUCHA_WITH_ITEM, item: undefined };

const FERROTHORN: PokemonSet = {
  species: 'Ferrothorn',
  level: 50,
  item: 'Leftovers',
  ability: 'Iron Barbs',
  nature: 'Relaxed',
  evs: { ...ZERO_EVS, hp: 252, def: 252, spd: 4 },
  ivs: MAX_IVS,
  moves: ['Power Whip'],
};

describe('Acrobatics conditional BP', () => {
  test('no-item attacker hits roughly twice as hard as item-holding attacker', () => {
    const withItem = damageRange({
      attacker: HAWLUCHA_WITH_ITEM,
      defender: FERROTHORN,
      move: 'Acrobatics',
      field: NEUTRAL_FIELD,
      attackerSide: 'mine',
    });
    const noItem = damageRange({
      attacker: HAWLUCHA_NO_ITEM,
      defender: FERROTHORN,
      move: 'Acrobatics',
      field: NEUTRAL_FIELD,
      attackerSide: 'mine',
    });

    // 110 BP / 55 BP = 2.0; in practice the rolls land between 1.8x and 2.2x
    // because rounding compounds slightly differently at the two BPs.
    const ratio = noItem.maxPercent / withItem.maxPercent;
    expect(ratio).toBeGreaterThan(1.8);
    expect(ratio).toBeLessThan(2.2);
  });

  test('@smogon/calc desc string mentions Acrobatics at both BPs', () => {
    const r = damageRange({
      attacker: HAWLUCHA_NO_ITEM,
      defender: FERROTHORN,
      move: 'Acrobatics',
      field: NEUTRAL_FIELD,
      attackerSide: 'mine',
    });
    // Sanity: the calc didn't choke on undefined item.
    expect(r.desc).toMatch(/Acrobatics/);
    expect(r.rolls.length).toBeGreaterThan(0);
  });
});
