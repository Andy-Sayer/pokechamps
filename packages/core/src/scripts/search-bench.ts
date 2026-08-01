// search-bench: the ACCEPTANCE TEST for the live-search perf arc.
//
// Requirement (user, 2026-08-01): the always-on recommender must reach depth ≥4
// comfortably inside the turn timer — depth 4 is the Perish Song horizon. Live
// today it completes ~2 deepening iterations in half the timer. This script
// measures exactly that experience on the worst position the search ever faces:
// TURN 1 — full 4v4, only the two opponent leads revealed, spreads from priors.
//
//   npx tsx packages/core/src/scripts/search-bench.ts [--team NAME] [--meta N]
//                  [--depth D] [--budget MS]
//
// Two scenarios per opponent:
//   live     — species-only OpponentEntry, via searchInputFromMatch (what the
//              TUI actually feeds the search on turn 1)
//   gauntlet — fully-known opponent sets via buildMatchupInput (the fixture
//              the offline tools use; the lower bound on live cost)
// For each: table-build time (createSearch), then wall time + nodes per
// completed depth, then the PRODUCTION widening schedule so the numbers map
// 1:1 onto what the user sees in battle.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { buildMatchupInput } from '../domain/teamSim.js';
import { scoreBrings } from '../domain/bring.js';
import {
  createSearch, searchBudgeted, searchInputFromMatch, wideningSchedule,
  type ActiveSlots, type SearchInput,
} from '../domain/endgameSearch.js';
import { NEUTRAL_FIELD, type Match, type OpponentEntry, type PokemonSet } from '../domain/types.js';

const arg = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const argS = (f: string, d: string) => { const i = process.argv.indexOf(f); return i >= 0 ? String(process.argv[i + 1]) : d; };
const TEAM = argS('--team', 'TalonFlameAndyBoy');
const META_N = arg('--meta', 1);
const MAX_DEPTH = arg('--depth', 5);
const BUDGET_MS = arg('--budget', 120_000);

/** Turn-1 Match: my bring picked, both leads out, opp = leads revealed only. */
function turnOneMatch(mine: PokemonSet[], oppSets: PokemonSet[]): { match: Match; active: ActiveSlots } {
  const opponentTeam: OpponentEntry[] = oppSets.map(s => ({ species: s.species, knownMoves: [] }));
  const bring = scoreBrings(mine, opponentTeam)[0]!.myIndices;
  // Opp leads: their bring heuristic's first two (a stand-in for their preview
  // choice — the cost profile only cares that exactly two are revealed).
  const oppBring = scoreBrings(oppSets, mine.map(s => ({ species: s.species, knownMoves: [] })))[0]!.myIndices;
  const leads = oppBring.slice(0, 2);
  const match: Match = {
    id: 'bench', startedAt: '2026-08-01T00:00:00.000Z',
    myTeam: mine, opponentTeam, bring,
    opponentBrought: leads,               // turn 1: only the leads are revealed
    turns: [], field: NEUTRAL_FIELD,
    active: { mine: [bring[0]!, bring[1]!], theirs: [leads[0]!, leads[1]!] },
  } as Match;
  const active: ActiveSlots = { mine: [bring[0]!, bring[1]!], theirs: [leads[0]!, leads[1]!] };
  return { match, active };
}

function benchInput(label: string, input: SearchInput): void {
  const t0 = performance.now();
  createSearch(input);                          // isolate table/matrix build cost
  const buildMs = performance.now() - t0;
  console.log(`\n  [${label}] table build ${buildMs.toFixed(0)}ms`);

  let lastT = performance.now(); let lastNodes = 0;
  const rows: string[] = [];
  searchBudgeted(input, MAX_DEPTH, BUDGET_MS, r => {
    const now = performance.now();
    const nodes = (r.nodes ?? 0) - lastNodes;
    rows.push(`    depth ${r.depth}: ${(now - lastT).toFixed(0)}ms · ${nodes} nodes · score ${r.score} · ${r.verdict}`);
    lastT = now; lastNodes = r.nodes ?? 0;
  });
  for (const row of rows) console.log(row);

  // The production experience: the widening tiers the TUI actually runs.
  console.log(`    — production widening schedule —`);
  const liveTotal = input.mine.filter(m => m.hpPercent > 0).length + input.opp.filter(o => o.hpPercent > 0).length;
  for (const tier of wideningSchedule(liveTotal)) {
    const t = performance.now();
    const r = searchBudgeted(input, tier.maxDepth, tier.budgetMs, undefined, tier.breadth);
    console.log(`    tier "${tier.label}" (cap d${tier.maxDepth}, ${tier.budgetMs}ms): reached depth ${r.depth} in ${(performance.now() - t).toFixed(0)}ms`);
  }
}

function main(): void {
  const mine: PokemonSet[] = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', `${TEAM}.json`), 'utf8'));
  const meta = metaTeams(loadPikaData(), META_N, 3);
  console.log(`search-bench · team "${TEAM}" · ${meta.length} meta opponent(s) · depth cap ${MAX_DEPTH} · budget ${BUDGET_MS}ms`);
  console.log(`machine: ${process.arch} · node ${process.version}`);

  for (const opp of meta) {
    console.log(`\n=== vs ${opp.anchor} (${opp.sets.map(s => s.species).join(', ')}) ===`);
    const { match, active } = turnOneMatch(mine, opp.sets);
    benchInput('live · turn-1, leads only, prior spreads', searchInputFromMatch(match, active));
    benchInput('gauntlet · full-knowledge opening', buildMatchupInput(mine, opp.sets).input);
  }
}

main();
