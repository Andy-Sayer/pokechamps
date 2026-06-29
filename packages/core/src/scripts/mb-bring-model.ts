// Task-A baseline: does BRING composition predict the winner, and can a learned
// model beat trivial baselines? Logistic regression over a few interpretable
// (my-bring − opp-bring) team-stat features, GAME-level train/test split (a
// game's two mirror rows never straddle the split → no leakage). Reports test
// accuracy vs the 50% floor + a raw-BST-difference heuristic. Honest baseline,
// not the final model — see training-data-plan.md.
//   npx tsx packages/core/src/scripts/mb-bring-model.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSpecies, dataDirPath } from '../domain/data.js';

interface Row { gameId: string; bring: string[]; oppBring: string[]; won: boolean | null; fullTeam: boolean }
const rows: Row[] = readFileSync(join(dataDirPath(), 'training', 'bring-outcomes.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l) as Row)
  .filter(r => r.fullTeam && r.bring.length === 4 && r.won != null);

const bs = (sp: string) => (getSpecies(sp) as { baseStats?: Record<string, number> } | undefined)?.baseStats;
const sum = (br: string[], f: (sp: string) => number) => br.reduce((a, sp) => a + f(sp), 0);
const spe = (sp: string) => bs(sp)?.spe ?? 0;
const off = (sp: string) => { const s = bs(sp); return s ? Math.max(s.atk!, s.spa!) : 0; };
const blk = (sp: string) => { const s = bs(sp); return s ? s.hp! + s.def! + s.spd! : 0; };
const bst = (sp: string) => { const s = bs(sp); return s ? s.hp! + s.atk! + s.def! + s.spa! + s.spd! + s.spe! : 0; };

// Feature vector = normalized (my − opp) differences across team-composition axes.
const feats = (r: Row): number[] => [
  (sum(r.bring, spe) - sum(r.oppBring, spe)) / 100,
  (sum(r.bring, off) - sum(r.oppBring, off)) / 100,
  (sum(r.bring, blk) - sum(r.oppBring, blk)) / 200,
  (sum(r.bring, bst) - sum(r.oppBring, bst)) / 300,
];
const X = rows.map(feats);
const y = rows.map(r => (r.won ? 1 : 0));

// Game-level split: all rows of a game go to the same side (no mirror leakage).
const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
const isTest = rows.map(r => hash(r.gameId) % 5 === 0);

const dot = (w: number[], x: number[]) => w.reduce((a, wi, i) => a + wi * x[i]!, 0);
function train(): { w: number[]; b: number } {
  const d = X[0]!.length; const w = new Array(d).fill(0); let b = 0;
  const lr = 0.1, l2 = 0.002, iters = 4000;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0); let gb = 0, n = 0;
    for (let i = 0; i < X.length; i++) {
      if (isTest[i]) continue;
      const p = 1 / (1 + Math.exp(-(b + dot(w, X[i]!))));
      const err = p - y[i]!; n++;
      for (let j = 0; j < d; j++) gw[j] += err * X[i]![j]!;
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
    b -= lr * (gb / n);
  }
  return { w, b };
}

const m = train();
const acc = (pred: (i: number) => number, testOnly: boolean) => {
  let ok = 0, tot = 0;
  for (let i = 0; i < rows.length; i++) {
    if (testOnly !== isTest[i]) continue;
    ok += pred(i) === y[i] ? 1 : 0; tot++;
  }
  return { pct: Math.round(100 * ok / tot), tot };
};
const model = (i: number) => (1 / (1 + Math.exp(-(m.b + dot(m.w, X[i]!)))) >= 0.5 ? 1 : 0);
const bstHeuristic = (i: number) => (X[i]![3]! >= 0 ? 1 : 0);  // higher total BST wins
const majority = y.filter(v => v === 1).length >= y.length / 2 ? 1 : 0;

const te = acc(model, true);
console.log(`usable rows ${rows.length} · features ${X[0]!.length} · test held-out ${te.tot} games-worth`);
console.log(`  learned model   test ${te.pct}%   (train ${acc(model, false).pct}%)`);
console.log(`  BST-diff heuristic test ${acc(bstHeuristic, true).pct}%`);
console.log(`  majority-class  test ${acc(() => majority, true).pct}%   (50% = coin flip)`);
console.log(`weights [spe, off, blk, bst]: ${m.w.map(v => v.toFixed(2)).join(', ')}  b ${m.b.toFixed(2)}`);
