// The matchup grid's EXPANDED (per-move) form costs one line per move on top of each
// row header, so a normal board is 40+ lines before best-play, risks and history. Nothing
// consulted the terminal HEIGHT — useTerminalSize exposes rows, but only columns was ever
// read — so on a short terminal the screen scrolled and pushed the turn log out of view.
// Reported from live play 2026-07-27. This pins the arithmetic behind the auto-collapse.
import { describe, test, expect } from 'vitest';

/** Mirror of the estimate in BattleScreen: header + one line per move, per shown row. */
function gridNeeds(rowsPerMon: { moves: number }[][]): number {
  let n = 0;
  for (const mon of rowsPerMon) { n += 1; for (const r of mon) n += 1 + r.moves; }
  return n;
}
const GRID_RESERVE = 22;
const fits = (needs: number, termRows: number) => needs + GRID_RESERVE <= termRows;

describe('matchup grid height fit', () => {
  test('a normal live board does NOT fit a 30-row terminal expanded', () => {
    // 2 of my actives x 4 shown opponents (2 active + 2 brought), 4 moves each.
    const board = [Array(4).fill({ moves: 4 }), Array(4).fill({ moves: 4 })];
    const needs = gridNeeds(board);
    expect(needs).toBe(42);                 // 2x(1 + 4x5)
    expect(fits(needs, 30)).toBe(false);    // → collapses to compact
    expect(fits(needs, 24)).toBe(false);
  });

  test('it does fit a tall terminal', () => {
    const board = [Array(4).fill({ moves: 4 }), Array(4).fill({ moves: 4 })];
    expect(fits(gridNeeds(board), 70)).toBe(true);
  });

  test('a two-opponent board fits a normal terminal', () => {
    const board = [Array(2).fill({ moves: 4 }), Array(2).fill({ moves: 4 })];
    expect(gridNeeds(board)).toBe(22);
    expect(fits(gridNeeds(board), 45)).toBe(true);
  });

  test('the compact form is what buys the room back', () => {
    // Compact = one line per row, no per-move expansion: 42 lines -> 10.
    const board = [Array(4).fill({ moves: 0 }), Array(4).fill({ moves: 0 })];
    expect(gridNeeds(board)).toBe(10);
    expect(fits(gridNeeds(board), 34)).toBe(true);
  });

  test('below ~32 rows even COMPACT overflows — collapsing is a floor, not a cure', () => {
    // Worth stating plainly: the reserve alone (best play, risks, tactics, last 3 turns,
    // input, messages) is 22 lines, so a 30-row terminal cannot hold the full screen even
    // with every per-move row stripped. Auto-collapse still does the best available thing;
    // the real fix at that size is more rows (smaller font).
    const board = [Array(4).fill({ moves: 0 }), Array(4).fill({ moves: 0 })];
    expect(fits(gridNeeds(board), 30)).toBe(false);
  });
});
