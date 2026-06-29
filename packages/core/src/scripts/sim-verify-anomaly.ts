// Verify the Step-0 standout: vs Pelipper, my bring Archaludon/Sableye/Dragonite/
// Garchomp scores +6 (static "even") yet lost 0/12 played out. Is that a REAL loss
// (the static score is miscalibrated) or the search POLICY misplaying (a rollout
// artifact)? Watch a couple of games to tell which.
//   npx tsx packages/core/src/scripts/sim-verify-anomaly.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { playGame, makeSearchPolicy } from '../domain/simPlayout.js';
import type { PokemonSet } from '../domain/types.js';

const team = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'anti-meta-mb.json'), 'utf8')) as PokemonSet[];
const opps = metaTeams(loadPikaData(), 3, 3);
const pelipper = opps.find(o => o.anchor === 'Pelipper') ?? opps[2]!;
const wantMine = ['Archaludon', 'Sableye', 'Dragonite', 'Garchomp'];
const myBring = wantMine.map(s => team.find(t => t.species === s)!);
const oppBring = scoreBrings(pelipper.sets, team.map(entryOf))[0]!.myIndices.map(i => pelipper.sets[i]!);
console.log(`P1 (me): ${myBring.map(s => s.species).join(', ')}`);
console.log(`P2 (${pelipper.anchor}): ${oppBring.map(s => s.species).join(', ')}\n`);

const who = (ref: string) => ref.replace(/^p(\d)[a-z]: /, (_m, n) => (n === '1' ? 'P1 ' : 'P2 '));
for (const seed of [3, 7]) {
  const r = await playGame(myBring, oppBring, { seed: [seed, seed * 2 + 5, seed * 3 + 7, seed * 5 + 11], policy: makeSearchPolicy(myBring, oppBring, 2), trace: true });
  if ('error' in r) { console.error(r.error); process.exit(1); }
  console.log(`========== seed ${seed}: ${r.winner} by ${r.resolution} in ${r.turns} turns ==========`);
  let started = false;
  for (const line of r.log ?? []) {
    const p = line.split('|');
    if (p[1] === 'turn') started = true;
    if (!started && (p[1] === 'switch' || p[1] === 'drag')) continue;
    if (p[1] === 'turn') console.log(`— Turn ${p[2]} —`);
    else if (p[1] === 'move') console.log(`  ${who(p[2]!)} ${p[3]}${p[4]?.includes(':') ? ` → ${who(p[4])}` : ''}`);
    else if (p[1] === 'switch' || p[1] === 'drag') console.log(`  ${who(p[2]!)} ⇄ ${p[3]!.split(',')[0]}`);
    else if (p[1] === '-mega') console.log(`  ✦ ${who(p[2]!)} Mega`);
    else if (p[1] === '-weather' && p[2]) console.log(`     weather: ${p[2]}`);
    else if (p[1] === 'faint') console.log(`  ✗ ${who(p[2]!)} fainted`);
    else if (p[1] === 'win') console.log(`  🏁 ${p[2]}`);
  }
  console.log();
}
