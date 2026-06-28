// Calibrate scoreBrings' weights to the EXHAUSTIVE-best bring labels
// (mb-bring-analysis --labels). Coordinate-descent over BringWeights to maximise
// top-1 agreement on a TRAIN split, reporting held-out TEST agreement so we see
// it generalises rather than overfits. No battle search — just re-scoring.
//   npx tsx packages/core/src/scripts/mb-calibrate-brings.ts [--labels data/bring-labels.json]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scoreBrings, DEFAULT_BRING_WEIGHTS, type BringWeights } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { NEUTRAL_FIELD } from '../domain/types.js';
import type { PokemonSet } from '../domain/types.js';

const argStr = (f: string, d: string) => { const i = process.argv.indexOf(f); return i >= 0 ? String(process.argv[i + 1]) : d; };
const labelsPath = resolve(argStr('--labels', 'data/bring-labels.json'));

interface Label { mine: PokemonSet[]; opp: PokemonSet[]; best: string[] }
const raw: Label[] = JSON.parse(readFileSync(labelsPath, 'utf8'));
// Precompute opp entries + the best-bring species set per scenario once.
const data = raw.map(l => ({ mine: l.mine, opp: l.opp.map(entryOf), best: new Set(l.best) }));
// Interleaved 20% held-out test split (every 5th scenario) to gauge overfit.
const test = data.filter((_, i) => i % 5 === 0);
const train = data.filter((_, i) => i % 5 !== 0);

const matches = (W: BringWeights, set: typeof data): number => {
  let m = 0;
  for (const d of set) {
    const idx = scoreBrings(d.mine, d.opp, NEUTRAL_FIELD, W)[0]!.myIndices;
    if (idx.length === d.best.size && idx.every(i => d.best.has(d.mine[i]!.species))) m++;
  }
  return m;
};
const pct = (W: BringWeights, set: typeof data) => (set.length ? Math.round(100 * matches(W, set) / set.length) : 0);

console.log(`labels ${data.length} (train ${train.length} / test ${test.length}) from ${labelsPath}`);
console.log(`baseline    train ${pct(DEFAULT_BRING_WEIGHTS, train)}%   test ${pct(DEFAULT_BRING_WEIGHTS, test)}%`);

const KEYS = ['offense', 'defense', 'speed', 'matchup', 'speedControl', 'redirection', 'tactics', 'threat'] as const;
const MULT = [0, 0.5, 1, 2, 4];   // candidate = default[key] × mult
const W: BringWeights = { ...DEFAULT_BRING_WEIGHTS };
for (let pass = 1; pass <= 4; pass++) {
  let improved = false;
  for (const k of KEYS) {
    let bestVal = W[k]; let best = matches(W, train);
    for (const mult of MULT) {
      const v = DEFAULT_BRING_WEIGHTS[k] * mult;
      if (v === W[k]) continue;
      const sc = matches({ ...W, [k]: v }, train);
      if (sc > best) { best = sc; bestVal = v; improved = true; }
    }
    W[k] = bestVal;
  }
  console.error(`[calibrate] pass ${pass}: train ${pct(W, train)}%  test ${pct(W, test)}%`);
  if (!improved) break;
}

console.log(`calibrated  train ${pct(W, train)}%   test ${pct(W, test)}%`);
console.log('weights:', JSON.stringify(W));
console.log('(bake into DEFAULT_BRING_WEIGHTS in bring.ts if test agreement improved over baseline)');
