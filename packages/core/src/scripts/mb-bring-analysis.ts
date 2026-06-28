// Calibration harness for the LIVE bring heuristic against the OFFLINE
// exhaustive ground truth. Live battles can't afford to search all 15 brings, so
// the in-battle recommendation uses scoreBrings — but we want it to APPROXIMATE
// what full simulation would pick. This measures the gap: over a corpus of
// (mine, opp) matchups, under a fixed opponent response breadth (oppK), it
// computes
//   - the heuristic's top-1 bring + its maximin score   (bringK 1)
//   - the exhaustive best bring + its score             (bringK 15)
// and reports agreement %, the score the heuristic LEAVES ON THE TABLE, and the
// worst mismatches (the patterns to fix / weights to retune). Read-only.
//
//   NODE_OPTIONS=--max-old-space-size=8192 \
//     npx tsx packages/core/src/scripts/mb-bring-analysis.ts [--meta N] [--oppK O] [--budget ms] [--depth N] [--team file.json]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { MatchupPool, type MatchupTask } from '../domain/matchupPool.js';
import type { PokemonSet } from '../domain/types.js';

const argNum = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const argStr = (f: string, d: string) => { const i = process.argv.indexOf(f); return i >= 0 ? String(process.argv[i + 1]) : d; };
const META_N = argNum('--meta', 8);
const OPP_K = argNum('--oppK', 3);
const DEPTH = argNum('--depth', 5);
const BUDGET = argNum('--budget', 3000);
const MY_TEAM = argStr('--team', 'anti-meta-mb.json');

const pika = loadPikaData();

// Corpus = our team + the real-meta teams. Every team plays BOTH sides, so the
// heuristic is tested as "mine" across realistic opponents.
const corpus: { label: string; sets: PokemonSet[] }[] = [];
try {
  corpus.push({ label: MY_TEAM.replace('.json', ''), sets: JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', MY_TEAM), 'utf8')) });
} catch { /* no saved team — meta-only corpus */ }
for (const m of metaTeams(pika, META_N, 3)) corpus.push({ label: m.anchor, sets: m.sets });

const scenarios: { mi: number; oi: number }[] = [];
for (let mi = 0; mi < corpus.length; mi++) for (let oi = 0; oi < corpus.length; oi++) if (mi !== oi) scenarios.push({ mi, oi });

console.log(`corpus ${corpus.length} teams · ${scenarios.length} matchups · oppK ${OPP_K} · budget ${BUDGET / 1000}s · deepen 1→${DEPTH}`);
console.log(`comparing heuristic top-1 bring vs EXHAUSTIVE best bring (all 15)\n`);

// Two tasks per scenario: heuristic (bringK 1) and exhaustive (bringK 15), both
// under the same opp response breadth so the score gap is apples-to-apples.
const tasks: MatchupTask[] = scenarios.flatMap(s => {
  const mine = corpus[s.mi]!.sets; const opp = corpus[s.oi]!;
  const base = { mine, oppSets: opp.sets, oppAnchor: opp.label, depth: DEPTH, budgetMs: BUDGET, oppBringK: OPP_K };
  return [{ ...base, bringK: 1 }, { ...base, bringK: 15 }];
});

const pool = new MatchupPool();
const res = await pool.run(tasks);
pool.close();

const setEq = (a: string[], b: string[]) => a.length === b.length && new Set([...a, ...b]).size === a.length;
interface Row { mine: string; opp: string; heur: string[]; exh: string[]; gap: number; match: boolean }
const rows: Row[] = scenarios.map((s, i) => {
  const heur = res[2 * i]!; const exh = res[2 * i + 1]!;
  return { mine: corpus[s.mi]!.label, opp: corpus[s.oi]!.label, heur: heur.myBring, exh: exh.myBring, gap: exh.score - heur.score, match: setEq(heur.myBring, exh.myBring) };
});

const n = rows.length;
const matches = rows.filter(r => r.match).length;
const gaps = rows.map(r => Math.max(0, r.gap)); // exhaustive includes the heuristic's bring → gap ≥ 0 (clamp search noise)
const mean = gaps.reduce((a, b) => a + b, 0) / n;
const sorted = [...gaps].sort((a, b) => a - b);
const median = sorted[Math.floor(n / 2)]!;
const bigGaps = rows.filter(r => r.gap > 50).length;

console.log(`AGREEMENT  heuristic bring == exhaustive best: ${matches}/${n} (${Math.round(100 * matches / n)}%)`);
console.log(`SCORE LEFT ON TABLE  mean ${Math.round(mean)} · median ${Math.round(median)} · max ${Math.round(Math.max(...gaps))}`);
console.log(`material mispicks (gap > 50): ${bigGaps}/${n} (${Math.round(100 * bigGaps / n)}%)\n`);

console.log('worst mismatches (where the live heuristic would misplay the bring):');
for (const r of rows.filter(r => !r.match).sort((a, b) => b.gap - a.gap).slice(0, 12)) {
  console.log(`  ${r.mine}  vs  ${r.opp}   gap ${Math.round(r.gap)}`);
  console.log(`     heuristic: ${r.heur.join(', ')}`);
  console.log(`     exhaustive: ${r.exh.join(', ')}`);
}
