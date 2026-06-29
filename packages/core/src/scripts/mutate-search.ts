// High-mutation team search. mb-hill-climb mutates ONE slot at a time (single-slot
// coordinate descent) and gets stuck near the seed — its only "lead" (Incineroar
// swap) was a static artifact the sim later rejected (floor 100%->33%). This makes
// BOLDER moves: each round it samples M random mutants of the incumbent, each
// changing K slots at once (K = mutation level) from a broad meta pool (clause +
// one-mega respecting), evaluates them vs the gauntlet, and hill-climbs the
// floor-first fitness. It RETAINS the top-N distinct teams for SIM validation,
// because the static metric over-proposes — always dispose with bring-search.
//   NODE_OPTIONS=--max-old-space-size=8192 npx tsx packages/core/src/scripts/mutate-search.ts \
//     [--from t.json] [--mutate K] [--samples M] [--rounds R] [--pool N] [--meta N] \
//     [--budget ms] [--depth N] [--bringK N] [--save] [--out prefix] [--top N]
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId, getItem } from '../domain/data.js';
import { loadPikaData, metaTeams, buildSet, baseSpeciesFor } from '../domain/metaTeams.js';
import { MatchupPool } from '../domain/matchupPool.js';
import { MB_THREATS } from './mbThreats.js';
import type { PokemonSet } from '../domain/types.js';

const argNum = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const argStr = (f: string, d: string) => { const i = process.argv.indexOf(f); return i >= 0 ? String(process.argv[i + 1]) : d; };
const FROM = argStr('--from', 'anti-meta-mb.json');
const K = argNum('--mutate', 2);            // MUTATION LEVEL: slots changed per mutant
const SAMPLES = argNum('--samples', 20);    // mutants evaluated per round
const ROUNDS = argNum('--rounds', 4);
const POOL_N = argNum('--pool', 40);        // candidate species pool (broad on purpose)
const META_N = argNum('--meta', 8);
const DEPTH = argNum('--depth', 4);
const BUDGET = argNum('--budget', 6000);
const BRING_K = argNum('--bringK', 1);
const TOP_N = argNum('--top', 5);
const SAVE = process.argv.includes('--save');
const OUTPREFIX = argStr('--out', 'mutant');

const teamFile = (n: string) => (n.includes('/') || n.includes('\\') ? n : join(dataDirPath(), 'my-teams', n));
const pika = loadPikaData();
const gauntlet = [
  ...metaTeams(pika, META_N, 3).map(m => ({ anchor: `[meta] ${m.anchor}`, sets: m.sets })),
  ...MB_THREATS.map(m => ({ anchor: `[hand] ${m.anchor}`, sets: m.sets })),
];
const swapPool = pika.topPokemon.slice(0, POOL_N);
const pool = new MatchupPool();
const megaCount = (t: PokemonSet[]) => t.filter(s => !!((getItem(s.item ?? '') as { megaStone?: unknown } | undefined)?.megaStone)).length;

interface Fit { floor: number; avg: number }
const better = (a: Fit, b: Fit) => (a.floor !== b.floor ? a.floor > b.floor : a.avg > b.avg);
async function fit(team: PokemonSet[]): Promise<Fit> {
  const ms = await pool.run(gauntlet.map(g => ({ mine: team, oppSets: g.sets, oppAnchor: g.anchor, depth: DEPTH, budgetMs: BUDGET, bringK: BRING_K })));
  return { floor: Math.min(...ms.map(m => m.score)), avg: ms.reduce((s, m) => s + m.score, 0) / ms.length };
}
const fmt = (t: PokemonSet[]) => t.map(s => s.species).join('/');
const key = (t: PokemonSet[]) => t.map(s => baseSpeciesFor(s.species)).sort().join(',');
const rand = (n: number) => Math.floor(Math.random() * n);
const shuffle = <T>(a: T[]): T[] => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = rand(i + 1); [r[i], r[j]] = [r[j]!, r[i]!]; } return r; };

// Mutate K random slots with random clause-respecting pool candidates (one mega max).
function mutate(team: PokemonSet[]): PokemonSet[] | null {
  const slots = shuffle([0, 1, 2, 3, 4, 5]).slice(0, K);
  let t = team.map(s => ({ ...s }));
  for (const slot of slots) {
    const cands = shuffle(swapPool).filter(c =>
      baseSpeciesFor(t[slot]!.species) !== baseSpeciesFor(c) &&
      !t.some((s, i) => i !== slot && baseSpeciesFor(s.species) === baseSpeciesFor(c)));
    let placed = false;
    for (const c of cands) {
      const used = new Set(t.filter((_, i) => i !== slot).map(s => toId(s.item ?? '')));
      const candSet = buildSet(pika, c, used);
      if (!candSet) continue;
      const trial = t.map((s, i) => (i === slot ? candSet : s));
      if (megaCount(trial) > 1) continue;
      t = trial; placed = true; break;
    }
    if (!placed) return null;
  }
  return t;
}

const seed: PokemonSet[] = JSON.parse(readFileSync(teamFile(FROM), 'utf8'));
console.log(`mutate-search · from ${FROM} · MUTATION LEVEL K=${K} slots · ${SAMPLES} mutants × ${ROUNDS} rounds · pool ${swapPool.length} · ${gauntlet.length} boards · bringK ${BRING_K}`);
let best = { team: seed, fit: await fit(seed) };
const seen = new Map<string, { team: PokemonSet[]; fit: Fit }>();
seen.set(key(seed), best);
console.log(`seed ${fmt(seed)}  floor ${Math.round(best.fit.floor)} avg ${Math.round(best.fit.avg)}\n`);

for (let round = 1; round <= ROUNDS; round++) {
  const mutants: PokemonSet[][] = [];
  let tries = 0;
  while (mutants.length < SAMPLES && tries < SAMPLES * 6) {
    tries++;
    const m = mutate(best.team);
    if (!m) continue;
    const k = key(m);
    if (seen.has(k) || mutants.some(x => key(x) === k)) continue;
    mutants.push(m);
  }
  const fits = await Promise.all(mutants.map(fit));
  let roundBest: { team: PokemonSet[]; fit: Fit } | null = null;
  for (let i = 0; i < mutants.length; i++) {
    const rec = { team: mutants[i]!, fit: fits[i]! };
    seen.set(key(mutants[i]!), rec);
    if (!roundBest || better(rec.fit, roundBest.fit)) roundBest = rec;
  }
  const adopt = roundBest && better(roundBest.fit, best.fit);
  if (adopt) best = roundBest!;
  console.log(`round ${round}: ${mutants.length} K=${K} mutants · best floor ${roundBest ? Math.round(roundBest.fit.floor) : '—'} avg ${roundBest ? Math.round(roundBest.fit.avg) : '—'}${adopt ? `  ADOPT ${fmt(best.team)}` : '  (no improvement — incumbent held)'}`);
}
pool.close();

const ranked = [...seen.values()].sort((a, b) => (better(a.fit, b.fit) ? -1 : 1)).slice(0, TOP_N);
console.log(`\n=== TOP ${ranked.length} distinct teams (static — SIM-VALIDATE before trusting) ===`);
ranked.forEach((r, i) => {
  console.log(`  ${i + 1}. floor ${Math.round(r.fit.floor)} avg ${Math.round(r.fit.avg)}  ${fmt(r.team)}`);
  if (SAVE) {
    const f = `${OUTPREFIX}-${i + 1}.json`;
    writeFileSync(join(dataDirPath(), 'my-teams', f), JSON.stringify(r.team, null, 2) + '\n', 'utf8');
  }
});
if (SAVE) console.log(`\nsaved top ${ranked.length} to data/my-teams/${OUTPREFIX}-*.json — sim-validate with confirm-spread / bring-search`);
