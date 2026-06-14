// Spread optimizer (time-budgeted). For each team mon, generate attack/speed
// breakpoint candidates that pour the freed SP into bulk, and let the PARALLEL
// gauntlet decide which wins more games — directly testing "if I only 2HKO a
// target, do I want bulk to survive the return hit?".
//
//   NODE_OPTIONS=--max-old-space-size=8192 npx tsx packages/core/src/scripts/optimize-spreads.ts --save
//   flags: --budget MS (per-matchup wall-clock, default 25000) · --maxdepth N
//          (iterative-deepening cap, default 5) · --threads N (default 20) ·
//          --hours H (total budget, default 12) · --meta N
//
// Every matchup search deepens 1→maxdepth under the per-position budget — fast
// boards reach depth 5, the pathologically wide ones return the deepest depth
// that fit in the budget (anytime). Coordinate descent: per mon, evaluate ALL
// candidate spreads in one big parallel batch, adopt the best that beats the
// incumbent, loop until no improvement or the deadline. Saves on every gain.
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId } from '../domain/data.js';
import { spFromEv } from '../domain/pikalytics.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { MatchupPool, type MatchupTask } from '../domain/matchupPool.js';
import { candidateSpreads } from '../domain/breakpoints.js';
import type { Matchup } from '../domain/teamSim.js';
import type { PokemonSet } from '../domain/types.js';

const arg = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const SAVE = process.argv.includes('--save');
const BUDGET = arg('--budget', 25000);
const MAXDEPTH = arg('--maxdepth', 5);
const THREADS = arg('--threads', 20);
const HOURS = arg('--hours', 12);
const META_N = arg('--meta', 12);
const MAX_OVERLAP = 3;
const deadline = Date.now() + HOURS * 3600_000;
const timeLeft = () => Math.max(0, deadline - Date.now());
const hhmm = (ms: number) => `${Math.floor(ms / 3600000)}h${String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')}m`;

const pika = loadPikaData();
const meta = metaTeams(pika, META_N, MAX_OVERLAP);
const defenders = meta.flatMap(m => m.sets).filter((s, i, a) => a.findIndex(x => x.species === s.species) === i);
const pool = new MatchupPool(THREADS);
console.log(`spread optimizer · ${meta.length} meta teams · ${BUDGET / 1000}s/matchup, deepen 1→${MAXDEPTH} · ${THREADS} threads · budget ${HOURS}h`);

const teamPath = join(dataDirPath(), 'my-teams', 'anti-meta.json');
let team: PokemonSet[] = JSON.parse(readFileSync(teamPath, 'utf8'));

interface Fit { floor: number; avg: number }
const better = (a: Fit, b: Fit) => (a.floor !== b.floor ? a.floor > b.floor : a.avg > b.avg);
const fitOf = (ms: Matchup[]): Fit => ({ floor: Math.min(...ms.map(m => m.score)), avg: ms.reduce((s, m) => s + m.score, 0) / ms.length });
const tasksFor = (t: PokemonSet[]): MatchupTask[] => meta.map(opp => ({ mine: t, oppSets: opp.sets, oppAnchor: opp.anchor, depth: MAXDEPTH, budgetMs: BUDGET }));

function spStr(s: PokemonSet): string {
  const k: [keyof typeof s.evs, string][] = [['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Spe']];
  return k.map(([e, n]) => [spFromEv(s.evs[e]), n] as const).filter(([v]) => v > 0).map(([v, n]) => `${v} ${n}`).join(' / ');
}
const rainMon = (s: PokemonSet) => s.moves.some(m => /hurricane|weather ball/i.test(m)) || toId(s.ability ?? '') === 'drizzle';

console.log('\nbaseline…');
let baseFit = fitOf(await pool.run(tasksFor(team)));
console.log(`  floor ${Math.round(baseFit.floor)} avg ${Math.round(baseFit.avg)}`);
const original = team.map(s => spStr(s));

let roundN = 0;
while (timeLeft() > 0) {
  roundN++;
  let improved = false;
  console.log(`\n=== round ${roundN} (${hhmm(timeLeft())} left) ===`);
  for (let i = 0; i < team.length; i++) {
    if (timeLeft() <= 0) break;
    const cands = candidateSpreads(team[i]!, defenders, defenders, rainMon(team[i]!));
    // One big parallel batch: every candidate × every meta opponent.
    const t0 = Date.now();
    const flat: MatchupTask[] = cands.flatMap(c => meta.map(opp => ({ mine: team.map((s, k) => (k === i ? c.set : s)), oppSets: opp.sets, oppAnchor: opp.anchor, depth: MAXDEPTH, budgetMs: BUDGET })));
    const results = await pool.run(flat);
    // Aggregate back per candidate (results are in input order).
    type Best = { label: string; set: PokemonSet; fit: Fit };
    const scored: Best[] = cands.map((c, ci) => ({ label: c.label, set: c.set, fit: fitOf(results.slice(ci * meta.length, (ci + 1) * meta.length)) }));
    const best: Best | undefined = scored.reduce<Best | undefined>((b, c) => (!b || better(c.fit, b.fit) ? c : b), undefined);
    const wall = Math.round((Date.now() - t0) / 1000);
    if (best && better(best.fit, baseFit)) {
      console.log(`  ${team[i]!.species}: ADOPT ${best.label} -> floor ${Math.round(best.fit.floor)} avg ${Math.round(best.fit.avg)}  [${spStr(best.set)}]  (${cands.length} cands, ${wall}s)`);
      team[i] = best.set; baseFit = best.fit; improved = true;
      if (SAVE) writeFileSync(teamPath, JSON.stringify(team, null, 2));
    } else {
      console.log(`  ${team[i]!.species}: kept ${spStr(team[i]!)} (best cand floor ${best ? Math.round(best.fit.floor) : '—'}, ${cands.length} cands, ${wall}s)`);
    }
  }
  if (!improved) { console.log('\nno improvement this round — converged.'); break; }
}

console.log('\n=== OPTIMIZED SPREADS ===');
team.forEach((s, i) => console.log(`  ${s.species.padEnd(11)} ${s.nature.padEnd(8)} ${spStr(s)}${original[i] !== spStr(s) ? '  <- changed' : ''}`));
console.log(`\nfinal floor ${Math.round(baseFit.floor)} avg ${Math.round(baseFit.avg)}`);
if (SAVE) { writeFileSync(teamPath, JSON.stringify(team, null, 2)); console.log(`saved ${teamPath}`); }
pool.close();
