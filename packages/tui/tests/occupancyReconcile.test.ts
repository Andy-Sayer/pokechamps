// The occupancy reconciler's decision core: plate assertions vs engine actives.
import { describe, test, expect } from 'vitest';
import { reconcileOccupancy, freshReconcileState, RECONCILE_RUNS, type Occupancy } from '../src/ui/occupancyReconcile.js';

const ENGINE: Occupancy = { m1: 'Talonflame', m2: 'Kingambit', o1: 'Charizard', o2: 'Venusaur' };

describe('reconcileOccupancy', () => {
  test('agreement keeps quiet and resets runs', () => {
    const st = freshReconcileState();
    st.swapRuns.opp = 2;                                   // prior noise
    const d = reconcileOccupancy(st, { ...ENGINE }, ENGINE);
    expect(d).toEqual({ swap: [], prompt: [] });
    expect(st.swapRuns.opp).toBe(0);
  });

  test('a sustained clean swap fires after RECONCILE_RUNS assertions — the crossed-pair class', () => {
    const st = freshReconcileState();
    const crossed: Occupancy = { ...ENGINE, o1: 'Venusaur', o2: 'Charizard' };
    for (let i = 0; i < RECONCILE_RUNS - 1; i++) {
      expect(reconcileOccupancy(st, crossed, ENGINE).swap).toEqual([]);
    }
    expect(reconcileOccupancy(st, crossed, ENGINE).swap).toEqual(['opp']);
    expect(st.swapRuns.opp).toBe(0);                       // fired → reset
  });

  test('one contradicting frame mid-run resets the counter (transient animation noise)', () => {
    const st = freshReconcileState();
    const crossed: Occupancy = { ...ENGINE, o1: 'Venusaur', o2: 'Charizard' };
    reconcileOccupancy(st, crossed, ENGINE);
    reconcileOccupancy(st, ENGINE, ENGINE);                // plates agree again
    for (let i = 0; i < RECONCILE_RUNS - 1; i++) reconcileOccupancy(st, crossed, ENGINE);
    expect(st.swapRuns.opp).toBe(RECONCILE_RUNS - 1);      // had to start over
  });

  test('a non-swap mismatch prompts instead of auto-editing', () => {
    const st = freshReconcileState();
    const weird: Occupancy = { ...ENGINE, o1: 'Whimsicott' };   // engine has no Whimsicott active
    let d = { swap: [] as string[], prompt: [] as string[] };
    for (let i = 0; i < RECONCILE_RUNS; i++) d = reconcileOccupancy(st, weird, ENGINE);
    expect(d.swap).toEqual([]);
    expect(d.prompt).toEqual(['opp']);
  });

  test('unsettled or empty slots never count as disagreement', () => {
    const st = freshReconcileState();
    const partial: Occupancy = { m1: 'Talonflame', o1: 'Venusaur' };       // o2 not settled
    const engineWithEmpty: Occupancy = { ...ENGINE, m2: undefined };        // m2 fainted, awaiting send-in
    for (let i = 0; i < RECONCILE_RUNS + 1; i++) {
      const d = reconcileOccupancy(st, partial, engineWithEmpty);
      expect(d).toEqual({ swap: [], prompt: [] });
    }
  });
});
