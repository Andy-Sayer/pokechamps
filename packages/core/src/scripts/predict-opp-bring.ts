// Demo/verify the opponent-bring predictor: vs a meta opponent, show their likely
// 4-of-6 at preview, then — given a revealed lead pair — the predicted back two.
//   npx tsx packages/core/src/scripts/predict-opp-bring.ts [oppAnchor|idx]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { predictOppBring, predictOppBack } from '../domain/oppBringPredict.js';
import type { PokemonSet } from '../domain/types.js';

const arg = process.argv[2] ?? '2';
const team = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'anti-meta-mb.json'), 'utf8')) as PokemonSet[];
const opps = metaTeams(loadPikaData(), 12, 3);
const opp = opps.find(o => o.anchor.toLowerCase() === arg.toLowerCase()) ?? opps[parseInt(arg, 10)] ?? opps[2]!;
const sp = (s: PokemonSet[]) => s.map(m => m.species).join('/');

console.log(`my team: ${team.map(t => t.species).join(', ')}`);
console.log(`opponent (${opp.anchor})'s six: ${opp.sets.map(s => s.species).join(', ')}\n`);

// (1) Preview prediction.
const pred = predictOppBring(opp.sets, team, 3);
console.log(`① likely opponent bring: ${sp(pred.likely)}   (confidence ${Math.round(pred.confidence * 100)}%)`);
console.log(`   alternatives: ${pred.alternatives.map(a => sp(a.bring)).join('  ·  ')}\n`);

// (2) Back-two prediction, given the first two of the predicted bring as the leads.
const leads = pred.likely.slice(0, 2).map(m => m.species);
console.log(`② if they lead ${leads.join(' + ')} — likely back two:`);
for (const g of predictOppBack(opp.sets, team, leads)) {
  console.log(`   ${sp(g.back).padEnd(28)} (full bring ${sp(g.full)})`);
}
