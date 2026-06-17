// Tune ONE slot's spread (nature + EVs + item) against the M-B gauntlet, keeping
// its moves/ability fixed. Engine-grounded: every candidate is battle-evaluated
// over the full gauntlet (M-A meta + M-B threats) and ranked by (floor, avg) —
// the same fitness the hill-climb uses — so the pick isn't a guess.
//
//   NODE_OPTIONS=--max-old-space-size=8192 \
//     npx tsx packages/core/src/scripts/mb-tune-slot.ts [team.json] [Species] [--save]
//
// Defaults to tuning Rotom-Wash on anti-meta-mb.json. Candidate spreads are the
// sensible bulk/role distributions for that mon; swap the list to tune another.
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { MatchupPool } from '../domain/matchupPool.js';
import type { Matchup } from '../domain/teamSim.js';
import type { PokemonSet, Stats } from '../domain/types.js';
import { MB_THREATS } from './mbThreats.js';

const SAVE = process.argv.includes('--save');
const argNum = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const DEPTH = argNum('--depth', 5);
const BUDGET = argNum('--budget', 15000);
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const teamFile = positional.find(a => a.endsWith('.json')) ?? 'anti-meta-mb.json';
const tuneSpecies = positional.find(a => !a.endsWith('.json')) ?? 'Rotom-Wash';
const teamPath = join(dataDirPath(), 'my-teams', teamFile);

const E = (p: Partial<Stats>): Stats => ({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...p });
// Candidate spreads to try for the tuned slot (nature / EVs / item). Moves +
// ability are inherited from the existing set. Rotom-Wash's job here is a
// Levitate + Will-O-Wisp pivot, so the candidates trade its all-out offense for
// bulk distributions while keeping a threatening variant in the mix.
const CANDIDATES: { label: string; nature: string; item: string; evs: Stats }[] = [
  { label: 'offensive (current)', nature: 'Timid', item: 'Sitrus Berry', evs: E({ hp: 12, spa: 252, spe: 252 }) },
  { label: 'phys-def Bold',       nature: 'Bold',  item: 'Sitrus Berry', evs: E({ hp: 252, def: 252, spd: 4 }) },
  { label: 'phys-def + creep',    nature: 'Bold',  item: 'Sitrus Berry', evs: E({ hp: 252, def: 196, spe: 60 }) },
  { label: 'spec-def Calm',       nature: 'Calm',  item: 'Sitrus Berry', evs: E({ hp: 252, def: 4, spd: 252 }) },
  { label: 'mixed bulk',          nature: 'Bold',  item: 'Leftovers',    evs: E({ hp: 252, def: 124, spd: 132 }) },
  { label: 'bulky offense',       nature: 'Modest',item: 'Sitrus Berry', evs: E({ hp: 252, def: 4, spa: 252 }) },
  { label: 'def + SpA + creep',   nature: 'Bold',  item: 'Leftovers',    evs: E({ hp: 252, def: 132, spa: 60, spe: 64 }) },
  { label: 'spec-def + creep',    nature: 'Calm',  item: 'Sitrus Berry', evs: E({ hp: 252, spd: 132, spe: 124 }) },
];

const baseTeam: PokemonSet[] = JSON.parse(readFileSync(teamPath, 'utf8'));
const slot = baseTeam.findIndex(s => toId(s.species) === toId(tuneSpecies));
if (slot < 0) { console.error(`${tuneSpecies} not on ${teamFile}`); process.exit(1); }
const orig = baseTeam[slot]!;
const otherItems = new Set(baseTeam.filter((_, i) => i !== slot).map(s => toId(s.item ?? '')));

const pika = loadPikaData();
const gauntlet = [
  ...metaTeams(pika, argNum('--meta', 8), 3).map(m => ({ anchor: `[M-A] ${m.anchor}`, sets: m.sets })),
  ...MB_THREATS.map(m => ({ anchor: `[M-B] ${m.anchor}`, sets: m.sets })),
];
const pool = new MatchupPool();

interface Fit { floor: number; avg: number; flex: number; matchups: Matchup[] }
const better = (a: Fit, b: Fit) => a.floor !== b.floor ? a.floor > b.floor : a.avg !== b.avg ? a.avg > b.avg : a.flex > b.flex;
async function fit(team: PokemonSet[]): Promise<Fit> {
  const ms = await pool.run(gauntlet.map(g => ({ mine: team, oppSets: g.sets, oppAnchor: g.anchor, depth: DEPTH, budgetMs: BUDGET })));
  return { floor: Math.min(...ms.map(m => m.score)), avg: ms.reduce((s, m) => s + m.score, 0) / ms.length, flex: new Set(ms.flatMap(m => m.myBring)).size, matchups: ms };
}

console.log(`tuning ${orig.species} on ${teamFile} · ${CANDIDATES.length} spreads · ${gauntlet.length} boards · deepen 1→${DEPTH} @ ${BUDGET / 1000}s\n`);
let best: { label: string; set: PokemonSet; fit: Fit } | null = null;
for (const c of CANDIDATES) {
  if (c.item && toId(c.item) !== toId(orig.item ?? '') && otherItems.has(toId(c.item))) { console.log(`  ${c.label.padEnd(20)} skipped (item clash: ${c.item})`); continue; }
  const set: PokemonSet = { ...orig, nature: c.nature, item: c.item || undefined, evs: c.evs };
  const team = baseTeam.map((s, i) => (i === slot ? set : s));
  const f = await fit(team);
  const tag = !best || better(f, best.fit) ? '  <= best' : '';
  console.log(`  ${c.label.padEnd(20)} ${c.nature.padEnd(7)} floor ${String(Math.round(f.floor)).padStart(5)} avg ${String(Math.round(f.avg)).padStart(4)} flex ${f.flex}${tag}`);
  if (!best || better(f, best.fit)) best = { label: c.label, set, fit: f };
}
if (!best) { console.error('no candidate evaluated'); process.exit(1); }

console.log(`\nbest: ${best.label} — ${best.set.nature} ${Object.entries(best.set.evs).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(' / ')} @ ${best.set.item ?? '(none)'}`);
console.log(`floor ${Math.round(best.fit.floor)} · avg ${Math.round(best.fit.avg)} · flex ${best.fit.flex}/6`);
console.log('per-board:');
for (const m of [...best.fit.matchups].sort((a, b) => a.score - b.score)) console.log(`  ${m.anchor.padEnd(28)} ${String(Math.round(m.score)).padStart(6)}  ${m.verdict}`);

if (SAVE) {
  const team = baseTeam.map((s, i) => (i === slot ? best!.set : s));
  writeFileSync(teamPath, JSON.stringify(team, null, 2));
  console.log(`\nsaved ${teamPath}`);
}
pool.close();
