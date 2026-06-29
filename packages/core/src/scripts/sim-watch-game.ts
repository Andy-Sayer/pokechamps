// Watch ONE full Champions game play out under the search policy — a readable
// turn-by-turn from the sim's own event log. Lets us eyeball that the policy
// plays sensibly (megas, targeting, switches, KOs) and diagnose why a given bring
// wins or loses, rather than trusting a bare win/loss number.
//   npx tsx packages/core/src/scripts/sim-watch-game.ts [seed]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { playGame, makeSearchPolicy } from '../domain/simPlayout.js';
import type { PokemonSet } from '../domain/types.js';

const seed = parseInt(process.argv[2] ?? '3', 10);
const team = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'anti-meta-mb.json'), 'utf8')) as PokemonSet[];
const opp = metaTeams(loadPikaData(), 1, 3)[0]!;
const myBring = scoreBrings(team, opp.sets.map(entryOf))[0]!.myIndices.map(i => team[i]!);
const oppBring = scoreBrings(opp.sets, team.map(entryOf))[0]!.myIndices.map(i => opp.sets[i]!);
console.log(`P1 (me): ${myBring.map(s => s.species).join(', ')}`);
console.log(`P2 (${opp.anchor}): ${oppBring.map(s => s.species).join(', ')}\n`);

const r = await playGame(myBring, oppBring, { seed: [seed, seed * 2 + 5, seed * 3 + 7, seed * 5 + 11], policy: makeSearchPolicy(myBring, oppBring, 2), trace: true });
if ('error' in r) { console.error(r.error); process.exit(1); }

// Prettify the |-protocol log into a turn-by-turn narrative.
const who = (ref: string) => ref.replace(/^p(\d)[a-z]: /, (_m, n) => (n === '1' ? 'P1 ' : 'P2 '));
let started = false; // suppress the pre-game lead send-out switch spam
for (const line of r.log ?? []) {
  const p = line.split('|'); // "|move|p1a: X|Move|p2a: Y"
  if (p[1] === 'turn') started = true;
  if (!started && (p[1] === 'switch' || p[1] === 'drag')) continue;
  switch (p[1]) {
    case 'turn': console.log(`\n— Turn ${p[2]} —`); break;
    case 'move': console.log(`  ${who(p[2]!)} used ${p[3]}${p[4] && p[4].includes(':') ? ` → ${who(p[4])}` : ''}`); break;
    case 'switch': case 'drag': console.log(`  ${who(p[2]!)} ⇄ in ${p[3]!.split(',')[0]}`); break;
    case '-mega': console.log(`  ✦ ${who(p[2]!)} Mega-Evolved → ${p[3]}`); break;
    case 'faint': console.log(`  ✗ ${who(p[2]!)} fainted`); break;
    case '-terastallize': break;
    case 'win': console.log(`\n🏁 WINNER: ${p[2] === 'p1' ? 'P1 (me)' : 'P2 (' + opp.anchor + ')'}`); break;
  }
}
console.log(`\nresult: ${r.winner} by ${r.resolution} in ${r.turns} turns`);
