// DEEP-VALIDATE (the hybrid's expensive half): play the CANDIDATE TEAMS at deepest
// settings (best play) on the DECISIVE matchups, to (a) resolve whether the
// fakeperish spread-opt's bulky Archaludon is real or a shallow-eval artifact, and
// (b) inform the final-team pick (fakeperish vs rain-mb on the weather/veil cells).
// Small + budget-bounded; incremental. Each team plays its scoreBrings-top bring vs
// the opponent's top bring, MY side at b40s/spl5 (deep), foe at depth-2.
//   npx tsx packages/core/src/scripts/deep-validate.ts
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { MB_THREATS } from './mbThreats.js';
import { playGame, makeSearchPolicy } from '../domain/simPlayout.js';
import type { PokemonSet } from '../domain/types.js';

const OUT = '/tmp/deep-validate.out';
const log = (s: string) => { console.log(s); try { appendFileSync(OUT, s + '\n'); } catch { /* ignore */ } };
const load = (f: string) => JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', f), 'utf8')) as PokemonSet[];

const argStr = (f: string, d: string) => { const i = process.argv.indexOf(f); return i >= 0 ? String(process.argv[i + 1]) : d; };
const teamNames = argStr('--teams', 'rain-mb,fakeperish-base,fakeperish-opt').split(',').map(s => s.trim());
const teams = teamNames.map(n => ({ name: n, sets: load(`${n}.json`) }));
const pika = loadPikaData();
const allOpps = [...MB_THREATS.map(m => ({ anchor: m.anchor, sets: m.sets })), ...metaTeams(pika, 12, 4).map(m => ({ anchor: m.anchor, sets: m.sets }))];
const pick = (s: string) => allOpps.find(o => o.anchor.toLowerCase().includes(s.toLowerCase()));
// Decisive cells (default = weather/veil); override with --opps for the contested-offense run.
const oppNames = argStr('--opps', 'Ninetales,Swampert,Sylveon').split(',').map(s => s.trim());
const opponents = oppNames.map(pick).filter((o): o is NonNullable<typeof o> => !!o);
const argNum = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const NSEEDS = argNum('--seeds', 2);
const SEEDS = [3, 17, 5, 23, 41].slice(0, NSEEDS);
// --nodes N → DETERMINISTIC reproducible search (node budget). Default keeps the old
// wall-clock b40s. spl2 is the cheaper default when going deterministic.
const NODES = argNum('--nodes', 0);
const SPL = argNum('--spl', NODES ? 2 : 5), MAXDEPTH = 14, BUDGET = 40000;
const detArgs = (a: PokemonSet[], b: PokemonSet[]) => NODES
  ? makeSearchPolicy(a, b, MAXDEPTH, undefined, { switchPlyLimit: SPL }, NODES)  // deterministic
  : makeSearchPolicy(a, b, MAXDEPTH, BUDGET, { switchPlyLimit: SPL });           // wall-clock

log(`\n=== DEEP-VALIDATE ${new Date().toISOString()} · ${NODES ? `${(NODES / 1e6).toFixed(1)}M-nodes(det)` : `b${BUDGET / 1000}s`}/spl${SPL} · ${teams.length} teams × ${opponents.length} opps × ${SEEDS.length} seeds ===`);
interface Row { team: string; opp: string; wins: number; games: number }
const rows: Row[] = [];
for (const t of teams) {
  for (const opp of opponents) {
    const myBring = scoreBrings(t.sets, opp.sets.map(entryOf))[0]!.myIndices.map(i => t.sets[i]!);
    const oppBring = scoreBrings(opp.sets, t.sets.map(entryOf))[0]!.myIndices.map(i => opp.sets[i]!);
    let wins = 0;
    for (const seed of SEEDS) {
      const t0 = Date.now();
      const r = await playGame(myBring, oppBring, {
        seed: [seed, seed * 2 + 5, seed * 3 + 7, seed * 5 + 11],
        policy: detArgs(myBring, oppBring),
        p2Policy: makeSearchPolicy(myBring, oppBring, 2),  // depth-2 fixed = deterministic + correct opponent
      });
      if (!('error' in r) && r.winner === 'p1') wins++;
      log(`  ${t.name.padEnd(16)} vs ${opp.anchor.padEnd(20)} seed${seed}: ${('error' in r) ? 'ERR' : r.winner} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    rows.push({ team: t.name, opp: opp.anchor, wins, games: SEEDS.length });
  }
}
log(`\n=== DEEP WIN-RATE (decisive cells, best play) ===`);
for (const t of teams) {
  const tr = rows.filter(r => r.team === t.name);
  const line = tr.map(r => `${r.opp.split(' ')[0]} ${r.wins}/${r.games}`).join(' · ');
  log(`  ${t.name.padEnd(16)} ${line}`);
}
process.exit(0);
