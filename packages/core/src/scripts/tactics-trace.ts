// FINALE deliverable #2 — extract the REAL in-battle tactics for the final team by
// tracing actual deep-play games (NOT hand-narrated). For each key matchup: play
// rain-mb's Nash-top bring vs the opponent's likely bring under deepest search,
// print a per-turn narrative (leads, moves+targets, mega, switches, faints), and a
// one-line "winning pattern" read from the trace. Engine-derived, per the guardrail.
//   npx tsx packages/core/src/scripts/tactics-trace.ts
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { MB_THREATS } from './mbThreats.js';
import { playGame, makeSearchPolicy } from '../domain/simPlayout.js';
import type { PokemonSet } from '../domain/types.js';

const OUT = '/tmp/tactics-trace.out';
const log = (s: string) => { console.log(s); try { appendFileSync(OUT, s + '\n'); } catch { /* ignore */ } };
const team = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'rain-mb.json'), 'utf8')) as PokemonSet[];
const pika = loadPikaData();
const allOpps = [...MB_THREATS.map(m => ({ anchor: m.anchor, sets: m.sets })), ...metaTeams(pika, 12, 4).map(m => ({ anchor: m.anchor, sets: m.sets }))];
const pick = (s: string) => allOpps.find(o => o.anchor.toLowerCase().includes(s.toLowerCase()));
// Key matchups that define how the team plays: keystone (Sneasler), bulky steel
// (Metagross), fast terrain (Raichu), the rain mirror (Swampert), and the hard
// weather hole (Ninetales — trace it honestly even if it loses).
const keyOpps = ['Sneasler', 'Metagross', 'Raichu', 'Swampert', 'Ninetales'].map(pick).filter((o): o is NonNullable<typeof o> => !!o);
const SEEDS = [3, 17, 5];
const who = (ref: string) => ref.replace(/^p(\d)[a-z]: /, (_m, n) => (n === '1' ? 'US ' : 'THEM '));

for (const opp of keyOpps) {
  const myBring = scoreBrings(team, opp.sets.map(entryOf))[0]!.myIndices.map(i => team[i]!);
  const oppBring = scoreBrings(opp.sets, team.map(entryOf))[0]!.myIndices.map(i => opp.sets[i]!);
  // Prefer a seed we WIN, so the trace shows the winning line; fall back to seed 0.
  let chosen: Awaited<ReturnType<typeof playGame>> | null = null; let chosenSeed = SEEDS[0]!;
  for (const seed of SEEDS) {
    const r = await playGame(myBring, oppBring, {
      seed: [seed, seed * 2 + 5, seed * 3 + 7, seed * 5 + 11],
      policy: makeSearchPolicy(myBring, oppBring, 14, 40000, { switchPlyLimit: 5 }),
      p2Policy: makeSearchPolicy(oppBring, myBring, 2, 3000), trace: true,
    });
    chosen = r; chosenSeed = seed;
    if (!('error' in r) && r.winner === 'p1') break;
  }
  const r = chosen!;
  log(`\n============================================================`);
  log(`vs ${opp.anchor}  ·  bring: ${myBring.map(s => s.species).join('/')}  ·  seed ${chosenSeed}  ·  ${('error' in r) ? 'ERROR' : 'result: ' + (r.winner === 'p1' ? 'WIN' : r.winner === 'p2' ? 'LOSS' : 'tie')}`);
  log(`opp brought: ${oppBring.map(s => s.species).join('/')}`);
  if ('error' in r) { log(`  ${r.error}`); continue; }
  let started = false;
  for (const line of r.log ?? []) {
    const p = line.split('|'); const tag = p[1];
    if (tag === 'turn') { started = true; log(`-- turn ${p[2]} --`); continue; }
    if (!started) continue;
    if (tag === 'move') log(`  ${who(p[2] ?? '')}→ ${p[3]}${p[4] && p[4] !== '[still]' ? ' @ ' + who(p[4]) : ''}`);
    else if (tag === 'switch' || tag === 'drag') log(`  ${who(p[2] ?? '')}<= switch to ${(p[3] ?? '').split(',')[0]}`);
    else if (tag === '-mega' || tag === 'detailschange') log(`     * ${who(p[2] ?? '')}MEGA -> ${p[3] ?? ''}`);
    else if (tag === 'faint') log(`  ${who(p[2] ?? '')}FAINTED`);
    else if (tag === '-terastallize') log(`     * ${who(p[2] ?? '')}TERA`);
  }
}
log(`\n(tactics trace complete)`);
process.exit(0);
