import { describe, test, expect } from 'vitest';
import { hpItemTriggerFor, isHpItemTriggerItem } from '../src/domain/hpItemTriggers.js';

describe('hpItemTriggerFor — Sitrus Berry', () => {
  test('fires when crossing from above 50% to at-or-below 50%', () => {
    expect(hpItemTriggerFor('Sitrus Berry', 80, 40)).toEqual({
      consumed: 'Sitrus Berry', healPercent: 25,
    });
    expect(hpItemTriggerFor('Sitrus Berry', 51, 50)).toEqual({
      consumed: 'Sitrus Berry', healPercent: 25,
    });
  });

  test('does not fire if HP stayed above 50%', () => {
    expect(hpItemTriggerFor('Sitrus Berry', 80, 60)).toBeNull();
  });

  test('does not fire when prev was already at or below 50%', () => {
    // Holder was below 50 already — Sitrus should have triggered on the
    // prior hit; the caller is responsible for marking it consumed. We
    // never double-fire.
    expect(hpItemTriggerFor('Sitrus Berry', 40, 30)).toBeNull();
    expect(hpItemTriggerFor('Sitrus Berry', 50, 25)).toBeNull();
  });

  test('does not fire on KO (newHp = 0)', () => {
    // A lethal hit takes the holder past 50% and to 0; berries don't save
    // the mon (that's Focus Sash's job).
    expect(hpItemTriggerFor('Sitrus Berry', 60, 0)).toBeNull();
  });
});

describe('hpItemTriggerFor — pinch berries', () => {
  test('Salac fires at ≤25%, +1 Spe', () => {
    expect(hpItemTriggerFor('Salac Berry', 50, 20)).toEqual({
      consumed: 'Salac Berry', boost: { stat: 'spe', amount: 1 },
    });
    expect(hpItemTriggerFor('Salac Berry', 30, 25)).toEqual({
      consumed: 'Salac Berry', boost: { stat: 'spe', amount: 1 },
    });
  });

  test('Liechi/Petaya/Ganlon/Apicot map to the right stat', () => {
    expect(hpItemTriggerFor('Liechi Berry', 80, 20)!.boost).toEqual({ stat: 'atk', amount: 1 });
    expect(hpItemTriggerFor('Petaya Berry', 80, 20)!.boost).toEqual({ stat: 'spa', amount: 1 });
    expect(hpItemTriggerFor('Ganlon Berry', 80, 20)!.boost).toEqual({ stat: 'def', amount: 1 });
    expect(hpItemTriggerFor('Apicot Berry', 80, 20)!.boost).toEqual({ stat: 'spd', amount: 1 });
  });

  test('pinch berries do not fire above 25%', () => {
    expect(hpItemTriggerFor('Salac Berry', 80, 30)).toBeNull();
  });

  test('pinch berries do not double-fire when prev was already ≤25%', () => {
    expect(hpItemTriggerFor('Salac Berry', 20, 10)).toBeNull();
  });

  test('pinch berries do not fire on KO', () => {
    expect(hpItemTriggerFor('Salac Berry', 40, 0)).toBeNull();
  });
});

describe('hpItemTriggerFor — non-matching items', () => {
  test('returns null for non-berry items', () => {
    expect(hpItemTriggerFor('Leftovers', 80, 30)).toBeNull();
    expect(hpItemTriggerFor('Choice Scarf', 80, 20)).toBeNull();
    expect(hpItemTriggerFor('Focus Sash', 80, 0)).toBeNull(); // Sash is its own path
  });

  test('returns null for undefined item (already consumed)', () => {
    expect(hpItemTriggerFor(undefined, 80, 20)).toBeNull();
  });
});

describe('isHpItemTriggerItem', () => {
  test('recognises Sitrus and pinch berries', () => {
    expect(isHpItemTriggerItem('Sitrus Berry')).toBe(true);
    expect(isHpItemTriggerItem('Salac Berry')).toBe(true);
    expect(isHpItemTriggerItem('Apicot Berry')).toBe(true);
  });

  test('rejects other items', () => {
    expect(isHpItemTriggerItem('Leftovers')).toBe(false);
    expect(isHpItemTriggerItem('Lum Berry')).toBe(false); // not in this layer yet
    expect(isHpItemTriggerItem(undefined)).toBe(false);
  });
});
