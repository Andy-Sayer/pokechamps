// Reg M-B team stress-test. The gauntlet is the REAL M-B Pikalytics meta
// (reconstructed from data/pikalytics.gen9championsvgc2026regmb.json via
// metaTeams — top-usage anchors filled by their teammate correlations) PLUS the
// hand-built M-B threat teams kept as off-meta spice (strong calc-correct
// megas: Mawile / Metagross / Swampert-rain / Raichu-X / Blaziken).
//
//   npx tsx packages/core/src/scripts/mb-team-check.ts [team.json] [--depth N] [--meta N]
//
// Reports each matchup's maximin score (under mutual best play; + favors us),
// the floor + average over the real meta gauntlet and over the hand threats
// separately. Labels: [meta] = real-usage teams, [hand] = hand-built threats.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, groundedTeams } from '../domain/metaTeams.js';
import { loadCreatorThreats } from '../domain/creatorIntel.js';
import { MatchupPool } from '../domain/matchupPool.js';
import type { PokemonSet } from '../domain/types.js';
import { MB_THREATS } from './mbThreats.js';

const argNum = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const DEPTH = argNum('--depth', 5);
const META_N = argNum('--meta', 8);
// --bringK > 1 makes the bring a searched MAXIMIN over each side's top-K
// candidate brings instead of the scoreBrings top-1 heuristic. --allBrings sets
// MY side exhaustive (all 15 of C(6,4) — "simulate every permutation", the
// offline ground truth); --oppBringK tunes the opponent's response breadth
// separately (kept smaller for tractability). Cost ~ bringK × oppBringK per
// board; pair with a smaller --budget.
const BRING_K = process.argv.includes('--allBrings') ? 15 : argNum('--bringK', 1);
const OPP_BRING_K = argNum('--oppBringK', BRING_K);
// Budgeted anytime deepening (1→DEPTH under a per-board wall-clock cap) matches
// how the validated baseline was scored. This momentum team (rain + double
// Tailwind) is badly under-rated at a shallow FIXED depth — its payoff sits near
// the horizon (depth 3 read it ~-1000, depth 5 ~+20). 0 disables (fixed depth).
const BUDGET = argNum('--budget', 20000);
const teamArg = process.argv.slice(2).find(a => a.endsWith('.json'));
const teamPath = teamArg ? (teamArg.includes('/') || teamArg.includes('\\') ? teamArg : join(dataDirPath(), 'my-teams', teamArg))
  : join(dataDirPath(), 'my-teams', 'anti-meta.json');

const team: PokemonSet[] = JSON.parse(readFileSync(teamPath, 'utf8'));
const pika = loadPikaData();
const meta = groundedTeams(pika, { minCore: 4, limit: META_N });
const creator = loadCreatorThreats(); // emerging threats harvested from creator videos
const gauntlet = [
  ...meta.map(m => ({ anchor: `[meta] ${m.anchor}`, sets: m.sets })),
  ...MB_THREATS.map(m => ({ anchor: `[hand] ${m.anchor}`, sets: m.sets })),
  ...creator, // already tagged "[creator] <name>"
];

console.log(`team: ${teamPath.split(/[\\/]/).pop()} — ${team.map(s => s.species).join(', ')}`);
console.log(`gauntlet: ${meta.length} real M-B meta teams + ${MB_THREATS.length} hand threats${creator.length ? ` + ${creator.length} creator threats` : ''} · deepen 1→${DEPTH}${BUDGET ? ` · ${BUDGET / 1000}s/board` : ' (fixed)'} · bring ${BRING_K >= 15 ? 'EXHAUSTIVE (all 15)' : `top-${BRING_K}`}×opp-${OPP_BRING_K}${BRING_K > 1 ? ' searched' : ' heuristic'}\n`);

const pool = new MatchupPool();
const results = await pool.run(gauntlet.map(g => ({ mine: team, oppSets: g.sets, oppAnchor: g.anchor, depth: DEPTH, budgetMs: BUDGET || undefined, bringK: BRING_K, oppBringK: OPP_BRING_K })));
pool.close();

const rows = gauntlet.map((g, i) => ({ anchor: g.anchor, score: results[i]!.score, verdict: results[i]!.verdict, bring: results[i]!.myBring }));
rows.sort((a, b) => a.score - b.score);
for (const r of rows) {
  console.log(`  ${r.anchor.padEnd(28)} ${String(Math.round(r.score)).padStart(6)}  ${r.verdict.padEnd(7)}  bring: ${r.bring.join(', ')}`);
}
const stat = (xs: number[]) => ({ floor: Math.min(...xs), avg: Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) });
const handScores = rows.filter(r => r.anchor.startsWith('[hand]')).map(r => r.score);
const metaScores = rows.filter(r => r.anchor.startsWith('[meta]')).map(r => r.score);
const all = stat(rows.map(r => r.score));
console.log(`\nMETA  floor ${Math.round(stat(metaScores).floor)}  avg ${stat(metaScores).avg}`);
console.log(`HAND  floor ${Math.round(stat(handScores).floor)}  avg ${stat(handScores).avg}`);
console.log(`ALL   floor ${Math.round(all.floor)}  avg ${all.avg}`);
