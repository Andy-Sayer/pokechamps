// Ninetales-patch hunt (POOLED, deep). For the baseline + each candidate swap,
// play deep games vs the IMPROVE target (Ninetales) and the GUARD (Sneasler — the
// keystone that must not regress). Parallel across the pool via bringWinRate with
// the budget+breadth plumbing. A candidate is a real patch only if it lifts
// Ninetales AND holds Sneasler.
//   npx tsx packages/core/src/scripts/patch-hunt.ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { MB_THREATS } from './mbThreats.js';
import { PlayoutPool, bringWinRate } from '../domain/playoutPool.js';
import type { PokemonSet } from '../domain/types.js';

const load = (f: string) => JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', f), 'utf8')) as PokemonSet[];
const teamFiles = ['rain-mb.json', ...readdirSync(join(dataDirPath(), 'my-teams')).filter(f => f.startsWith('patch-') && f.endsWith('.json'))];
const teams = teamFiles.map(f => ({ name: f.replace('.json', ''), sets: load(f) }));
const pika = loadPikaData();
const allOpps = [...MB_THREATS.map(m => ({ anchor: m.anchor, sets: m.sets })), ...metaTeams(pika, 12, 4).map(m => ({ anchor: m.anchor, sets: m.sets }))];
const pick = (s: string) => allOpps.find(o => o.anchor.toLowerCase().includes(s.toLowerCase()))!;
const targets = [{ tag: 'Ninetales (improve)', opp: pick('Ninetales') }, { tag: 'Sneasler (GUARD)', opp: pick('Sneasler') }];
const GAMES = 6, DEPTH = 14, BUDGET = 20000, SPL = 5;
const pct = (x: number) => `${Math.round(x * 100)}%`;

const pool = new PlayoutPool();
console.log(`patch-hunt · ${teams.length} teams × ${targets.length} targets × ${GAMES} deep games (b${BUDGET / 1000}s/spl${SPL})\n`);
const rows: { name: string; nine: number; snea: number }[] = [];
for (const t of teams) {
  const res: Record<string, number> = {};
  for (const tg of targets) {
    const myBring = scoreBrings(t.sets, tg.opp.sets.map(entryOf))[0]!.myIndices.map(i => t.sets[i]!);
    const oppBring = scoreBrings(tg.opp.sets, t.sets.map(entryOf))[0]!.myIndices.map(i => tg.opp.sets[i]!);
    const r = await bringWinRate(pool, myBring, oppBring, GAMES, DEPTH, false, { budgetMs: BUDGET, breadth: { switchPlyLimit: SPL } });
    res[tg.tag] = r.winRate;
  }
  const nine = res['Ninetales (improve)']!, snea = res['Sneasler (GUARD)']!;
  rows.push({ name: t.name, nine, snea });
  console.log(`  ${t.name.padEnd(28)} Ninetales ${pct(nine).padStart(4)} · Sneasler ${pct(snea).padStart(4)}`);
}
pool.close();
const base = rows[0]!;
console.log(`\n=== PATCH VERDICT (baseline rain-mb: Ninetales ${pct(base.nine)}, Sneasler ${pct(base.snea)}) ===`);
const wins = rows.slice(1).filter(r => r.nine > base.nine && r.snea >= base.snea - 0.17).sort((a, b) => b.nine - a.nine);
if (wins.length) for (const w of wins) console.log(`  PATCH: ${w.name} — Ninetales ${pct(base.nine)}→${pct(w.nine)}, Sneasler ${pct(w.snea)} (held)`);
else console.log(`  no candidate lifts Ninetales without regressing Sneasler — team is tight; keep rain-mb + pilot the coin-flip.`);
process.exit(0);
