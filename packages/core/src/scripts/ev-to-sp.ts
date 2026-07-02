// Convert a team's standard EVs to PoChamps stat-points (SP 0..32) for the in-game
// builder. For each stat we find the SP whose evFromSp(sp) is closest to the EV
// (evFromSp is the app's canonical SP→EV map). Prints an SP table per mon.
//   npx tsx packages/core/src/scripts/ev-to-sp.ts [team.json]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { evFromSp } from '../domain/pikalytics.js';
import { SP_MAX } from '../domain/breakpoints.js';
import type { PokemonSet, Stats } from '../domain/types.js';

const TEAM = process.argv[2] ?? 'rain-mb-final.json';
const team = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', TEAM), 'utf8')) as PokemonSet[];
const STATS: (keyof Stats)[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const LABEL: Record<string, string> = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };

// SP for an EV = argmin_sp |evFromSp(sp) - ev|.
function spOf(ev: number): number {
  let best = 0, bestErr = Infinity;
  for (let sp = 0; sp <= SP_MAX; sp++) {
    const err = Math.abs(evFromSp(sp) - ev);
    if (err < bestErr) { bestErr = err; best = sp; }
  }
  return best;
}

console.log(`SP conversion · ${TEAM} (Champions stat-points, 0..${SP_MAX}; budget 66)\n`);
for (const mon of team) {
  const parts: string[] = []; let total = 0;
  for (const st of STATS) {
    const ev = mon.evs[st] ?? 0;
    if (ev <= 0) continue;
    const sp = spOf(ev); total += sp;
    parts.push(`${sp} ${LABEL[st]}`);
  }
  console.log(`  ${mon.species.padEnd(12)} ${mon.nature.padEnd(8)} ${parts.join(' / ').padEnd(34)}  (Σ${total} SP)`);
}
process.exit(0);
