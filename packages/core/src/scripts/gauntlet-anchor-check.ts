// Does each gauntlet team actually BRING the mega it is named after?
//
//   npx tsx packages/core/src/scripts/gauntlet-anchor-check.ts [team.json]
//
// WHY THIS EXISTS. Every threat team in mbThreats/mcThreats is named for its
// mega ("Mega Salamence (Aerilate)"), but the matchup evaluator does not force
// that mon into the opponent's four — it takes scoreBrings' top-1 heuristic
// bring for that side. And scoreBrings scores a stone holder on its BASE forme's
// stats: `bring.ts` only swaps in the mega forme once `entry.megaUsed` is set,
// which happens when /mega is LOGGED in a live battle, never at preview time.
//
// A held mega stone is a guaranteed mega, so for a side scoring its OWN bring
// that is simply wrong, and it is wrong in a specific direction: mons whose
// whole point is the mega get benched. Mega Mawile is the clearest case —
// base Mawile without Huge Power reads as a weak 50/85/85 mon, so the "Mega
// Mawile" matchup is scored against a team that never brings Mawile.
//
// The consequence is that a gauntlet row can be named after a mega it never
// tested. Run this before trusting any per-mega number.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { getMegaOptions } from '../domain/gimmicks/mega.js';
import { ALL_THREATS } from './mcThreats.js';
import type { PokemonSet } from '../domain/types.js';

const teamArg = process.argv.slice(2).find(a => a.endsWith('.json'));
const teamPath = teamArg
  ? (teamArg.includes('/') || teamArg.includes('\\') ? teamArg : join(dataDirPath(), 'my-teams', teamArg))
  : join(dataDirPath(), 'my-teams', 'TalonFlameAndyBoy.json');
const team: PokemonSet[] = JSON.parse(readFileSync(teamPath, 'utf8'));

/** True when this set holds the mega stone for its own species. */
export const holdsOwnStone = (s: PokemonSet): boolean =>
  getMegaOptions(s.species).some(m => m.stone.toLowerCase() === (s.item ?? '').toLowerCase());

/** Rank (1-based) of the first opponent bring containing `idx`, and whether the
 *  heuristic top-1 bring contains it. */
export function anchorBringRank(oppSets: PokemonSet[], mine: PokemonSet[], idx: number) {
  const ranked = scoreBrings(oppSets, mine.map(entryOf));
  const rank = ranked.findIndex(b => b.myIndices.includes(idx)) + 1;
  return { rank, total: ranked.length, broughtAtTop1: ranked[0]!.myIndices.includes(idx) };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('gauntlet-anchor-check.ts')) {
  console.log(`vs team: ${teamPath.split(/[\\/]/).pop()} — ${team.map(s => s.species).join(', ')}\n`);
  let benched = 0, withStone = 0;
  for (const t of ALL_THREATS) {
    const idx = t.sets.findIndex(holdsOwnStone);
    if (idx < 0) { console.log(`  ${t.anchor.padEnd(42)} (no mega stone in this team)`); continue; }
    withStone++;
    const { rank, total, broughtAtTop1 } = anchorBringRank(t.sets, team, idx);
    if (!broughtAtTop1) benched++;
    console.log(`  ${t.anchor.padEnd(42)} ${t.sets[idx]!.species.padEnd(12)} ${broughtAtTop1 ? 'BROUGHT' : 'BENCHED'}  (first bring holding it: rank ${rank}/${total})`);
  }
  console.log(`\n  ${benched}/${withStone} teams BENCH their own mega at the heuristic top-1 bring.`);
  if (benched) {
    console.log('  Those rows do NOT measure the mega they are named after. Re-score them with');
    console.log('  an exhaustive opponent bring so the maximin can pick the mega line:');
    console.log('    npx tsx packages/core/src/scripts/mb-team-check.ts --only <anchor> --oppBringK 15 --budget 5000');
  }
  process.exit(benched ? 1 : 0);
}
