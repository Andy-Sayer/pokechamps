// Deep-search tactics probe for the Ninetales-Alola hole. The earlier LOSS trace
// used a Pelipper-LESS bring, so the rain-override line was never tested. Here we
// bring PELIPPER (Drizzle rain overrides Snow Warning → kills Aurora Veil, drops
// Blizzard to 70% acc, and doesn't hurt us) and let the DEEP search play it out —
// testing the user's hypotheses (re-set weather via Pelipper; slower switch-in so
// our weather sets last). Reports per bring: win-rate, rain-vs-snow uptime, Sash-
// Whimsicott handling, and a winning-game narrative. Engine-derived, not asserted.
//   npx tsx packages/core/src/scripts/ninetales-probe.ts
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { MB_THREATS } from './mbThreats.js';
import { playGame, makeSearchPolicy } from '../domain/simPlayout.js';
import type { PokemonSet } from '../domain/types.js';

const OUT = '/tmp/ninetales-probe.out';
const log = (s: string) => { console.log(s); try { appendFileSync(OUT, s + '\n'); } catch { /* ignore */ } };
const team = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'rain-mb.json'), 'utf8')) as PokemonSet[];
const byId = (n: string) => team.find(s => s.species === n)!;
const pika = loadPikaData();
const allOpps = [...MB_THREATS.map(m => ({ anchor: m.anchor, sets: m.sets })), ...metaTeams(pika, 12, 4).map(m => ({ anchor: m.anchor, sets: m.sets }))];
const opp = allOpps.find(o => o.anchor.toLowerCase().includes('ninetales'))!;
const oppBring = scoreBrings(opp.sets, team.map(entryOf))[0]!.myIndices.map(i => opp.sets[i]!);

// Brings to test — all PELIPPER-first (Pelipper leads to set/keep rain). Compare
// the Nash-recommended cores; the baseline LOSS used Talonflame/Garchomp/Kingambit/
// Dragonite (no Pelipper) which we include as the control.
const brings: Record<string, string[]> = {
  'CONTROL no-Pelipper': ['Talonflame', 'Garchomp', 'Kingambit', 'Dragonite'],
  'Pelipper lead A': ['Pelipper', 'Garchomp', 'Kingambit', 'Dragonite'],
  'Pelipper lead B': ['Pelipper', 'Kingambit', 'Dragonite', 'Meowscarada'],
  'Pelipper+Talon (Tailwind)': ['Pelipper', 'Talonflame', 'Garchomp', 'Dragonite'],
};
const SEEDS = [3, 17, 5, 23];
const who = (r: string) => r.replace(/^p(\d)[a-z]: /, (_m, n) => (n === '1' ? 'US ' : 'THEM '));

log(`\n=== NINETALES DEEP PROBE ${new Date().toISOString()} · deep b40s/spl5 · opp ${oppBring.map(s => s.species).join('/')} ===`);
for (const [label, names] of Object.entries(brings)) {
  const myBring = names.map(byId);
  let wins = 0; let rainTurns = 0, snowTurns = 0; let bestWinLog: string[] | null = null;
  for (const seed of SEEDS) {
    const r = await playGame(myBring, oppBring, {
      seed: [seed, seed * 2 + 5, seed * 3 + 7, seed * 5 + 11],
      policy: makeSearchPolicy(myBring, oppBring, 14, 40000, { switchPlyLimit: 5 }),
      p2Policy: makeSearchPolicy(oppBring, myBring, 2, 3000), trace: true,
    });
    if ('error' in r) { log(`  ${label} seed${seed}: ERROR ${r.error}`); continue; }
    // Weather uptime: which weather was active as each turn began.
    let cur = ''; for (const line of r.log ?? []) { const p = line.split('|'); if (p[1] === '-weather') cur = String(p[2] ?? ''); if (p[1] === 'turn') { if (/rain/i.test(cur)) rainTurns++; else if (/snow|hail/i.test(cur)) snowTurns++; } }
    const won = r.winner === 'p1';
    if (won) { wins++; if (!bestWinLog) bestWinLog = r.log ?? []; }
    log(`  ${label.padEnd(26)} seed${seed}: ${r.winner === 'p1' ? 'WIN ' : r.winner === 'p2' ? 'LOSS' : 'tie '} · ${r.turns ?? '?'}t`);
  }
  log(`  --> ${label}: ${wins}/${SEEDS.length} wins · rain-turns ${rainTurns} vs snow-turns ${snowTurns}`);
  if (bestWinLog) {
    log(`     winning line:`);
    let started = false;
    for (const line of bestWinLog) {
      const p = line.split('|'); const tag = p[1];
      if (tag === 'turn') { started = true; log(`       -- turn ${p[2]} --`); continue; }
      if (!started) continue;
      if (tag === 'move') log(`         ${who(p[2] ?? '')}→ ${p[3]}${p[4] && p[4] !== '[still]' ? ' @ ' + who(p[4]) : ''}`);
      else if (tag === 'switch') log(`         ${who(p[2] ?? '')}<= in ${(p[3] ?? '').split(',')[0]}`);
      else if (tag === '-weather' && p[2]) log(`            ~ weather: ${p[2]}`);
      else if (tag === '-mega') log(`            * ${who(p[2] ?? '')}MEGA`);
      else if (tag === 'faint') log(`         ${who(p[2] ?? '')}FAINTED`);
    }
  }
}
log(`\n(ninetales probe complete)`);
process.exit(0);
