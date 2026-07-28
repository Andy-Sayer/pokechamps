// The opening send-out is occupancy truth, not a turn. Routing a disagreeing line
// through the ratify panel made "the opponents swapped" a prompt the player could miss —
// and missing it cost turn 1 in live play (2026-07-28).
import { describe, test, expect } from 'vitest';
import { planOpeningSeats } from '../src/ui/occupancyReconcile.js';

const OPP = ['Malamar', 'Whimsicott', 'Drampa'];
const MINE = ['Talonflame', 'Kingambit'];
const speciesAt = (side: 'mine' | 'theirs', i: number) => (side === 'mine' ? MINE : OPP)[i];
const findInTeam = (side: 'mine' | 'theirs', sp: string) =>
  (side === 'mine' ? MINE : OPP).findIndex(s => s.toLowerCase() === sp.toLowerCase());
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const plan = (lines: string[], active: { mine: (number | null)[]; theirs: (number | null)[] }) =>
  planOpeningSeats(lines, active, speciesAt, findInTeam, same);

describe('opening send-out is applied, never ratified', () => {
  test('lines that match the seating are dropped with no correction', () => {
    const r = plan(['o1 > switch > Malamar', 'o2 > switch > Whimsicott'], { mine: [0, 1], theirs: [0, 1] });
    expect(r.lines).toEqual([]);
    expect(r.seatFix).toEqual([]);
  });

  test('REVERSED seats produce a silent correction, not a turn', () => {
    // Engine has o1=Whimsicott(1), o2=Malamar(0); the plates say the opposite.
    const r = plan(['o1 > switch > Malamar', 'o2 > switch > Whimsicott'], { mine: [0, 1], theirs: [1, 0] });
    expect(r.lines).toEqual([]);                       // nothing for the player to accept
    expect(r.seatFix).toEqual([
      { side: 'theirs', slot: 0, teamIdx: 0 },
      { side: 'theirs', slot: 1, teamIdx: 1 },
    ]);
  });

  test('a mon that is NOT on the field stays a real switch line', () => {
    // Drampa was never seated, so this is genuine information — keep it.
    const r = plan(['o1 > switch > Drampa'], { mine: [0, 1], theirs: [0, 1] });
    expect(r.lines).toEqual(['o1 > switch > Drampa']);
    expect(r.seatFix).toEqual([]);
  });

  test('non-switch lines are always untouched', () => {
    const r = plan(['m1 > Acrobatics > o2 > 1', 'o2 ko'], { mine: [0, 1], theirs: [0, 1] });
    expect(r.lines).toEqual(['m1 > Acrobatics > o2 > 1', 'o2 ko']);
  });

  test('my own side is seated the same way', () => {
    const r = plan(['m1 > switch > Kingambit'], { mine: [0, 1], theirs: [0, 1] });
    expect(r.seatFix).toEqual([{ side: 'mine', slot: 0, teamIdx: 1 }]);
    expect(r.lines).toEqual([]);
  });
});
