import { describe, test, expect } from 'vitest';
import { emitAction, emitTurnLog } from '../src/turnLog.js';
import type { TurnObservation } from '../src/types.js';

describe('emitAction — canonical turn-log grammar', () => {
  test('single-target move with remaining HP%', () => {
    expect(emitAction({ actor: 'm1', kind: 'move', move: 'Close Combat', target: 'o1', hpRemainingPercent: 33 }))
      .toBe('m1 > Close Combat > o1 > 33');
  });
  test('mega + crit modifiers stack on the actor', () => {
    expect(emitAction({ actor: 'm1', kind: 'move', move: 'Flamethrower', target: 'o1', hpRemainingPercent: 50, mega: true }))
      .toBe('m1+mega > Flamethrower > o1 > 50');
    expect(emitAction({ actor: 'm1', kind: 'move', move: 'Close Combat', target: 'o1', hpRemainingPercent: 0, crit: true }))
      .toBe('m1+crit > Close Combat > o1 > 0');
  });
  test('spread move lists each target', () => {
    expect(emitAction({ actor: 'm1', kind: 'move', move: 'Heat Wave', spread: [{ ref: 'o1', hpRemainingPercent: 40 }, { ref: 'o2', hpRemainingPercent: 35 }] }))
      .toBe('m1 > Heat Wave > spread > o1:40, o2:35');
  });
  test('mine-side remaining HP carries an explicit % (parser reads a bare m-side number as RAW HP)', () => {
    expect(emitAction({ actor: 'o1', kind: 'move', move: 'Sucker Punch', target: 'm1', hpRemainingPercent: 60 }))
      .toBe('o1 > Sucker Punch > m1 > 60%');
    // allAdjacent spread (Earthquake) includes the ally — its entry gets the % too
    expect(emitAction({ actor: 'o1', kind: 'move', move: 'Earthquake', spread: [{ ref: 'm1', hpRemainingPercent: 55 }, { ref: 'm2', hpRemainingPercent: 70 }, { ref: 'o2', hpRemainingPercent: 80 }] }))
      .toBe('o1 > Earthquake > spread > m1:55%, m2:70%, o2:80');
  });
  test('status / no-target move uses > self', () => {
    expect(emitAction({ actor: 'm1', kind: 'move', move: 'Protect' })).toBe('m1 > Protect > self');
  });
  test('switch by species', () => {
    expect(emitAction({ actor: 'm1', kind: 'switch', switchTo: 'Garchomp' })).toBe('m1 > switch > Garchomp');
  });
});

describe('emitTurnLog', () => {
  test('emits actions then faint state lines', () => {
    const obs: TurnObservation = {
      actions: [
        { actor: 'm1', kind: 'move', move: 'Close Combat', target: 'o1', hpRemainingPercent: 0 },
        { actor: 'o2', kind: 'move', move: 'Sucker Punch', target: 'm1', hpRemainingPercent: 60 },
      ],
      faints: ['o1'],
      confidence: 0.9,
      notes: [],
    };
    expect(emitTurnLog(obs)).toEqual([
      'm1 > Close Combat > o1 > 0',
      'o2 > Sucker Punch > m1 > 60%',
      'o1 ko',
    ]);
  });
});
