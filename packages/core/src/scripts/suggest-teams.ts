// Engine-driven team suggestions — NO LLM judgement anywhere. Teams are
// composed from three data sources and scored by the same machinery that
// runs in-app:
//   - Pikalytics usage data (real sets: tournament featuredSets > top-usage
//     moves/ability/item + topSpread)
//   - the tactics catalog (combo cores the format supports)
//   - scoreBrings vs representative meta opponent sixes (type matchups,
//     damage, speed, roles, tactic synergy/threat counters)
//
//   npx tsx packages/core/src/scripts/suggest-teams.ts [--save]
//
// --save writes the top teams to data/my-teams/suggested-<n>-<slug>.json so
// they're pickable in the TUI immediately.
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toId, dataDirPath } from '../domain/data.js';
import { loadPikaData, buildSet as buildSetShared, composeTeam as composeTeamShared, baseSpeciesFor } from '../domain/metaTeams.js';
import { detectTactics, profileFromSet } from '../domain/tactics.js';
import { scoreBrings } from '../domain/bring.js';
import type { PokemonSet, OpponentEntry } from '../domain/types.js';

const pika = loadPikaData();
if (!pika?.pokemon) { console.error('no pikalytics data — run a fetch first'); process.exit(1); }
const detail = pika.pokemon;

const composeTeam = (anchors: string[]): { name: string; sets: PokemonSet[] } | null => {
  const sets = composeTeamShared(pika, anchors);
  return sets ? { name: anchors.join('+'), sets } : null;
};
void buildSetShared;

// ---------------------------------------------------------------------------
// Candidate teams.
// ---------------------------------------------------------------------------
const candidates: { label: string; origin: string; sets: PokemonSet[] }[] = [];
const seen = new Set<string>();
const push = (label: string, origin: string, team: { sets: PokemonSet[] } | null) => {
  if (!team) return;
  const key = team.sets.map(s => s.species).sort().join('|');
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push({ label, origin, sets: team.sets });
};

// (a) Meta stacks: each of the top 8 usage mons as anchor.
for (const anchor of pika.topPokemon.slice(0, 8)) {
  push(`${anchor} core`, 'meta usage + teammate correlations', composeTeam([anchor]));
}
// (b) Tactic cores: strongest pair combos where BOTH pieces have usage data.
{
  const catalog = JSON.parse(
    readFileSync(join(dataDirPath(), 'tactics.champions.json'), 'utf8'),
  ) as { patterns: Record<string, { instances: { pieces: { species: string }[]; name: string; score: number }[] }> };
  for (const pattern of ['perish-trap', 'weather', 'terrain', 'trick-room', 'redirection']) {
    const inst = catalog.patterns[pattern]?.instances.find(t =>
      t.pieces.length === 2 && t.pieces.every(p => {
        // catalog uses forme names; map to the pikalytics key when present
        const key = Object.keys(detail).find(k => baseSpeciesFor(k) === baseSpeciesFor(p.species) || k === p.species);
        return !!key;
      }));
    if (!inst) continue;
    const anchors = inst.pieces.map(p =>
      Object.keys(detail).find(k => baseSpeciesFor(k) === baseSpeciesFor(p.species) || k === p.species)!);
    const team = composeTeam(anchors);
    // The core must actually SURVIVE composition (a second mega piece can be
    // rejected by the one-stone cap; item clashes can drop a piece). A team
    // labelled with a combo it doesn't contain would be a lie.
    const intact = team && anchors.every(a =>
      team.sets.some(s => baseSpeciesFor(s.species) === baseSpeciesFor(a)));
    if (intact) push(`${inst.name}: ${anchors.join(' + ')}`, `tactics catalog (${pattern})`, team);
  }
}

// ---------------------------------------------------------------------------
// Score each candidate vs representative meta opponent sixes.
// ---------------------------------------------------------------------------
// Opponent sixes: top-usage clusters (anchor + its top 5 teammates).
const oppSixes: OpponentEntry[][] = [];
for (const anchor of pika.topPokemon.slice(0, 4)) {
  const mates = (detail[anchor]?.teammates ?? []).map(t => t.name).filter(n => detail[n]);
  const six = [anchor, ...mates].slice(0, 6);
  if (six.length === 6) oppSixes.push(six.map(n => ({ species: baseSpeciesFor(n), knownMoves: [] })));
}

const results = candidates.map(c => {
  let total = 0;
  for (const opp of oppSixes) {
    const brings = scoreBrings(c.sets, opp);
    total += brings[0]?.total ?? 0;
  }
  const avg = total / Math.max(1, oppSixes.length);
  const combos = detectTactics(c.sets.map(profileFromSet));
  const comboTop = combos.slice(0, 3).map(t => t.name);
  return { ...c, avg: Math.round(avg), combos: comboTop };
}).sort((a, b) => b.avg - a.avg);

console.log(`\n=== Engine team suggestions (vs ${oppSixes.length} meta opponent sixes) ===\n`);
for (const r of results) {
  console.log(`[${r.avg}] ${r.label}   (${r.origin})`);
  for (const s of r.sets) console.log(`    ${s.species} @ ${s.item} · ${s.ability} · ${s.nature} · ${s.moves.join(' / ')}`);
  if (r.combos.length) console.log(`    combos: ${r.combos.join(' · ')}`);
  console.log('');
}

if (process.argv.includes('--save')) {
  const dir = join(dataDirPath(), 'my-teams');
  results.slice(0, 4).forEach((r, i) => {
    const slug = r.sets.slice(0, 2).map(s => toId(s.species)).join('-');
    const file = join(dir, `suggested-${i + 1}-${slug}.json`);
    writeFileSync(file, JSON.stringify(r.sets, null, 2));
    console.log(`saved ${file}`);
  });
}
