// Policy audit: does the fast search recommend MY best move? For each meta
// opponent, build the opening position, run the search, then resolve the search's
// pick + every per-mon alternative through the real @pkmn/sim engine and report
// where a clearly-better move existed (regret, in HP-percent material points).
//
//   npx tsx packages/core/src/scripts/policy-audit.ts [--team NAME] [--depth N]
//                  [--seeds K] [--meta N] [--threshold T]
//
// Holds the partner + opponent at the search's own predicted plays, so a flagged
// regret means the search failed to best-respond to its OWN opp prediction under
// true dynamics — a real mispick (not just a deeper-line disagreement). Depth-1,
// so weight large regrets over small ones. Read with project_sim_oracle.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { buildMatchupInput } from '../domain/teamSim.js';
import { searchIterative } from '../domain/endgameSearch.js';
import { ensureSimLoaded } from '../domain/simBridge.js';
import { auditPosition, type PositionAudit } from '../domain/policyAudit.js';
import type { PokemonSet } from '../domain/types.js';

const arg = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const argS = (f: string, d: string) => { const i = process.argv.indexOf(f); return i >= 0 ? String(process.argv[i + 1]) : d; };
const TEAM = argS('--team', 'anti-meta');
const DEPTH = arg('--depth', 4);
const SEEDS = arg('--seeds', 12);
const META_N = arg('--meta', 12);
const THRESHOLD = arg('--threshold', 25);

async function main() {
  if (!(await ensureSimLoaded())) {
    console.error('@pkmn/sim is not available — install it (npm i @pkmn/sim) to run the policy audit.');
    process.exit(1);
  }
  const mine: PokemonSet[] = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', `${TEAM}.json`), 'utf8'));
  const pika = loadPikaData();
  const meta = metaTeams(pika, META_N, 3);
  console.log(`policy audit · team "${TEAM}" · ${meta.length} meta openings · search depth ${DEPTH} · ${SEEDS} sim seeds · flag ≥ ${THRESHOLD} pts\n`);

  const icon = (k: string) => k === 'mispick' ? '✖' : '·';
  const isReal = (k: string) => k === 'mispick';
  const audits: PositionAudit[] = [];
  for (const opp of meta) {
    const { input } = buildMatchupInput(mine, opp.sets);
    const result = searchIterative(input, DEPTH);
    const a = await auditPosition(input, result, opp.anchor, { seeds: SEEDS, flagThreshold: THRESHOLD });
    audits.push(a);
    const real = a.regrets.filter(r => isReal(r.kind));
    const tag = a.skipReason ? '· skipped' : real.length ? `· ${real.length} mispick(s)` : a.regrets.length ? '· clean (depth-1 setup only)' : '· clean';
    console.log(`vs ${opp.anchor.padEnd(18)} d${a.searchDepth} score ${String(a.searchScore).padStart(5)} ${tag}`);
    if (a.skipReason) console.log(`     ${a.skipReason}`);
    for (const r of a.regrets) {
      console.log(`     ${icon(r.kind)} [${r.kind}] ${r.mon}: search "${r.searchPlay}" (${r.searchValue}) — sim prefers "${r.bestPlay}" (${r.bestValue})  +${r.regret} pts confirmed (sweep +${r.sweepRegret})`);
    }
  }

  const allReal = audits.flatMap(a => a.regrets.filter(r => isReal(r.kind)));
  const artifacts = audits.flatMap(a => a.regrets.filter(r => !isReal(r.kind)));
  const skipped = audits.filter(a => a.skipReason).length;
  const positionsWithReal = audits.filter(a => a.regrets.some(r => isReal(r.kind))).length;
  const worst = allReal.sort((x, y) => y.regret - x.regret)[0];
  console.log(`\n=== summary ===`);
  console.log(`positions ${audits.length} · clean ${audits.length - positionsWithReal - skipped} · with real mispicks ${positionsWithReal} · skipped ${skipped}`);
  console.log(`confirmed mispicks ${allReal.length} (depth-1 setup/stall artifacts ${artifacts.length}, reported but not counted)`);
  if (worst) console.log(`worst: ${worst.mon} ${worst.searchPlay} → ${worst.bestPlay}  +${worst.regret} pts`);
}

main().catch(e => { console.error(e); process.exit(1); });
