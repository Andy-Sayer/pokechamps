// Proper-ML proof-of-concept: train a bring VALUE model (win-probability) on the
// playout-labeled matchup dataset, using engine-derived features, and test whether
// it beats the raw static opening-search score on HELD-OUT opponents. Honest
// metric before model: log-loss + accuracy vs two baselines (static-score-sign,
// always-majority). Split by OPPONENT so train/test never share a matchup.
//   npx tsx packages/core/src/scripts/mb-train-value.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { matchupFeatures, FEATURE_NAMES } from '../domain/bringFeatures.js';
import type { PokemonSet } from '../domain/types.js';

interface Row { oppAnchor: string; myBring: PokemonSet[]; oppBring: PokemonSet[]; games: number; wins: number; losses: number; ties: number; winRate: number }
const rows: Row[] = readFileSync(join(dataDirPath(), 'training', 'playout-matchups.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l) as Row);
console.log(`${rows.length} matchup rows · ${new Set(rows.map(r => r.oppAnchor)).size} opponents · extracting features…`);

// Extract features once per matchup (the slow part: a search + damage calcs each).
const data = rows.map(r => ({ x: matchupFeatures(r.myBring, r.oppBring), r }));

// Hold out ~20% of OPPONENTS (not rows) so the test measures generalization.
const opps = [...new Set(rows.map(r => r.oppAnchor))];
const hashOpp = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
const isTestOpp = (a: string) => hashOpp(a) % 5 === 0;
const train = data.filter(d => !isTestOpp(d.r.oppAnchor));
const test = data.filter(d => isTestOpp(d.r.oppAnchor));
console.log(`train ${train.length} matchups (${opps.filter(o => !isTestOpp(o)).length} opp) · test ${test.length} (${opps.filter(isTestOpp).length} opp)\n`);

const dot = (w: number[], x: number[]) => w.reduce((a, wi, i) => a + wi * x[i]!, 0);
const sig = (z: number) => 1 / (1 + Math.exp(-z));

// Weighted logistic regression: each matchup contributes `wins` positive and
// `losses` negative examples (its winRate is the soft target). `cols` selects
// which features to use (so we can train a static-score-only baseline).
function fit(rowsIn: typeof train, cols: number[]): { w: number[]; b: number } {
  const d = cols.length; const w = new Array(d).fill(0); let b = 0;
  const lr = 0.3, l2 = 0.003, iters = 6000;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0); let gb = 0, n = 0;
    for (const { x, r } of rowsIn) {
      const xs = cols.map(c => x[c]!);
      const p = sig(b + dot(w, xs));
      // weight by wins (target 1) and losses (target 0)
      const wpos = r.wins, wneg = r.losses;
      gb += (p - 1) * wpos + (p - 0) * wneg;
      for (let j = 0; j < d; j++) { gw[j] += ((p - 1) * wpos + p * wneg) * xs[j]!; }
      n += wpos + wneg;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
    b -= lr * (gb / n);
  }
  return { w, b };
}

// Evaluate a predictor (matchup → P(win)) on a set: log-loss + matchup accuracy
// (predict win if P≥.5, correct if actual winRate≥.5), weighted by games.
function evalPred(rowsIn: typeof train, pred: (x: number[]) => number) {
  let ll = 0, n = 0, correct = 0, m = 0;
  for (const { x, r } of rowsIn) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, pred(x)));
    ll += -(r.wins * Math.log(p) + r.losses * Math.log(1 - p));
    n += r.wins + r.losses;
    if ((p >= 0.5) === (r.winRate >= 0.5)) correct++;
    m++;
  }
  return { logLoss: ll / n, acc: correct / m };
}

const allCols = FEATURE_NAMES.map((_, i) => i);
const model = fit(train, allCols);
const baseStatic = fit(train, [0]); // static-score-only logistic (calibrated baseline)

const predModel = (x: number[]) => sig(model.b + dot(model.w, allCols.map(c => x[c]!)));
const predStaticLogit = (x: number[]) => sig(baseStatic.b + baseStatic.w[0]! * x[0]!);
const predStaticSign = (x: number[]) => (x[0]! >= 0 ? 0.75 : 0.25); // raw "static>0 ⇒ win" heuristic

console.log('held-out TEST (generalization to unseen opponents):');
for (const [name, pred] of [['learned model    ', predModel], ['static-score logit', predStaticLogit], ['static>0 heuristic', predStaticSign]] as const) {
  const e = evalPred(test, pred);
  console.log(`  ${name}  log-loss ${e.logLoss.toFixed(3)}  ·  matchup-acc ${Math.round(e.acc * 100)}%`);
}
console.log('\n(train fit for reference):');
console.log(`  learned model     log-loss ${evalPred(train, predModel).logLoss.toFixed(3)}  ·  acc ${Math.round(evalPred(train, predModel).acc * 100)}%`);
console.log(`\nweights [${FEATURE_NAMES.join(', ')}]:\n  ${model.w.map(v => v.toFixed(2)).join(', ')}  · b ${model.b.toFixed(2)}`);

// Show the matchups where the model most corrects the static score on TEST.
const diffs = test.map(({ x, r }) => ({ r, pm: predModel(x), ps: predStaticLogit(x), wr: r.winRate }))
  .sort((a, b) => Math.abs(b.pm - b.ps) - Math.abs(a.pm - a.ps)).slice(0, 6);
console.log('\nbiggest model-vs-static corrections (test):');
for (const d of diffs) {
  console.log(`  vs ${d.r.oppAnchor.padEnd(12)} ${d.r.myBring.map(s => s.species).slice(0, 2).join('/')}…  actual ${Math.round(d.wr * 100)}%  model ${Math.round(d.pm * 100)}%  static ${Math.round(d.ps * 100)}%`);
}
