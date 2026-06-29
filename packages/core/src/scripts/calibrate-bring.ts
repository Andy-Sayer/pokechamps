// Calibrate scoreBrings' weights to the playout ground truth (data/bring-truth.*.json
// from `bring-search ... --save`). For a weight set, scoreBrings' top-1 bring per
// opponent is looked up in the truth; REGRET = (best bring's maximin wr) - (top-1's
// wr). We coordinate-search the key weights to minimise total regret — i.e. make
// the fast heuristic pick what the exhaustive sim would. Offline + cheap (no
// playouts here): the expensive truth is computed once.
//   npx tsx packages/core/src/scripts/calibrate-bring.ts [team.json] [truth.json]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, CHAMPIONS_PIKA_FORMAT } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings, DEFAULT_BRING_WEIGHTS, type BringWeights } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { NEUTRAL_FIELD } from '../domain/types.js';
import { MB_THREATS } from './mbThreats.js';
import type { PokemonSet } from '../domain/types.js';

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const TEAM = positional[0] ?? 'anti-meta-mb.json';
const TRUTH = positional[1] ?? `bring-truth.${CHAMPIONS_PIKA_FORMAT}.json`;

type Truth = { anchor: string; brings: { species: string[]; maximinWr: number }[] }[];
const myTeam = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', TEAM), 'utf8')) as PokemonSet[];
const truth = JSON.parse(readFileSync(join(dataDirPath(), TRUTH), 'utf8')) as Truth;

// Reconstruct the opponents that produced the truth, keyed by anchor.
const oppByAnchor = new Map<string, PokemonSet[]>();
for (const m of MB_THREATS) oppByAnchor.set(m.anchor, m.sets);
for (const m of metaTeams(loadPikaData(), 12, 4)) oppByAnchor.set(m.anchor, m.sets);

const key = (a: string[]) => [...a].sort().join(',');
const pct = (x: number) => `${Math.round(x * 100)}%`;

interface Fit { totalRegret: number; avgRegret: number; matches: number; n: number; per: { anchor: string; regret: number; top1: string[]; best: string[] }[] }
function evaluate(w: BringWeights): Fit {
  let totalRegret = 0, matches = 0, n = 0;
  const per: Fit['per'] = [];
  for (const t of truth) {
    const sets = oppByAnchor.get(t.anchor);
    if (!sets || t.brings.length === 0) continue;
    const ranked = scoreBrings(myTeam, sets.map(entryOf), NEUTRAL_FIELD, w);
    const top1 = ranked[0]!.myIndices.map(i => myTeam[i]!.species);
    const top1wr = t.brings.find(b => key(b.species) === key(top1))?.maximinWr ?? 0;
    const bestRow = t.brings.reduce((a, b) => (b.maximinWr > a.maximinWr ? b : a));
    const regret = bestRow.maximinWr - top1wr;
    totalRegret += regret; n++;
    if (regret < 1e-9) matches++;
    per.push({ anchor: t.anchor, regret, top1, best: bestRow.species });
  }
  return { totalRegret, avgRegret: totalRegret / n, matches, n, per };
}

function report(label: string, w: BringWeights, f: Fit) {
  console.log(`\n${label}  weights{off:${w.offense} def:${w.defense} match:${w.matchup} spd:${w.speed}}`);
  console.log(`  matches ${f.matches}/${f.n} brings   avg regret ${pct(f.avgRegret)}   total ${pct(f.totalRegret)}`);
}

const base = evaluate(DEFAULT_BRING_WEIGHTS);
report('BASELINE (current defaults)', DEFAULT_BRING_WEIGHTS, base);
console.log('  per-opponent misses (heuristic top-1 vs truth-best):');
base.per.filter(p => p.regret > 0.01).sort((a, b) => b.regret - a.regret)
  .forEach(p => console.log(`    -${Math.round(p.regret * 100)}pp  ${p.anchor.padEnd(28)} picks ${p.top1.join('/')} not ${p.best.join('/')}`));

// Coordinate grid over the three damage/type levers (others held at default).
const OFF = [0.2, 0.4, 0.6, 0.8];
const DEF = [0.3, 0.6, 1.0, 1.5, 2.0];
const MATCH = [0, 1, 2, 4, 8];
// drift = distance from the current defaults; tie-break toward it so we don't
// overfit a coarse truth with extreme weights when a near-default combo ties.
const drift = (w: BringWeights) => Math.abs(w.offense - 0.4) + Math.abs(w.defense - 0.3) / 2 + Math.abs(w.matchup - 8) / 8;
const candidates: { w: BringWeights; f: Fit }[] = [];
for (const offense of OFF) for (const defense of DEF) for (const matchup of MATCH) {
  const w = { ...DEFAULT_BRING_WEIGHTS, offense, defense, matchup };
  candidates.push({ w, f: evaluate(w) });
}
candidates.sort((a, b) =>
  (a.f.totalRegret - b.f.totalRegret) || (b.f.matches - a.f.matches) || (drift(a.w) - drift(b.w)));
console.log('\ntop weight candidates (regret · matches · drift-from-default — prefer low regret AND low drift):');
for (const c of candidates.slice(0, 8)) {
  console.log(`  regret ${pct(c.f.totalRegret).padStart(5)}  matches ${c.f.matches}/${c.f.n}  {off ${c.w.offense} def ${c.w.defense} match ${c.w.matchup}}  drift ${drift(c.w).toFixed(2)}`);
}
const best = candidates[0]!;
report('CALIBRATED (min-regret grid)', best.w, best.f);
console.log('  remaining misses:');
best.f.per.filter(p => p.regret > 0.01).sort((a, b) => b.regret - a.regret)
  .forEach(p => console.log(`    -${Math.round(p.regret * 100)}pp  ${p.anchor.padEnd(28)} picks ${p.top1.join('/')} not ${p.best.join('/')}`));
console.log(`\nΔ matches ${base.matches}→${best.f.matches}/${base.n}   Δ avg regret ${pct(base.avgRegret)}→${pct(best.f.avgRegret)}`);
console.log(`suggested DEFAULT_BRING_WEIGHTS: { offense: ${best.w.offense}, defense: ${best.w.defense}, matchup: ${best.w.matchup}, ... }`);
