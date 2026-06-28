// Find the best species for ONE slot of a team, holding the other five fixed,
// by FULL-gauntlet battle eval. Use when a slot is dead weight (never brought):
// the worst-board hill-climb (mb-hill-climb.ts) optimises the FLOOR, so it can
// leave a slot that isn't setting the floor stranded even when a better 6th
// would raise avg/flex. This scouts every meta-pool candidate (+ the incumbent)
// into the slot on the WHOLE gauntlet in one parallel batch, ranks by
// (floor, avg, flex), and (with --save) writes the winner back only if it beats
// the incumbent — no regression.
//
//   NODE_OPTIONS=--max-old-space-size=8192 \
//     npx tsx packages/core/src/scripts/mb-replace-slot.ts <team.json> <Species|index> \
//       [--pool N] [--meta N] [--depth N] [--budget ms] [--save]
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId, getItem } from '../domain/data.js';
import { loadPikaData, metaTeams, buildSet, baseSpeciesFor } from '../domain/metaTeams.js';
import { MatchupPool } from '../domain/matchupPool.js';
import type { PokemonSet } from '../domain/types.js';
import { MB_THREATS } from './mbThreats.js';

const argNum = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const SAVE = process.argv.includes('--save');
const POOL_N = argNum('--pool', 16);
const META_N = argNum('--meta', 10);
const DEPTH = argNum('--depth', 5);
const BUDGET = argNum('--budget', 12000);

// Positional args = team path + slot spec (skip flags and their values).
const VALUE_FLAGS = new Set(['--pool', '--meta', '--depth', '--budget']);
const positionals: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith('--')) { if (VALUE_FLAGS.has(a)) i++; continue; }
  positionals.push(a);
}
const teamArg = positionals.find(p => p.endsWith('.json')) ?? positionals[0];
const slotArg = positionals.find(p => p !== teamArg);
if (!teamArg || !slotArg) { console.error('usage: mb-replace-slot.ts <team.json> <Species|index> [--save]'); process.exit(1); }

const teamPath = teamArg.includes('/') || teamArg.includes('\\') ? teamArg : join(dataDirPath(), 'my-teams', teamArg);
const team: PokemonSet[] = JSON.parse(readFileSync(teamPath, 'utf8'));

let slotIdx = -1;
const asNum = Number(slotArg);
if (Number.isInteger(asNum) && asNum >= 1 && asNum <= team.length) slotIdx = asNum - 1;
else slotIdx = team.findIndex(s => s.species.toLowerCase() === slotArg.toLowerCase() || baseSpeciesFor(s.species).toLowerCase() === slotArg.toLowerCase());
if (slotIdx < 0) { console.error(`could not resolve slot "${slotArg}" in: ${team.map(s => s.species).join(', ')}`); process.exit(1); }

const pika = loadPikaData();
const gauntlet = [
  ...metaTeams(pika, META_N, 3).map(m => ({ anchor: `[meta] ${m.anchor}`, sets: m.sets })),
  ...MB_THREATS.map(m => ({ anchor: `[hand] ${m.anchor}`, sets: m.sets })),
];
const megaCount = (t: PokemonSet[]) => t.filter(s => !!(getItem(s.item ?? '') as { megaStone?: unknown } | undefined)?.megaStone).length;

// Trials: keep the incumbent, plus each legal pool candidate swapped into the slot.
const trials: { label: string; team: PokemonSet[] }[] = [{ label: `${team[slotIdx]!.species} (incumbent)`, team }];
for (const cand of pika.topPokemon.slice(0, POOL_N)) {
  if (baseSpeciesFor(team[slotIdx]!.species) === baseSpeciesFor(cand)) continue;
  if (team.some((s, i) => i !== slotIdx && baseSpeciesFor(s.species) === baseSpeciesFor(cand))) continue;
  const used = new Set(team.filter((_, i) => i !== slotIdx).map(s => toId(s.item ?? '')));
  const candSet = buildSet(pika, cand, used);
  if (!candSet) continue;
  const t = team.map((s, i) => (i === slotIdx ? candSet : s));
  if (megaCount(t) > 1) continue;
  trials.push({ label: `${team[slotIdx]!.species}→${candSet.species}`, team: t });
}

console.log(`team: ${team.map(s => s.species).join(', ')}`);
console.log(`replacing slot ${slotIdx + 1} (${team[slotIdx]!.species}) · ${trials.length - 1} candidates · ${gauntlet.length} boards · deepen 1→${DEPTH} · ${BUDGET / 1000}s/board\n`);

// Evaluate every trial × every board in one parallel batch.
const pool = new MatchupPool();
const res = await pool.run(trials.flatMap(tr => gauntlet.map(g => ({ mine: tr.team, oppSets: g.sets, oppAnchor: g.anchor, depth: DEPTH, budgetMs: BUDGET }))));
pool.close();

const G = gauntlet.length;
const fits = trials.map((tr, ti) => {
  const ms = res.slice(ti * G, ti * G + G);
  return {
    label: tr.label, team: tr.team,
    floor: Math.min(...ms.map(m => m.score)),
    avg: ms.reduce((s, m) => s + m.score, 0) / ms.length,
    flex: new Set(ms.flatMap(m => m.myBring)).size,
  };
});
const better = (a: typeof fits[number], b: typeof fits[number]) =>
  a.floor !== b.floor ? a.floor > b.floor : a.avg !== b.avg ? a.avg > b.avg : a.flex > b.flex;
fits.sort((a, b) => (better(a, b) ? -1 : 1));

for (const f of fits) console.log(`  ${f.label.padEnd(28)} floor ${String(Math.round(f.floor)).padStart(6)}  avg ${String(Math.round(f.avg)).padStart(5)}  flex ${f.flex}`);

const winner = fits[0]!;
const incumbent = fits.find(f => f.label.includes('incumbent'))!;
console.log(`\nwinner: ${winner.label}  (incumbent: floor ${Math.round(incumbent.floor)} avg ${Math.round(incumbent.avg)} flex ${incumbent.flex})`);
if (SAVE && winner.label !== incumbent.label && better(winner, incumbent)) {
  writeFileSync(teamPath, JSON.stringify(winner.team, null, 2));
  console.log(`saved ${teamPath}`);
} else {
  console.log(SAVE ? 'incumbent stands — nothing written.' : '(dry run — pass --save to write the winner)');
}
