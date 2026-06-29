// Attribute a multi-mon spread change to the individual mons. Given the original
// team and an optimized file, for every mon that changed it evaluates (piloted
// gauntlet, one shared pool):
//   - original (baseline) and the FULL opt (reference),
//   - SINGLE-change isolation: original with only that mon swapped to opt — which
//     lone change carries the gain (= the safe minimal set if one suffices),
//   - LEAVE-ONE-OUT: full opt with that mon reverted — whether a change is
//     load-bearing or just free-riding (and thus risky to adopt, e.g. a glass
//     support the pilot policy can't punish).
//   npx tsx packages/core/src/scripts/attribute-spread.ts [games] [optFile]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { PlayoutPool, bringWinRate } from '../domain/playoutPool.js';
import type { PokemonSet } from '../domain/types.js';

const GAMES = parseInt(process.argv[2] ?? '16', 10);
const OPT = process.argv[3] ?? 'anti-meta-mb-natopt.json';
const load = (f: string) => JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', f), 'utf8')) as PokemonSet[];
const orig = load('anti-meta-mb.json');
const opt = load(OPT);
const gauntlet = metaTeams(loadPikaData(), 10, 4);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const pool = new PlayoutPool();

const sp = (e: PokemonSet) => (['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const).map(k => e.evs[k] || 0).join('/');
const changed = orig.map((_, i) => i).filter(i => orig[i]!.nature !== opt[i]!.nature || sp(orig[i]!) !== sp(opt[i]!));

async function gauntletWR(myTeam: PokemonSet[]) {
  const per: { opp: string; wr: number }[] = [];
  for (const g of gauntlet) {
    const myBring = scoreBrings(myTeam, g.sets.map(entryOf))[0]!.myIndices.map(i => myTeam[i]!);
    const oppBring = scoreBrings(g.sets, myTeam.map(entryOf))[0]!.myIndices.map(i => g.sets[i]!);
    const r = await bringWinRate(pool, myBring, oppBring, GAMES, 2, true);
    per.push({ opp: g.anchor, wr: r.winRate });
  }
  return {
    avg: per.reduce((a, c) => a + c.wr, 0) / per.length,
    floor: Math.min(...per.map(p => p.wr)),
    inc: per.find(p => p.opp === 'Incineroar')?.wr ?? NaN,
    per,
  };
}

const withOne = (i: number) => orig.map((s, k) => (k === i ? opt[i]! : s));
const withoutOne = (i: number) => opt.map((s, k) => (k === i ? orig[i]! : s));

const variants: { label: string; team: PokemonSet[] }[] = [
  { label: 'original', team: orig },
  { label: 'FULL nature-opt', team: opt },
  ...changed.map(i => ({ label: `only ${opt[i]!.species} (${opt[i]!.nature})`, team: withOne(i) })),
  ...changed.map(i => ({ label: `drop ${opt[i]!.species} change`, team: withoutOne(i) })),
];

console.log(`spread attribution · ${GAMES} games/matchup · piloted · opt=${OPT}`);
console.log(`changed mons: ${changed.map(i => opt[i]!.species).join(', ')}\n`);
const rows: { label: string; avg: number; floor: number; inc: number; per: { opp: string; wr: number }[] }[] = [];
for (const v of variants) {
  const r = await gauntletWR(v.team);
  rows.push({ label: v.label, ...r });
  console.log(`${v.label.padEnd(26)} avg ${pct(r.avg).padStart(4)}  floor ${pct(r.floor).padStart(4)}  · Incineroar ${pct(r.inc).padStart(4)}`);
}
pool.close();

// Per-opponent table for original vs FULL, so reshuffles are visible.
const o = rows[0]!, f = rows[1]!;
console.log('\nper-opponent (original → FULL nature-opt):');
for (let i = 0; i < o.per.length; i++) {
  const d = f.per[i]!.wr - o.per[i]!.wr;
  console.log(`  ${o.per[i]!.opp.padEnd(12)} ${pct(o.per[i]!.wr).padStart(4)} → ${pct(f.per[i]!.wr).padStart(4)}  (${d >= 0 ? '+' : ''}${Math.round(d * 100)}pp)`);
}
