// Does the simulation actually IMPROVE our in-game decisions? For each meta
// opponent in the existing playout dataset, compare the simulator's best bring to
// what our current production heuristic (scoreBrings) would pick — and how much
// win-rate following the simulator recovers. Zero new compute (reads
// playout-matchups.jsonl). This is the payoff metric: heuristic vs ground truth.
//   npx tsx packages/core/src/scripts/mb-bring-guide.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import type { PokemonSet } from '../domain/types.js';

interface Row { oppAnchor: string; myBring: PokemonSet[]; oppBring: PokemonSet[]; winRate: number; wins: number; games: number }
const rows: Row[] = readFileSync(join(dataDirPath(), 'training', 'playout-matchups.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Row);
const team = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'anti-meta-mb.json'), 'utf8')) as PokemonSet[];
const key = (sets: PokemonSet[]) => sets.map(s => s.species).slice().sort().join('/');

const byOpp = new Map<string, Row[]>();
for (const r of rows) { const a = byOpp.get(r.oppAnchor) ?? []; a.push(r); byOpp.set(r.oppAnchor, a); }

console.log(`per-opponent: SIMULATOR's best bring vs the static HEURISTIC's pick (${byOpp.size} opponents)\n`);
let misses = 0, recoverable = 0;
for (const [opp, rs] of byOpp) {
  const oppBring = rs[0]!.oppBring;
  const best = rs.slice().sort((a, b) => b.winRate - a.winRate)[0]!;
  const hKey = key(scoreBrings(team, oppBring.map(entryOf))[0]!.myIndices.map(i => team[i]!));
  const hRow = rs.find(r => key(r.myBring) === hKey);
  const hWr = hRow ? hRow.winRate : NaN;
  const delta = hRow ? best.winRate - hWr : 0;
  const miss = hKey !== key(best.myBring) && delta > 0.08; // >8% left on the table = a real miss (beyond ~12-game noise)
  if (miss) { misses++; recoverable += delta; }
  console.log(
    `vs ${opp.padEnd(12)} sim-best ${key(best.myBring).padEnd(40)} ${String(Math.round(best.winRate * 100) + '%').padStart(4)}` +
    `  ·  heuristic ${hKey.padEnd(40)} ${hRow ? String(Math.round(hWr * 100) + '%').padStart(4) : '  ?'}` +
    (miss ? `  ⚠ +${Math.round(delta * 100)}%` : (hKey === key(best.myBring) ? '  ✓' : '')),
  );
}
console.log(`\nthe heuristic mispicks (>8% recoverable) on ${misses}/${byOpp.size} opponents · avg ${misses ? Math.round(recoverable / misses * 100) : 0}% win-rate recoverable by following the simulator`);
