// Idea 3 — validate the opponent-spread INFERENCE against sim GROUND TRUTH. Play a
// sim game between known teams (we author both → we know the true spreads), extract
// the single-roll damage observations via the J pipeline, run the inverse solver on
// our hits against each opponent mon, and measure how well it recovers their true
// EV spread. (Item/ability pinned to truth to isolate EV/nature recovery — the
// realistic case once those are revealed.) Light compute (a few sequential games),
// so it won't contend with a running playout pool.
//   npx tsx packages/core/src/scripts/validate-inference.ts [oppAnchor|idx] [games]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { playGame } from '../domain/simPlayout.js';
import { parseReplayLog } from '../domain/showdownReplay.js';
import { ingestTranscript } from '../domain/replayDriver.js';
import { inferSpread, mostLikely, type SpreadCandidate } from '../domain/inference.js';
import { NEUTRAL_FIELD, type PokemonSet } from '../domain/types.js';

const arg = process.argv[2] ?? '2';
const GAMES = parseInt(process.argv[3] ?? '4', 10);
const team = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'anti-meta-mb.json'), 'utf8')) as PokemonSet[];
const opp = metaTeams(loadPikaData(), 12, 3).find(o => o.anchor.toLowerCase() === arg.toLowerCase()) ?? metaTeams(loadPikaData(), 12, 3)[parseInt(arg, 10)] ?? metaTeams(loadPikaData(), 12, 3)[2]!;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const mineBy = new Map(team.map(s => [norm(s.species), s]));
const oppBy = new Map(opp.sets.map(s => [norm(s.species), s]));
const ev = (s: PokemonSet, k: 'hp' | 'def' | 'spd') => s.evs?.[k] ?? 0;

console.log(`my team: ${team.map(t => t.species).join(', ')}`);
console.log(`opponent (${opp.anchor}): ${opp.sets.map(s => s.species).join(', ')}`);
console.log(`inferring their DEFENSIVE spreads from our hits over ${GAMES} sim games (item/ability pinned to truth)\n`);

// Accumulate narrowed candidates per opponent species across all observations.
const cand = new Map<string, SpreadCandidate[] | undefined>();
const obsCount = new Map<string, number>();

for (let g = 0; g < GAMES; g++) {
  const r = await playGame(team.slice(0, 4), opp.sets.slice(0, 4), { seed: [g + 1, 2 * g + 5, 3 * g + 7, 5 * g + 11], trace: true });
  if ('error' in r) { console.error(r.error); process.exit(1); }
  const ingest = ingestTranscript(parseReplayLog((r.log ?? []).join('\n')));
  for (const d of ingest.damage) {
    const atkId = norm(d.attacker), defId = norm(d.defender);
    const attackerSet = mineBy.get(atkId), trueDef = oppBy.get(defId);
    if (!attackerSet || !trueDef) continue;        // only OUR hits on THEIR mons
    if (d.verdict === 'skipped' || !(d.observedPct > 0)) continue;
    const next = inferSpread({
      defenderSpecies: trueDef.species, defenderLevel: 50, knownDefenderMoves: trueDef.moves,
      attackerSet,
      observation: { attackerSide: 'mine', attackerSpecies: attackerSet.species, defenderSide: 'theirs', defenderSpecies: trueDef.species, move: d.move, field: NEUTRAL_FIELD, damageHpPercent: d.observedPct },
      priorItems: [trueDef.item as string], priorAbilities: [trueDef.ability as string],
      startingCandidates: cand.get(defId),
    });
    if (next.length) { cand.set(defId, next); obsCount.set(defId, (obsCount.get(defId) ?? 0) + 1); }
  }
}

console.log('opp mon         obs  TRUE spread             INFERRED most-likely        recovered?');
let measured = 0, recovered = 0;
for (const [defId, candidates] of cand) {
  const trueDef = oppBy.get(defId)!;
  const top = mostLikely(candidates ?? []);
  if (!top) continue;
  measured++;
  const fmt = (e: { hp: number; def: number; spd: number }, n: string) => `${n} ${e.hp}/${e.def}/${e.spd} (H/D/SpD)`;
  const trueEv = { hp: ev(trueDef, 'hp'), def: ev(trueDef, 'def'), spd: ev(trueDef, 'spd') };
  const gotEv = { hp: top.evs.hp ?? 0, def: top.evs.def ?? 0, spd: top.evs.spd ?? 0 };
  // "recovered" = the bulk-relevant EVs land within one grid bucket (~32) of truth.
  const close = Math.abs(trueEv.hp - gotEv.hp) <= 32 && Math.abs(trueEv.def - gotEv.def) <= 32 && Math.abs(trueEv.spd - gotEv.spd) <= 32;
  if (close) recovered++;
  console.log(`${trueDef.species.padEnd(14)} ${String(obsCount.get(defId) ?? 0).padStart(3)}  ${fmt(trueEv, trueDef.nature ?? '?').padEnd(24)} ${fmt(gotEv, top.nature).padEnd(28)} ${close ? '✓' : '✗'}`);
}
console.log(`\nrecovered the bulk spread (±1 bucket) on ${recovered}/${measured} measured opp mons`);
