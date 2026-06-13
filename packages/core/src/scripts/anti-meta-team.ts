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
import { damageRange, maxHpFor } from '../domain/damage.js';

const SAVE = process.argv.includes('--save');
const DEPTH = Number(process.argv[process.argv.indexOf('--depth') + 1]) || 3;
// Opponent pool: up to 12 top-anchor teams with a 3-species diversity gate,
// so the pool spans real archetypes (goodstuff, sun, rain, TR, Tailwind) —
// not five rotations of the same Sneasler-Garchomp core.
const META_N = Number(process.argv[process.argv.indexOf('--meta') + 1]) || 12;
const MAX_OVERLAP = 3;

const pika = loadPikaData();
const meta = metaTeams(pika, META_N, MAX_OVERLAP);
console.log(`meta opponents (${meta.length}, ≤${MAX_OVERLAP} shared species between any two):`);
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
for (const anchor of pika.topPokemon.slice(0, 12)) addSeed(`${anchor} stack`, composeTeam(pika, [anchor]));
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

// Phase 1: fast depth-2 sweep over every seed (early floor-abort prunes).
// ---------------------------------------------------------------------------
// Niche seeds — data-derived, not vibes:
//   (1) Underdogs: low-usage mons (rank > 20) ranked by direct damage-calc
//       performance against every set in the meta gauntlet; best two anchor
//       a team.
//   (2) Niche tech: the meta's own mons with sub-20%-usage counter-tech
//       moves (Wide Guard / Taunt / Haze / Icy Wind / …) swapped into their
//       4th slot when their standard four carry none.
//   (3) Off-meta combo: the highest-scoring catalog pair whose pieces are
//       ALL outside the top-15 usage list.
// ---------------------------------------------------------------------------
{
  // (1) Underdog promise score: avg (my best hit% on each meta set) minus
  // (their best hit% back), over all 72 gauntlet sets.
  const metaSets = meta.flatMap(m => m.sets);
  const bestPct = (atk: PokemonSet, def: PokemonSet): number => {
    let best = 0;
    const max = maxHpFor(def);
    for (const mv of atk.moves) {
      try {
        const r = damageRange({ attacker: atk, defender: def, move: mv, field: NEUTRAL_FIELD, attackerSide: 'mine' });
        best = Math.max(best, max > 0 ? (r.max / max) * 100 : 0);
      } catch { /* status moves / unknown ids */ }
    }
    return Math.min(150, best);
  };
  const underdogs = Object.keys(pika.pokemon)
    .filter(n => (pika.pokemon[n]!.rank ?? 0) > 20)
    .map(name => {
      const set = buildSet(pika, name, new Set());
      if (!set) return null;
      let score = 0;
      for (const oppSet of metaSets) score += bestPct(set, oppSet) - bestPct(oppSet, set);
      return { name, score: score / metaSets.length };
    })
    .filter((x): x is { name: string; score: number } => !!x)
    .sort((a, b) => b.score - a.score);
  console.log('\nunderdog promise vs the gauntlet (top 6 of the sub-top-20):');
  for (const u of underdogs.slice(0, 6)) console.log(`  ${u.name.padEnd(16)} ${u.score.toFixed(1)}`);
  // Anchor the top underdog + the best one with a DIFFERENT base species
  // (formes of the same mon would collapse under the species clause).
  const first = underdogs[0];
  const second = underdogs.find(u => baseSpeciesFor(u.name) !== baseSpeciesFor(first?.name ?? ''));
  if (first && second) {
    addSeed(`Underdogs (${first.name}+${second.name})`,
      composeTeam(pika, [first.name, second.name]));
  }

  // (2) Niche tech on the strongest meta stack: counter-tech moves that the
  // 12-archetype gauntlet rewards, taken from each member's own usage list
  // at < 20% (popular mon, unpopular move).
  const COUNTER_TECH = new Set(['wideguard', 'taunt', 'haze', 'icywind', 'electroweb', 'clearsmog', 'coaching', 'quickguard', 'helpinghand']);
  const baseStack = composeTeam(pika, [pika.topPokemon[0]!]);
  if (baseStack) {
    let touched = 0;
    const teched = baseStack.map(s => {
      const d = pika.pokemon[Object.keys(pika.pokemon).find(k => baseSpeciesFor(k) === s.species) ?? s.species];
      if (!d) return s;
      const hasTech = s.moves.some(m => COUNTER_TECH.has(toId(m)));
      if (hasTech) return s;
      const tech = d.moves.find(m => m.name !== 'Other' && m.pct < 20 && m.pct > 0.5 && COUNTER_TECH.has(toId(m.name)) && !s.moves.includes(m.name));
      if (!tech) return s;
      touched++;
      return { ...s, moves: [...s.moves.slice(0, 3), tech.name] };
    });
    if (touched > 0) addSeed(`Niche tech ${pika.topPokemon[0]} stack (+${touched} tech swaps)`, teched);
  }

  // (3) Off-meta combo: best catalog pair with NO top-15 piece.
  const catalog = JSON.parse(
    readFileSync(join(dataDirPath(), 'tactics.champions.json'), 'utf8'),
  ) as { patterns: Record<string, { instances: { pieces: { species: string }[]; name: string; score: number }[] }> };
  const top15 = new Set(pika.topPokemon.slice(0, 15).map(baseSpeciesFor));
  const offMeta = Object.values(catalog.patterns)
    .flatMap(p => p.instances)
    .filter(t => t.pieces.length === 2
      && t.pieces.every(p => !top15.has(baseSpeciesFor(p.species)))
      && t.pieces.every(p => Object.keys(pika.pokemon).some(k => baseSpeciesFor(k) === baseSpeciesFor(p.species))))
    .sort((a, b) => b.score - a.score)[0];
  if (offMeta) {
    const anchors = offMeta.pieces.map(p =>
      Object.keys(pika.pokemon).find(k => baseSpeciesFor(k) === baseSpeciesFor(p.species))!);
    const team = composeTeam(pika, anchors);
    const intact = team && anchors.every(a => team.some(s => baseSpeciesFor(s.species) === baseSpeciesFor(a)));
    if (intact) addSeed(`Off-meta combo: ${offMeta.name} (${anchors.join('+')})`, team);
  }
}

console.log(`\nphase 1: ${seeds.length} seed teams at depth 2 vs ${meta.length} meta teams…`);
const sweep: { label: string; sets: PokemonSet[]; fit: Fitness }[] = [];
let pruneFloor: number | undefined;
for (const s of seeds) {
  const t0 = Date.now();
  const fit = evaluateTeam(s.sets, 2, pruneFloor);
  if (!fit) { console.log(`  ${s.label}: pruned [${Date.now() - t0}ms]`); continue; }
  console.log(`  ${s.label}: floor ${Math.round(fit.floor)} avg ${Math.round(fit.avg)} flex ${fit.flex} [${Date.now() - t0}ms]`);
  sweep.push({ ...s, fit });
  const floors = sweep.map(x => x.fit.floor).sort((a, b) => b - a);
  // Prune anything that can't beat the 3rd-best floor (we keep 3 finalists).
  pruneFloor = floors[2];
}
sweep.sort((a, b) => (better(a.fit, b.fit) ? -1 : 1));
if (!sweep.length) { console.error('no viable seed'); process.exit(1); }

// Phase 2: verify the top 3 finalists at full depth.
console.log(`\nphase 2: top ${Math.min(3, sweep.length)} finalists at depth ${DEPTH}…`);
let best: { label: string; sets: PokemonSet[]; fit: Fitness } | null = null;
for (const s of sweep.slice(0, 3)) {
  const t0 = Date.now();
  const fit = evaluateTeam(s.sets, DEPTH);
  if (!fit) continue;
  console.log(`  ${s.label}: floor ${Math.round(fit.floor)} avg ${Math.round(fit.avg)} flex ${fit.flex} [${Date.now() - t0}ms]`);
  if (!best || better(fit, best.fit)) best = { label: s.label, sets: s.sets, fit };
}
if (!best) { console.error('no finalist survived'); process.exit(1); }
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
      // Scout the swap at depth 2 (cheap, floor-aborted); a promising one is
      // re-verified at full depth before adoption.
      const scout = evaluateTeam(trial, 2, best.fit.floor);
      if (!scout || !better(scout, best.fit)) continue;
      const fit = evaluateTeam(trial, DEPTH);
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
