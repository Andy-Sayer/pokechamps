import { describe, test, expect } from 'vitest';
import { maximin, solveMatrixGame } from '../src/domain/bringMatrixGame.js';

describe('maximin — robust pure bring', () => {
  test('picks the row with the best worst-case', () => {
    // row 0 worst = 0.6, row 1 worst = 0.3
    const { row, value } = maximin([[0.7, 0.6], [0.9, 0.3]]);
    expect(row).toBe(0);
    expect(value).toBeCloseTo(0.6, 5);
  });
});

describe('solveMatrixGame — zero-sum Nash via fictitious play', () => {
  test('a dominant row → pure strategy, value = its worst column', () => {
    const sol = solveMatrixGame([[0.7, 0.6], [0.3, 0.4]]);
    expect(sol.maximinRow).toBe(0);
    expect(sol.nashRow[0]!).toBeGreaterThan(0.95);
    expect(sol.value).toBeCloseTo(0.6, 1);
  });

  test('cyclic game (rock-paper-scissors payoffs) → uniform mix, value 0.5, and mixing BEATS the maximin pure pick', () => {
    const rps = [
      [0.5, 0.0, 1.0],
      [1.0, 0.5, 0.0],
      [0.0, 1.0, 0.5],
    ];
    const sol = solveMatrixGame(rps);
    // Nash is uniform, value 0.5
    for (const p of sol.nashRow) expect(p).toBeCloseTo(1 / 3, 1);
    expect(sol.value).toBeCloseTo(0.5, 1);
    // every pure bring has worst-case 0 → maximin pure value 0, far below the 0.5 mixed value:
    // this is the signal that varying your bring across games gains.
    expect(sol.maximinValue).toBeCloseTo(0, 1);
    expect(sol.value).toBeGreaterThan(sol.maximinValue + 0.4);
  });

  test('saddle point → maximin pure equals the game value (no gain from mixing)', () => {
    // row 1 / col 1 is a saddle (max of col-mins = min of row-maxes = 0.5)
    const sol = solveMatrixGame([[0.9, 0.2], [0.6, 0.5]]);
    expect(sol.maximinRow).toBe(1);
    expect(sol.maximinValue).toBeCloseTo(0.5, 5);
    expect(sol.value).toBeCloseTo(0.5, 1);
  });
});
