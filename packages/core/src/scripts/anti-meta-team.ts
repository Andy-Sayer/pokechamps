// Anti-meta team derivation by SIMULATED BATTLE against the known meta.
//
//   npx tsx packages/core/src/scripts/anti-meta-team.ts [--save] [--depth N]
//
// Method — no LLM judgement anywhere:
//   1. Reconstruct the top meta teams with their REAL sets (tournament
//      featured sets / top-usage spreads + items — "what you can see the top
//      teams using").
//   2. For each candidate team × meta team: BOTH sides pick their bring
//      intelligently (symmetric scoreBrings with full set knowledge), then
//      the maximin lookahead (searchIterative — the same engine that drives
//      the in-battle "⌁ best play" line) evaluates the brought position
//      under mutual best play. The matchup score is the search's worst-case
//      verdict for our side.
//   3. A team's fitness is its WORST matchup first (maximize the floor —
//      "pivots into all of them"), then the average, then bring flexibility
//      (how many distinct mons appear across its per-opponent best brings).
//   4. Hill-climb: swap single slots with high-usage alternatives while the
//      floor improves.
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId, getItem } from '../domain/data.js';
import { loadPikaData, metaTeams, composeTeam, buildSet, baseSpeciesFor, type PikaData } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { searchIterative, type SearchInput } from '../domain/endgameSearch.js';
import { detectTactics, profileFromSet, tacticLabel } from '../domain/tactics.js';
import type { PokemonSet, OpponentEntry } from '../domain/types.js';
import { NEUTRAL_FIELD } from '../domain/types.js';

const SAVE = process.argv.includes('--save');
const DEPTH = Number(process.argv[process.argv.indexOf('--depth') + 1]) || 3;
const META_N = 5;

const pika = loadPikaData();
const meta = metaTeams(pika, META_N);
console.log(`meta opponents (${meta.length}):`);
for (const m of meta) console.log('  ', m.anchor, '—', m.sets.map(s => s.species).join(', '));

/** Full-knowledge OpponentEntry for a known meta set: species + ability +
 *  item revealed, candidates pinned to the TRUE set so every damage calc in
 *  the search runs against the real spread. */
function entryOf(set: PokemonSet): OpponentEntry {
  return {
    species: set.species,
    ability: set.ability, item: set.item,
    knownMoves: set.moves,
    candidates: [set], candidateLikelihoods: [1],
  };
}

interface Matchup { anchor: string; score: number; verdict: string; myBring: string[] }

/** One simulated matchup: intelligent brings both sides, then maximin. */
function evaluateMatchup(mine: PokemonSet[], opp: { anchor: string; sets: PokemonSet[] }, depth: number): Matchup {
  const oppEntries = opp.sets.map(entryOf);
  const myEntries = mine.map(entryOf);
  // Each side picks its best bring KNOWING the other's six (open team sheets).
  const myBring = scoreBrings(mine, oppEntries)[0]!;
  const oppBring = scoreBrings(opp.sets, myEntries)[0]!;
  const myIdx = myBring.myIndices;
  const oppIdx = oppBring.myIndices;
  const input: SearchInput = {
    mine: myIdx.map((i, k) => ({ set: mine[i]!, hpPercent: 100, active: k < 2 })),
    opp: oppIdx.map((j, k) => ({ entry: oppEntries[j]!, hpPercent: 100, active: k < 2 })),
    field: { ...NEUTRAL_FIELD },
    allOppRevealed: true,
  };
  const r = searchIterative(input, depth);
  return { anchor: opp.anchor, score: r.score, verdict: r.verdict, myBring: myIdx.map(i => mine[i]!.species) };
}

interface Fitness { floor: number; avg: number; flex: number; matchups: Matchup[] }

function evaluateTeam(mine: PokemonSet[], depth: number, abortBelow?: number): Fitness | null {
  const matchups: Matchup[] = [];
  for (const opp of meta) {
    const m = evaluateMatchup(mine, opp, depth);
    matchups.push(m);
    // Early abort: this candidate's floor already lost to the incumbent.
    if (abortBelow != null && m.score < abortBelow) return null;
  }
  const floor = Math.min(...matchups.map(m => m.score));
  const avg = matchups.reduce((s, m) => s + m.score, 0) / matchups.length;
  const flex = new Set(matchups.flatMap(m => m.myBring)).size;
  return { floor, avg, flex, matchups };
}

const better = (a: Fitness, b: Fitness) =>
  a.floor !== b.floor ? a.floor > b.floor : a.avg !== b.avg ? a.avg > b.avg : a.flex > b.flex;

// ---------------------------------------------------------------------------
// Seeds: meta stacks + tactic-core teams (mirror suggest-teams generation).
// ---------------------------------------------------------------------------
const seeds: { label: string; sets: PokemonSet[] }[] = [];
const seen = new Set<string>();
const addSeed = (label: string, sets: PokemonSet[] | null) => {
  if (!sets) return;
  const key = sets.map(s => s.species).sort().join('|');
  if (seen.has(key)) return;
  seen.add(key);
  seeds.push({ label, sets });
};
for (const anchor of pika.topPokemon.slice(0, 8)) addSeed(`${anchor} stack`, composeTeam(pika, [anchor]));
// Tactic-core seeds: strongest catalog pair combos whose pieces have usage
// data — the off-meta lines (perish trap, TR, weather) compete on equal
// footing with the meta stacks and win seed selection only if the simulated
// battles say so.
{
  const catalog = JSON.parse(
    readFileSync(join(dataDirPath(), 'tactics.champions.json'), 'utf8'),
  ) as { patterns: Record<string, { instances: { pieces: { species: string }[]; name: string }[] }> };
  for (const pattern of ['perish-trap', 'trick-room', 'weather', 'terrain', 'redirection']) {
    const inst = catalog.patterns[pattern]?.instances.find(t =>
      t.pieces.length === 2 && t.pieces.every(p =>
        Object.keys(pika.pokemon).some(k => baseSpeciesFor(k) === baseSpeciesFor(p.species) || k === p.species)));
    if (!inst) continue;
    const anchors = inst.pieces.map(p =>
      Object.keys(pika.pokemon).find(k => baseSpeciesFor(k) === baseSpeciesFor(p.species) || k === p.species)!);
    const team = composeTeam(pika, anchors);
    const intact = team && anchors.every(a => team.some(s => baseSpeciesFor(s.species) === baseSpeciesFor(a)));
    if (intact) addSeed(`${inst.name} (${anchors.join('+')})`, team);
  }
}

console.log(`\nevaluating ${seeds.length} seed teams at depth ${DEPTH} vs ${meta.length} meta teams…`);
let best: { label: string; sets: PokemonSet[]; fit: Fitness } | null = null;
for (const s of seeds) {
  const t0 = Date.now();
  const fit = evaluateTeam(s.sets, DEPTH, best ? best.fit.floor : undefined);
  if (!fit) { console.log(`  ${s.label}: pruned (floor below incumbent) [${Date.now() - t0}ms]`); continue; }
  console.log(`  ${s.label}: floor ${Math.round(fit.floor)} avg ${Math.round(fit.avg)} flex ${fit.flex} [${Date.now() - t0}ms]`);
  if (!best || better(fit, best.fit)) best = { ...s, fit };
}
if (!best) { console.error('no viable seed'); process.exit(1); }
console.log(`\nbest seed: ${best.label} (floor ${Math.round(best.fit.floor)})`);

// ---------------------------------------------------------------------------
// Hill-climb: replace single slots with high-usage alternatives while the
// floor improves. Pool = top 20 usage mons not already on the team.
// ---------------------------------------------------------------------------
const pool = pika.topPokemon.slice(0, 20);
let improved = true;
let rounds = 0;
while (improved && rounds < 3) {
  improved = false;
  rounds++;
  // Attack the WORST matchup: try replacing each slot.
  const worst = best.fit.matchups.reduce((a, b) => (a.score < b.score ? a : b));
  console.log(`\nround ${rounds}: attacking worst matchup (${worst.anchor}, ${Math.round(worst.score)})`);
  for (let slot = 0; slot < 6 && !improved; slot++) {
    for (const cand of pool) {
      const base = baseSpeciesFor(cand);
      if (best.sets.some(s => baseSpeciesFor(s.species) === base)) continue;
      const others: PokemonSet[] = best.sets.filter((_, i) => i !== slot);
      const used = new Set<string>(others.map((s: PokemonSet) => toId(s.item ?? '')));
      const candSet = buildSet(pika, cand, used);
      if (!candSet) continue;
      const trial: PokemonSet[] = [...others, candSet];
      const megaCount = trial.filter((s: PokemonSet) => !!(getItem(s.item ?? '') as { megaStone?: unknown } | undefined)?.megaStone).length;
      if (megaCount > 1) continue;
      const fit = evaluateTeam(trial, DEPTH, best.fit.floor);
      if (fit && better(fit, best.fit)) {
        console.log(`  swap ${best.sets[slot]!.species} → ${candSet.species}: floor ${Math.round(fit.floor)} avg ${Math.round(fit.avg)}`);
        best = { label: `${best.label} +${candSet.species}`, sets: trial, fit };
        improved = true;
        break;
      }
    }
  }
  if (!improved) console.log('  no improving swap found');
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
console.log('\n=== ANTI-META TEAM ===');
for (const s of best.sets) console.log(`  ${s.species} @ ${s.item} · ${s.ability} · ${s.nature} · ${s.moves.join(' / ')}`);
console.log('\nper-meta matchups (maximin score under mutual best play; + favors us):');
for (const m of best.fit.matchups) {
  console.log(`  vs ${m.anchor.padEnd(18)} ${String(Math.round(m.score)).padStart(6)}  ${m.verdict.padEnd(7)}  bring: ${m.myBring.join(', ')}`);
}
console.log(`floor ${Math.round(best.fit.floor)} · avg ${Math.round(best.fit.avg)} · bring flexibility ${best.fit.flex}/6 mons used across matchups`);
const combos = detectTactics(best.sets.map(profileFromSet)).slice(0, 4);
if (combos.length) console.log('combos on board: ' + combos.map(t => `${t.name} (${tacticLabel(t)})`).join(' · '));

if (SAVE) {
  const file = join(dataDirPath(), 'my-teams', 'anti-meta.json');
  writeFileSync(file, JSON.stringify(best.sets, null, 2));
  console.log(`\nsaved ${file}`);
}
