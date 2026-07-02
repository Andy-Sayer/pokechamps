// PHASE 1 — perish parameter tuning (autonomous, budget-bounded, incremental).
// Question: at what search settings does perishtrap-mb's perish core actually
// USE Perish Song AND WIN with it — or is it impossible (team too frail)?
//
// Sweeps (budgetMs, switchPlyLimit) for MY side (maxDepth high, budget-bound —
// more time + a wider switch window is what perish trap needs: deep enough to see
// the 3-turn clock, switch window long enough to stall it). The FOE plays a fixed
// cheap search so we isolate MY ability to execute. Real gauntlet opponents: a
// bulky one (perish-favorable) + typical + a fast-offense control.
//
// For each (config × opponent × seed): does Perish get cast? does a FOE hit the
// perish-0 (the clock actually killed)? who wins? Appends every result immediately
// to /tmp/perish-tune.out so a long run stays harvestable; prints a summary table.
//   npx tsx packages/core/src/scripts/perish-tune.ts
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { MB_THREATS } from './mbThreats.js';
import { playGame, makeSearchPolicy } from '../domain/simPlayout.js';
import type { PokemonSet } from '../domain/types.js';

const OUT = '/tmp/perish-tune.out';
const log = (s: string) => { console.log(s); try { appendFileSync(OUT, s + '\n'); } catch { /* ignore */ } };

const team = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'perishtrap-mb.json'), 'utf8')) as PokemonSet[];
const byId = (n: string) => team.find(s => s.species === n)!;
// Lead the Shadow-Tag trapper + a Perish partner; Incineroar/Sinistcha support (Fake
// Out / Rage Powder to shield frail Gengar while the clock ticks).
const mine = ['Gengar', 'Politoed', 'Incineroar', 'Sinistcha'].map(byId);

const pika = loadPikaData();
const allOpps = [...MB_THREATS.map(m => ({ anchor: m.anchor, sets: m.sets })), ...metaTeams(pika, 12, 4).map(m => ({ anchor: m.anchor, sets: m.sets }))];
const pick = (sub: string) => allOpps.find(o => o.anchor.toLowerCase().includes(sub.toLowerCase()));
// bulky/passive (perish-favorable), a typical bulky pivot, and a fast-offense control.
const oppNames = ['Sinistcha', 'Incineroar', 'Sneasler'];
const opponents = oppNames.map(pick).filter((o): o is NonNullable<typeof o> => !!o);

// Configs cheap → expensive so the useful cheap rows land first. maxDepth high;
// budget bounds the actual depth reached on wide boards.
const configs = [
  { budget: 2000, spl: 2, maxDepth: 10, label: 'baseline  b2s/spl2' },
  { budget: 8000, spl: 3, maxDepth: 10, label: 'moderate  b8s/spl3' },
  { budget: 20000, spl: 4, maxDepth: 12, label: 'deep      b20s/spl4' },
  { budget: 40000, spl: 5, maxDepth: 14, label: 'deepest   b40s/spl5' },
];
const SEEDS = [3, 17];

const key = (b: PokemonSet[]) => b.map(s => s.species).sort().join(',');
void key;
log(`\n=== PERISH TUNE ${new Date().toISOString()} · ${opponents.length} opps × ${configs.length} configs × ${SEEDS.length} seeds ===`);
log(`mine: ${mine.map(s => s.species).join('/')}`);

interface Row { config: string; used: number; won: number; perishKill: number; games: number }
const summary: Row[] = [];

for (const c of configs) {
  const row: Row = { config: c.label, used: 0, won: 0, perishKill: 0, games: 0 };
  for (const opp of opponents) {
    const oppBring = scoreBrings(opp.sets, mine.map(entryOf))[0]!.myIndices.map(i => opp.sets[i]!);
    for (const seed of SEEDS) {
      const t0 = Date.now();
      const r = await playGame(mine, oppBring, {
        seed: [seed, seed * 2 + 5, seed * 3 + 7, seed * 5 + 11],
        policy: makeSearchPolicy(mine, oppBring, c.maxDepth, c.budget, { switchPlyLimit: c.spl }),
        p2Policy: makeSearchPolicy(mine, oppBring, 2, 3000), // foe: fixed cheap search (side0=mine, side1=opp)
        trace: true,
      });
      row.games++;
      if ('error' in r) { log(`  ${c.label} vs ${opp.anchor} seed${seed}: ERROR ${r.error}`); continue; }
      let casts = 0, perish0 = 0;
      for (const line of r.log ?? []) {
        const p = line.split('|');
        if (p[1] === 'move' && String(p[3] ?? '').toLowerCase().includes('perish')) { if ((p[2] ?? '').startsWith('p1')) casts++; }
        // a foe (p2) mon reaching perish0 = the clock actually landed a KO on their side
        if (p[1] === '-start' && String(p[3] ?? '').toLowerCase().includes('perish0') && (p[2] ?? '').startsWith('p2')) perish0++;
      }
      const iUsed = casts > 0, iWon = r.winner === 'p1', iKill = perish0 > 0;
      if (iUsed) row.used++;
      if (iWon) row.won++;
      if (iKill) row.perishKill++;
      log(`  ${c.label} vs ${opp.anchor.padEnd(26)} seed${seed}: perishCast ${casts} · foePerish0 ${perish0} · winner ${r.winner} · ${r.turns ?? '?'}t · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }
  summary.push(row);
  log(`  --> ${c.label}: used ${row.used}/${row.games} · won ${row.won}/${row.games} · perish-kill ${row.perishKill}/${row.games}`);
}

log(`\n=== SUMMARY (config → perish-use / wins / perish-kills out of ${opponents.length * SEEDS.length} games) ===`);
for (const r of summary) log(`  ${r.config}: use ${r.used}/${r.games} · win ${r.won}/${r.games} · perishKill ${r.perishKill}/${r.games}`);
// Verdict: cheapest config with a perish-driven win (used + won + a perish-0 kill).
const viable = summary.find(r => r.won > 0 && r.perishKill > 0);
log(viable
  ? `\nVERDICT: perish is VIABLE — cheapest working config: ${viable.config} (won ${viable.won}, perish-kills ${viable.perishKill}). Use these params for the validation gauntlet.`
  : `\nVERDICT: perish NOT viable at any swept setting (no perish-driven win). perishtrap-mb's core is too frail to execute the clock — keep depth-2 sheets, park perishtrap.`);
process.exit(0);
