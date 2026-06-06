// Positional boost context: Helping Hand / Coaching / setup / logged boost lines
// must be in effect for a move that resolves AFTER them in the turn's order.
import { describe, test, expect } from 'vitest';
import { computeActionBoostContexts, type TurnBoostInput } from '../src/domain/turnBoosts.js';
import type { MoveAction } from '../src/domain/types.js';
import type { StateUpdate } from '../src/domain/turnparser.js';

const atk = (p: Partial<MoveAction> & { move: string; order: number }): MoveAction => ({
  side: 'mine', attackerSlot: 0, kind: 'move', attackerTeamIndex: 0,
  target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0, ...p,
});
const base = (over: Partial<TurnBoostInput> = {}): TurnBoostInput => ({
  actions: [], myStartBoosts: {}, oppStartBoosts: {}, myActive: [0, 1], oppActive: [0, 1], ...over,
});

describe('computeActionBoostContexts', () => {
  test('Helping Hand flags the ally’s later move', () => {
    const help = atk({ move: 'Helping Hand', attackerSlot: 1, attackerTeamIndex: 1, target: 'self', order: 1 });
    const hit = atk({ move: 'Moonblast', attackerSlot: 0, attackerTeamIndex: 0, order: 2 });
    const ctx = computeActionBoostContexts(base({ actions: [help, hit] }));
    expect(ctx.get(hit)?.helpingHand).toBe(true);
    expect(ctx.get(help)).toBeUndefined(); // Helping Hand isn't a damaging action
  });

  test('Coaching boosts the ally’s Atk/Def for a later move', () => {
    const coach = atk({ move: 'Coaching', attackerSlot: 1, attackerTeamIndex: 1, target: 'self', order: 1 });
    const hit = atk({ move: 'Close Combat', attackerSlot: 0, attackerTeamIndex: 0, order: 2 });
    const ctx = computeActionBoostContexts(base({ actions: [coach, hit] }));
    expect(ctx.get(hit)?.attackerBoosts.atk).toBe(1);
    expect(ctx.get(hit)?.attackerBoosts.def).toBe(1);
  });

  test('a logged defense boost applies to a hit that comes after it', () => {
    const boost: { order: number; update: StateUpdate } = { order: 1, update: { side: 'theirs', teamIndex: 0, boosts: { def: 2 } } };
    const hit = atk({ move: 'Earthquake', order: 2 });
    const ctx = computeActionBoostContexts(base({ actions: [hit], stateEvents: [boost] }));
    expect(ctx.get(hit)?.defenderBoosts.def).toBe(2);
  });

  test('a boost logged AFTER a hit does NOT affect that hit', () => {
    const hit = atk({ move: 'Earthquake', order: 1 });
    const boost: { order: number; update: StateUpdate } = { order: 2, update: { side: 'theirs', teamIndex: 0, boosts: { def: 2 } } };
    const ctx = computeActionBoostContexts(base({ actions: [hit], stateEvents: [boost] }));
    expect(ctx.get(hit)?.defenderBoosts.def ?? 0).toBe(0);
  });

  test('start-of-turn boosts are carried into the context', () => {
    const hit = atk({ move: 'Earthquake', order: 1 });
    const ctx = computeActionBoostContexts(base({ actions: [hit], oppStartBoosts: { 0: { def: 1 } } }));
    expect(ctx.get(hit)?.defenderBoosts.def).toBe(1);
  });
});
