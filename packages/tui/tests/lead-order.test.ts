// Which opponent is o1 and which is o2 is decided by the SCREEN — the nameplates are
// ground truth. The lead picker used to confirm `[...chosen].sort()`, i.e. the
// opponent's TEAM-LIST order, which has nothing to do with who stands on the left.
//
// Live consequence (2026-07-28): the engine board came up mirrored against reality, the
// occupancy reconciler correctly reported the plates disagreeing, and the player saw
// "the opponents swapped" — nonsense from their side — then lost a turn acknowledging it.
import { describe, test, expect } from 'vitest';
import { orderLeads } from '../src/ui/OpponentLeadPicker.js';

describe('lead order follows the plates, not the team list', () => {
  test('plate order wins over team-index order', () => {
    // Team list has Malamar at 3 and Whimsicott at 1, but the screen shows Malamar in o1.
    expect(orderLeads(new Set([1, 3]), [3, 1])).toEqual([3, 1]);
  });

  test('team order is used when it already agrees', () => {
    expect(orderLeads(new Set([1, 3]), [1, 3])).toEqual([1, 3]);
  });

  test('no plate read → fall back to team order (never invent a mirror)', () => {
    expect(orderLeads(new Set([1, 3]), [null, null])).toEqual([1, 3]);
    expect(orderLeads(new Set([1, 3]), [3, null])).toEqual([1, 3]);
  });

  test('a STALE plate order that does not cover the chosen pair is ignored', () => {
    // Half-read or left over from the previous match: trusting it would mirror the board
    // on evidence that isn't about these two mons.
    expect(orderLeads(new Set([1, 3]), [2, 4])).toEqual([1, 3]);
    expect(orderLeads(new Set([1, 3]), [1, 5])).toEqual([1, 3]);
  });

  test('a degenerate plate read (same mon in both slots) is ignored', () => {
    expect(orderLeads(new Set([1, 3]), [3, 3])).toEqual([1, 3]);
  });
});
