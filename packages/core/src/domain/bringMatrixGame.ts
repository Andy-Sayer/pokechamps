// Zero-sum matrix-game solver for the bring decision. Given the 4v4 win-rate
// matrix M (M[i][j] = MY win-rate when I bring i and they bring j, under minimax
// play), choosing a bring is a zero-sum game: I (the row player) maximize, they
// (the column player) minimize. This separates the two game layers — the 4v4
// playout fills M (what works against what); this solves who to bring.
//
//   - maximin: the robust PURE bring (best guaranteed worst-case) — the actionable
//     "bring this" pick when you commit to one team deterministically.
//   - nash: the optimal MIXED strategy + the true game value (via fictitious play,
//     which converges to the value for zero-sum games). Tells you the matchup's
//     real win-rate under optimal bring play, and whether varying your bring across
//     games would gain over the single maximin pick.
// Pure (no IO / no sim) so it's unit-tested; the generator supplies M.

export interface MatrixSolution {
  maximinRow: number;       // index of the robust pure bring
  maximinValue: number;     // its guaranteed worst-case win-rate
  nashRow: number[];        // my optimal mixed strategy (probabilities over brings)
  nashCol: number[];        // their optimal mixed strategy
  value: number;            // game value (win-rate under optimal play by both)
}

const argmax = (a: number[]): number => a.reduce((bi, v, i) => (v > a[bi]! ? i : bi), 0);
const argmin = (a: number[]): number => a.reduce((bi, v, i) => (v < a[bi]! ? i : bi), 0);
const normalize = (a: number[]): number[] => { const s = a.reduce((x, y) => x + y, 0) || 1; return a.map(v => v / s); };

/** Robust PURE bring: the row whose worst column (their best response) is highest. */
export function maximin(M: number[][]): { row: number; value: number } {
  let best = -Infinity, bestRow = 0;
  for (let i = 0; i < M.length; i++) {
    const worst = Math.min(...M[i]!);
    if (worst > best) { best = worst; bestRow = i; }
  }
  return { row: bestRow, value: best };
}

/** Fictitious play — converges to the Nash value of the zero-sum game. */
export function solveMatrixGame(M: number[][], iters = 20000): MatrixSolution {
  const n = M.length, m = M[0]!.length;
  const rowCount = new Array(n).fill(0) as number[];
  const colCount = new Array(m).fill(0) as number[];
  const rowPayoff = new Array(n).fill(0) as number[]; // each row's accumulated payoff vs the column's play history
  const colPayoff = new Array(m).fill(0) as number[]; // each column's accumulated payoff (to the row) vs the row's history
  let curCol = 0;
  for (let t = 0; t < iters; t++) {
    for (let i = 0; i < n; i++) rowPayoff[i]! += M[i]![curCol]!;
    const curRow = argmax(rowPayoff);
    rowCount[curRow]!++;
    for (let j = 0; j < m; j++) colPayoff[j]! += M[curRow]![j]!;
    curCol = argmin(colPayoff);
    colCount[curCol]!++;
  }
  const nashRow = normalize(rowCount);
  const nashCol = normalize(colCount);
  let value = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) value += nashRow[i]! * nashCol[j]! * M[i]![j]!;
  const mm = maximin(M);
  return { maximinRow: mm.row, maximinValue: mm.value, nashRow, nashCol, value };
}
