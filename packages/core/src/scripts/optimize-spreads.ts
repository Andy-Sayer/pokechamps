// Spread optimizer: for each team mon, generate attack/speed breakpoint
// candidates that pour the freed SP into bulk, and let the PARALLEL maximin
// gauntlet decide which actually wins more games. Tests the thesis directly —
// if an attacker only 2HKOs a target, the candidate with bulk (that survives
// the return hit) should out-score the full-offense one in simulated battle.
//
//   NODE_OPTIONS=--max-old-space-size=8192 npx tsx packages/core/src/scripts/optimize-spreads.ts --save
//   flags: --scout N (shortlist depth, default 2) · --verify N (decision depth,
//          default 4) · --hours H (wall-clock budget, default 12) · --meta N
//
// Coordinate descent: per mon, scout every candidate at --scout, verify the top
// few at --verify, adopt the best that beats the incumbent, loop mons, repeat
// rounds until no improvement or the deadline. Saves best-so-far on every
// improvement so a long run is never lost.
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId } from '../domain/data.js';
import { spFromEv } from '../domain/pikalytics.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { MatchupPool } from '../domain/matchupPool.js';
import { candidateSpreads } from '../domain/breakpoints.js';
import type { PokemonSet } from '../domain/types.js';

const arg = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const SAVE = process.argv.includes('--save');
const SCOUT = arg('--scout', 2);
// Decision depth defaults to 3: the depth that validated the floor-0 team and
// the practical ceiling for a 12h multi-gauntlet run (the bulky Aegislash board
// explodes past it). --verify 4 is available if you accept far fewer rounds.
const VERIFY = arg('--verify', 3);
const HOURS = arg('--hours', 12);
const META_N = arg('--meta', 12);
const MAX_OVERLAP = 3;
const deadline = Date.now() + HOURS * 3600_000;
const timeLeft = () => Math.max(0, deadline - Date.now());
const hhmm = (ms: number) => `${Math.floor(ms / 3600000)}h${String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')}m`;

const pika = loadPikaData();
const meta = metaTeams(pika, META_N, MAX_OVERLAP);
const defenders = meta.flatMap(m => m.sets).filter((s, i, a) => a.findIndex(x => x.species === s.species) === i);
const pool = new MatchupPool();
console.log(`spread optimizer · ${meta.length} meta teams · scout d${SCOUT} / verify d${VERIFY} · budget ${HOURS}h`);

const teamPath = join(dataDirPath(), 'my-teams', 'anti-meta.json');
let team: PokemonSet[] = JSON.parse(readFileSync(teamPath, 'utf8'));

interface Fit { floor: number; avg: number }
const better = (a: Fit, b: Fit) => (a.floor !== b.floor ? a.floor > b.floor : a.avg > b.avg);

async function fitness(t: PokemonSet[], depth: number, abortBelow?: number): Promise<Fit | null> {
  const ms = await pool.run(meta.map(opp => ({ mine: t, oppSets: opp.sets, oppAnchor: opp.anchor, depth })));
  const floor = Math.min(...ms.map(m => m.score));
  if (abortBelow != null && floor < abortBelow) return null;
  return { floor, avg: ms.reduce((s, m) => s + m.score, 0) / ms.length };
}

function spStr(s: PokemonSet): string {
  const k: [keyof typeof s.evs, string][] = [['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Spe']];
  return k.map(([e, n]) => [spFromEv(s.evs[e]), n] as const).filter(([v]) => v > 0).map(([v, n]) => `${v} ${n}`).join(' / ');
}
const rainMon = (s: PokemonSet) => s.moves.some(m => /hurricane|weather ball/i.test(m)) || toId(s.ability ?? '') === 'drizzle';

console.log('\nbaseline at verify depth…');
let baseFit = (await fitness(team, VERIFY))!;
console.log(`  floor ${Math.round(baseFit.floor)} avg ${Math.round(baseFit.avg)}`);
const original = team.map(s => ({ species: s.species, spread: spStr(s) }));

let round = 0;
while (timeLeft() > 0) {
  round++;
  let improved = false;
  console.log(`\n=== round ${round} (${hhmm(timeLeft())} left) ===`);
  for (let i = 0; i < team.length; i++) {
    if (timeLeft() <= 0) break;
    const mon = team[i]!;
    const cands = candidateSpreads(mon, defenders, defenders, rainMon(mon));
    console.log(`\n${mon.species}: ${cands.length} candidate spreads`);
    // Scout every candidate cheaply.
    const scored: { label: string; set: PokemonSet; f: Fit }[] = [];
    for (const c of cands) {
      if (timeLeft() <= 0) break;
      const trial = team.map((s, k) => (k === i ? c.set : s));
      const f = await fitness(trial, SCOUT);
      if (f) scored.push({ ...c, f });
    }
    scored.sort((a, b) => (better(a.f, b.f) ? -1 : 1));
    // Verify the top few deep; adopt the first that beats the incumbent.
    for (const c of scored.slice(0, 3)) {
      if (timeLeft() <= 0) break;
      const trial = team.map((s, k) => (k === i ? c.set : s));
      const f = await fitness(trial, VERIFY, baseFit.floor);
      if (f && better(f, baseFit)) {
        console.log(`  ADOPT ${c.label}: floor ${Math.round(f.floor)} avg ${Math.round(f.avg)}  [${spStr(c.set)}]`);
        team = trial; baseFit = f; improved = true;
        if (SAVE) writeFileSync(teamPath, JSON.stringify(team, null, 2));
        break;
      }
    }
    if (!improved || scored.length === 0) console.log(`  (kept ${spStr(mon)})`);
  }
  if (!improved) { console.log('\nno improvement this round — converged.'); break; }
}

console.log('\n=== OPTIMIZED SPREADS ===');
team.forEach((s, i) => {
  const ch = original[i]!.spread !== spStr(s) ? '  <- changed' : '';
  console.log(`  ${s.species.padEnd(11)} ${s.nature.padEnd(8)} ${spStr(s)}${ch}`);
});
console.log(`\nfinal floor ${Math.round(baseFit.floor)} avg ${Math.round(baseFit.avg)} (was floor ${Math.round((await fitness(team, VERIFY))!.floor)})`);
if (SAVE) { writeFileSync(teamPath, JSON.stringify(team, null, 2)); console.log(`saved ${teamPath}`); }
pool.close();
