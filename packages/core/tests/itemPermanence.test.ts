// Item permanence classification — foundation for Acrobatics BP swing,
// resist-berry / pinch-berry triggers, and tightened item inference.
import { describe, test, expect } from 'vitest';
import { itemPermanence, isConsumable } from '../src/domain/itemPermanence.js';

describe('itemPermanence', () => {
  test('classifies one-shot items as consumable', () => {
    // Curated non-berry, non-gem one-shots.
    for (const i of [
      'Focus Sash', 'Air Balloon', 'White Herb', 'Mental Herb', 'Power Herb',
      'Eject Button', 'Eject Pack', 'Red Card', 'Weakness Policy', 'Booster Energy',
      'Mirror Herb',
    ]) expect(itemPermanence(i)).toBe('consumable');
  });

  test('berries are consumable (auto-classified via dex isBerry)', () => {
    for (const i of ['Sitrus Berry', 'Lum Berry', 'Salac Berry', 'Liechi Berry', 'Yache Berry', 'Roseli Berry']) {
      expect(itemPermanence(i)).toBe('consumable');
    }
  });

  test('gems are consumable (auto-classified via dex isGem)', () => {
    for (const i of ['Normal Gem', 'Fire Gem', 'Water Gem']) {
      expect(itemPermanence(i)).toBe('consumable');
    }
  });

  test('held items that stay all game are persistent', () => {
    for (const i of [
      'Leftovers', 'Choice Band', 'Choice Specs', 'Choice Scarf', 'Life Orb',
      'Assault Vest', 'Eviolite', 'Heavy-Duty Boots', 'Safety Goggles', 'Clear Amulet',
      'Covert Cloak', 'Loaded Dice', 'Black Sludge', 'Mystic Water', 'Charcoal',
    ]) expect(itemPermanence(i)).toBe('persistent');
  });

  test('mega stones are persistent (they don’t deplete when activated)', () => {
    for (const i of ['Charizardite Y', 'Aerodactylite', 'Venusaurite', 'Scovillainite']) {
      expect(itemPermanence(i)).toBe('persistent');
    }
  });

  test('falsy / unknown items default to persistent (safer than the reverse)', () => {
    expect(itemPermanence(undefined)).toBe('persistent');
    expect(itemPermanence(null)).toBe('persistent');
    expect(itemPermanence('')).toBe('persistent');
    expect(itemPermanence('Not A Real Item')).toBe('persistent');
  });

  test('isConsumable mirrors itemPermanence', () => {
    expect(isConsumable('Focus Sash')).toBe(true);
    expect(isConsumable('Leftovers')).toBe(false);
  });
});
