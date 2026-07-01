// Attribute a multi-mon spread change to its load-bearing subset, then optionally
// ADOPT only that subset. A wide static optimizer (optimize-spreads) proposes
// changes on a fast but miscalibrated metric; this evaluates the subsets of those
// changes over the PILOTED gauntlet and picks the best one to keep.
//   npx tsx packages/core/src/scripts/attribute-spread.ts [games] [optFile] [--adopt --out <file>]
// With --adopt, writes the best subset (highest floor, then avg, then fewest
// changes) to data/my-teams/<out> (or back over the base team if --out omitted).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { PlayoutPool, bringWinRate } from '../domain/playoutPool.js';
import {
  changedIndices, allMasks, reducedMasks, teamForMask, maskSpecies, bitCount, pickBestMask, type MaskFit,
} from '../domain/spreadAttribution.js';
import type { PokemonSet } from '../domain/types.js';

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt1 = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out' && args[args.indexOf(a) - 1] !== '--base');
const GAMES = parseInt(positional[0] ?? '16', 10);
const OPT = positional[1] ?? 'anti-meta-mb-natopt.json';
const ADOPT = flag('--adopt');
const OUT = opt1('--out');
const BASE = opt1('--base') ?? 'anti-meta-mb.json'; // the ORIGINAL team to diff the optimized one against
const SUBSET_CAP = 5; // 2^5 = 32 subset evals; beyond this fall back to singles + leave-one-out

const load = (f: string) => JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', f), 'utf8')) as PokemonSet[];
const orig = load(BASE);
const opt = load(OPT);
const gauntlet = metaTeams(loadPikaData(), 10, 4);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const pool = new PlayoutPool();

async function gauntletFit(myTeam: PokemonSet[]): Promise<{ floor: number; avg: number; inc: number }> {
  const per: number[] = [];
  let inc = NaN;
  for (const g of gauntlet) {
    const myBring = scoreBrings(myTeam, g.sets.map(entryOf))[0]!.myIndices.map(i => myTeam[i]!);
    const oppBring = scoreBrings(g.sets, myTeam.map(entryOf))[0]!.myIndices.map(i => g.sets[i]!);
    const r = await bringWinRate(pool, myBring, oppBring, GAMES, 2, true);
    per.push(r.winRate);
    if (g.anchor === 'Incineroar') inc = r.winRate;
  }
  return { floor: Math.min(...per), avg: per.reduce((a, c) => a + c, 0) / per.length, inc };
}

const changed = changedIndices(orig, opt);
if (changed.length === 0) { console.log('no changes between base and opt — nothing to attribute.'); pool.close(); process.exit(0); }

const k = changed.length;
const masks = k <= SUBSET_CAP ? allMasks(k) : reducedMasks(k);
const full = (1 << k) - 1;
console.log(`spread attribution · ${GAMES} games/matchup · piloted · opt=${OPT}`);
console.log(`${k} changed mon(s): ${changed.map(i => opt[i]!.species).join(', ')} · evaluating ${masks.length} subset(s)${k > SUBSET_CAP ? ' (reduced: singles + leave-one-out)' : ' (all)'}\n`);

const fits: (MaskFit & { inc: number; species: string[] })[] = [];
for (const mask of masks) {
  const f = await gauntletFit(teamForMask(orig, opt, changed, mask));
  const species = maskSpecies(opt, changed, mask);
  const label = mask === 0 ? 'original (no changes)' : mask === full ? `FULL (${species.join('+')})` : species.join('+');
  fits.push({ mask, floor: f.floor, avg: f.avg, inc: f.inc, species });
  console.log(`  ${label.padEnd(34)} floor ${pct(f.floor).padStart(4)}  avg ${pct(f.avg).padStart(4)}  · Incineroar ${pct(f.inc).padStart(4)}`);
}
pool.close();

// Per-change marginal contribution (single-change floor vs original), for explanation.
const origFloor = fits.find(f => f.mask === 0)!.floor;
console.log('\nmarginal floor contribution (each change alone vs original):');
for (let b = 0; b < k; b++) {
  const single = fits.find(f => f.mask === (1 << b));
  if (single) {
    const d = single.floor - origFloor;
    console.log(`  ${opt[changed[b]!]!.species.padEnd(12)} ${d >= 0 ? '+' : ''}${Math.round(d * 100)}pp  (${d > 0 ? 'load-bearing' : d < 0 ? 'HARMFUL' : 'inert'})`);
  }
}

const best = pickBestMask(fits);
const bestRow = fits.find(f => f.mask === best.mask)!;
console.log(`\nBEST subset: ${best.mask === 0 ? 'none (keep original)' : bestRow.species.join('+')} — floor ${pct(best.floor)} avg ${pct(best.avg)} (${bitCount(best.mask)}/${k} changes)`);

if (ADOPT) {
  const adopted = teamForMask(orig, opt, changed, best.mask);
  const outFile = OUT ?? BASE;
  writeFileSync(join(dataDirPath(), 'my-teams', outFile), JSON.stringify(adopted, null, 2) + '\n', 'utf8');
  console.log(`adopted ${bitCount(best.mask)} change(s) -> data/my-teams/${outFile}`);
}
