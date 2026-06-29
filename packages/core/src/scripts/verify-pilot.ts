// Verify the opponent-piloting prior (idea 5): does the simulated opponent COMMIT
// to its setup plan when piloted, vs the search-only opponent? Finds a meta team
// with a non-trivial plan (Trick Room / Tailwind / weather move), then traces the
// opponent's turn-1/2 moves WITH vs WITHOUT the pilot policy.
//   npx tsx packages/core/src/scripts/verify-pilot.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { playGame, makeSearchPolicy, makePilotPolicy, derivePilotPlan } from '../domain/simPlayout.js';
import type { PokemonSet } from '../domain/types.js';

const team = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'anti-meta-mb.json'), 'utf8')) as PokemonSet[];
const opps = metaTeams(loadPikaData(), 12, 3);
const myEntries = team.map(entryOf);

// Pick the first opponent whose scoreBrings-bring has a non-trivial pilot plan.
let chosen: { anchor: string; bring: PokemonSet[]; plan: ReturnType<typeof derivePilotPlan> } | null = null;
for (const o of opps) {
  const bring = scoreBrings(o.sets, myEntries)[0]!.myIndices.map(i => o.sets[i]!);
  const plan = derivePilotPlan(bring);
  if (plan.trickRoom || plan.tailwind || plan.weatherMove) { chosen = { anchor: o.anchor, bring, plan }; break; }
}
if (!chosen) { console.log('no meta opponent with a move-based setup plan in the pool'); process.exit(0); }
const myBring = scoreBrings(team, chosen.bring.map(entryOf))[0]!.myIndices.map(i => team[i]!);
console.log(`opponent ${chosen.anchor}: ${chosen.bring.map(s => s.species).join('/')}`);
console.log(`plan: ${JSON.stringify(chosen.plan)}\n`);

const oppMovesTurns12 = (log: string[]) => {
  const out: string[] = []; let turn = 0;
  for (const l of log) {
    const p = l.split('|');
    if (p[1] === 'turn') turn = +p[2]!;
    if (turn <= 2 && p[1] === 'move' && p[2]?.startsWith('p2')) out.push(`T${turn} ${p[3]}`);
  }
  return out.join(' · ');
};

for (const [label, p2Policy] of [
  ['search-only opp', makeSearchPolicy(myBring, chosen.bring, 2)],
  ['PILOTED opp    ', makePilotPolicy(myBring, chosen.bring, 2, chosen.plan)],
] as const) {
  const r = await playGame(myBring, chosen.bring, { seed: [3, 11, 17, 23], policy: makeSearchPolicy(myBring, chosen.bring, 2), p2Policy, trace: true });
  if ('error' in r) { console.error(r.error); process.exit(1); }
  console.log(`${label}: opp turns 1-2 → ${oppMovesTurns12(r.log ?? [])}`);
}
