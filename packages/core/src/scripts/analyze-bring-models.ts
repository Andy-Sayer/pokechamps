// Audit the bring PROPOSERS against the playout ground truth (bring-truth.<fmt>.json).
// recommend-bring proposes a top-K shortlist (heuristic or value model) then the sim
// disposes it — so the proposer's real job is RECALL@K: does its top-K CONTAIN the
// truth-best bring? Low recall = good brings gated out before the sim sees them (→
// must propose exhaustively). Reports recall@1/3/5 + avg rank of the truth-best for
// scoreBrings and the value model.
//   npx tsx packages/core/src/scripts/analyze-bring-models.ts [team.json] [truth.json]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, CHAMPIONS_PIKA_FORMAT } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { bringWinProb, bringModelAvailable, bringModelInfo } from '../domain/bringValueModel.js';
import { NEUTRAL_FIELD } from '../domain/types.js';
import { MB_THREATS } from './mbThreats.js';
import type { PokemonSet } from '../domain/types.js';

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const TEAM = positional[0] ?? 'anti-meta-mb.json';
const TRUTH = positional[1] ?? `bring-truth.${CHAMPIONS_PIKA_FORMAT}.json`;
type Truth = { anchor: string; brings: { species: string[]; maximinWr: number }[] }[];

const myTeam = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', TEAM), 'utf8')) as PokemonSet[];
const truth = JSON.parse(readFileSync(join(dataDirPath(), TRUTH), 'utf8')) as Truth;
const oppByAnchor = new Map<string, PokemonSet[]>();
for (const m of MB_THREATS) oppByAnchor.set(m.anchor, m.sets);
for (const m of metaTeams(loadPikaData(), 12, 4)) oppByAnchor.set(m.anchor, m.sets);

const combos: number[][] = [];
for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) for (let c = b + 1; c < 6; c++) for (let d = c + 1; d < 6; d++) combos.push([a, b, c, d]);
const key = (a: string[]) => [...a].sort().join(',');

const haveModel = bringModelAvailable();
console.log(`bring-proposer audit · ${TEAM} · ${truth.length} opponents`);
console.log(`value model: ${haveModel ? `${bringModelInfo()?.trainedOn} matchups, ${bringModelInfo()?.date}` : 'UNAVAILABLE (absent or stale feature set)'}\n`);

const sbRanks: number[] = [];
const vmRanks: number[] = [];
for (const t of truth) {
  const sets = oppByAnchor.get(t.anchor);
  if (!sets || t.brings.length === 0) continue;
  const bestKey = key(t.brings.reduce((a, b) => (b.maximinWr > a.maximinWr ? b : a)).species);

  // scoreBrings ranks all 15; find where the truth-best lands.
  const sbRanked = scoreBrings(myTeam, sets.map(entryOf), NEUTRAL_FIELD);
  const sbRank = sbRanked.findIndex(s => key(s.myIndices.map(i => myTeam[i]!.species)) === bestKey) + 1;
  sbRanks.push(sbRank || 16);

  // value model ranks all 15 vs the opp's most-likely bring.
  let vmRank = NaN;
  if (haveModel) {
    const oppBring = scoreBrings(sets, myTeam.map(entryOf), NEUTRAL_FIELD)[0]!.myIndices.map(i => sets[i]!);
    const vmRanked = combos
      .map(c => ({ c, p: bringWinProb(c.map(i => myTeam[i]!), oppBring) ?? -1 }))
      .sort((a, b) => b.p - a.p);
    vmRank = vmRanked.findIndex(r => key(r.c.map(i => myTeam[i]!.species)) === bestKey) + 1;
    vmRanks.push(vmRank || 16);
  }
  console.log(`  ${t.anchor.padEnd(30)} truth-best rank — scoreBrings #${sbRank || '?'}${haveModel ? `  ·  valueModel #${vmRank || '?'}` : ''}`);
}

const recall = (ranks: number[], k: number) => `${Math.round((ranks.filter(r => r <= k).length / ranks.length) * 100)}%`;
const avg = (ranks: number[]) => (ranks.reduce((a, c) => a + c, 0) / ranks.length).toFixed(1);
console.log(`\nscoreBrings   recall@1 ${recall(sbRanks, 1)}  @3 ${recall(sbRanks, 3)}  @5 ${recall(sbRanks, 5)}   avg rank of best ${avg(sbRanks)}`);
if (haveModel) console.log(`value model   recall@1 ${recall(vmRanks, 1)}  @3 ${recall(vmRanks, 3)}  @5 ${recall(vmRanks, 5)}   avg rank of best ${avg(vmRanks)}`);
console.log(`\n(recall@K = how often the truth-best bring is within the proposer's top-K — i.e. survives to the sim. recommend-bring proposes top-5.)`);
