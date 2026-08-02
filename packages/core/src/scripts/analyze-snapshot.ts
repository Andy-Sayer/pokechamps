// analyze-snapshot.ts — run the deep search on a SAVED match's current board.
//
//   npx tsx packages/core/src/scripts/analyze-snapshot.ts --match <id>
//                  [--foresight N] [--depth D] [--budget MS]
//
// Loads matches/<id>.json (a live snapshot — press `s` in battle), takes the
// board as of the LAST finalized turn (actives from turns[last].post.active,
// all other state from the match's own current fields), builds the exact
// SearchInput the live app would see (unknown items stay unknown, spreads come
// from priors/inference — no hindsight), and prints the exact-model reference
// read plus the deep foresight read. Born from the 2026-07-28 perish loss:
// the app's live advice that turn is on the record, so a saved game is a
// benchmark the new engine can be judged against.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import {
  searchBudgeted, searchInputFromMatch, type ActiveSlots, type SearchBreadth, type SearchResult,
} from '../domain/endgameSearch.js';
import type { Match } from '../domain/types.js';

const arg = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const argS = (f: string, d: string) => { const i = process.argv.indexOf(f); return i >= 0 ? String(process.argv[i + 1]) : d; };
const MATCH_ID = argS('--match', '');
const FORESIGHT = arg('--foresight', 2);
const DEPTH = arg('--depth', 5);
const BUDGET = arg('--budget', 240_000);
if (!MATCH_ID) { console.error('usage: analyze-snapshot --match <id> [--foresight N] [--depth D] [--budget MS]'); process.exit(1); }

const match: Match = JSON.parse(readFileSync(join(dirname(dataDirPath()), 'matches', `${MATCH_ID}.json`), 'utf8'));
const lastPost = match.turns[match.turns.length - 1]?.post as { active?: { mine: [number | null, number | null]; theirs: [number | null, number | null] } } | undefined;
const active: ActiveSlots = lastPost?.active ?? { mine: [match.bring[0] ?? null, match.bring[1] ?? null], theirs: [match.opponentBrought?.[0] ?? null, match.opponentBrought?.[1] ?? null] };

console.log(`match ${match.id} · ${match.turns.length} turn(s) finalized · actives mine=[${active.mine}] theirs=[${active.theirs}]`);
console.log(`mine: ${match.bring.map(i => `${match.myTeam[i]!.species}${match.myPerishCount?.[i] != null ? ` (perish ${match.myPerishCount[i]})` : ''}`).join(', ')}`);
console.log(`theirs (revealed): ${(match.opponentBrought ?? []).map(i => { const o = match.opponentTeam[i]!; return `${o.species}${o.megaUsed ? ' (mega)' : ''}${o.perishCount != null ? ` (perish ${o.perishCount})` : ''}`; }).join(', ')}`);

const input = searchInputFromMatch(match, active);

function run(label: string, breadth: SearchBreadth | undefined, maxDepth: number): SearchResult {
  const t0 = performance.now();
  const r = searchBudgeted(input, maxDepth, BUDGET, undefined, breadth);
  const ms = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`\n[${label}] d${r.depth} in ${ms}s · ${r.verdict}${r.forced ? ' (FORCED)' : ''} · score ${Math.round(r.score)}`);
  console.log(`  plays: ${r.plays.map(p => `${p.mySpecies} ${p.move} → ${p.targetSpecies}`).join(' · ') || '(none)'}${r.megaMon ? ` · mega ${r.megaMon}` : ''}`);
  if (r.oppLine?.length) console.log(`  their line: ${r.oppLine.map(p => `${p.mySpecies} ${p.move}`).join(' · ')}`);
  if (r.perishTrap) console.log(`  perish: ${JSON.stringify(r.perishTrap).slice(0, 260)}`);
  return r;
}

run('exact · reference', undefined, 3);
run(`foresight ${FORESIGHT} · deep`, { oppForesight: FORESIGHT }, DEPTH);
