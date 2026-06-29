// Idea 1 — sim-grounded matchup PREP SHEETS. For each top meta archetype, compute
// (offline, where latency is free) the robust recommended bring (maximin over the
// opponent's likely brings — idea 5), its simulated win-rate, the opponent's likely
// brings, and the key threats (which opp mons OHKO ours). Writes a study reference
// you consult before/during a set — mechanically grounded, judgment-free (the sim
// decides). Output: data/prep/reg-mb-prep.md.
//   npx tsx packages/core/src/scripts/mb-prep-sheets.ts [opponents] [games]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { bestBringVsOpponent } from '../domain/bringEval.js';
import { bringModelAvailable } from '../domain/bringValueModel.js';
import { damageRange } from '../domain/damage.js';
import { NEUTRAL_FIELD, type PokemonSet } from '../domain/types.js';
import { PlayoutPool } from '../domain/playoutPool.js';

const N_OPP = parseInt(process.argv[2] ?? '10', 10);
const GAMES = parseInt(process.argv[3] ?? '8', 10);
const team = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'anti-meta-mb.json'), 'utf8')) as PokemonSet[];
const gauntlet = metaTeams(loadPikaData(), N_OPP, 4);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const sp = (s: PokemonSet[]) => s.map(m => m.species).join('/');

// Threats: opponent mons in `oppBring` that GUARANTEED-OHKO (min roll ≥ 100%, no
// crit) a mon in my bring — the safety info worth studying. minPercent (not max)
// so we don't over-state high-roll-only KOs; "my" prefix disambiguates mirrors.
function threats(myBring: PokemonSet[], oppBring: PokemonSet[]): string[] {
  const out: string[] = [];
  for (const o of oppBring) {
    const kos = myBring.filter(m => o.moves?.some(mv => {
      try { return damageRange({ attacker: o, defender: m, move: mv, field: NEUTRAL_FIELD, attackerSide: 'theirs' }).minPercent >= 100; } catch { return false; }
    }));
    if (kos.length) out.push(`${o.species} → my ${kos.map(m => m.species).join('/')}`);
  }
  return out;
}

console.log(`prep sheets · my team ${sp(team)} · ${gauntlet.length} opponents · ${GAMES} games/matchup · model ${bringModelAvailable() ? 'on' : 'OFF (scoreBrings proposer)'}\n`);
const pool = new PlayoutPool();
const t0 = Date.now();
const lines: string[] = [`# Reg M-B prep sheets — ${sp(team)}`, '', `_Sim-grounded (${GAMES} games/matchup); bring is maximin over the opponent's likely brings._`, ''];

for (const opp of gauntlet) {
  // OUR best bring vs them (robust over their likely brings).
  const rec = await bestBringVsOpponent(pool, team, opp.sets, { myBringK: 5, oppBringK: 2, games: GAMES });
  // THEIR best bring vs us — the same eval with sides flipped → a PLAYOUT-VALIDATED
  // opponent-bring prediction (stronger than the live heuristic).
  const oppRec = await bestBringVsOpponent(pool, opp.sets, team, { myBringK: 4, oppBringK: 2, games: GAMES });
  const thr = threats(rec.bring, oppRec.bring); // threats vs what they'll actually bring
  lines.push(`## vs ${opp.anchor}`);
  lines.push(`- **Bring (you):** ${sp(rec.bring)}  — **${pct(rec.maximinWr)}** (worst-case vs their likely brings)`);
  lines.push(`- **They'll likely bring (sim):** ${sp(oppRec.bring)}  — ${pct(oppRec.maximinWr)} for them`);
  lines.push(`- **Per opp-bring:** ${rec.perOppBring.map(p => `${pct(p.wr)} vs ${sp(p.oppBring)}`).join('  ·  ')}`);
  if (thr.length) lines.push(`- **Guaranteed-OHKO threats:** ${thr.join(';  ')}`);
  lines.push('');
  console.log(`vs ${opp.anchor.padEnd(12)} you ${sp(rec.bring).padEnd(38)} ${pct(rec.maximinWr)}  ·  they ${sp(oppRec.bring)}`);
}
pool.close();

const outDir = join(dataDirPath(), 'prep'); mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'reg-mb-prep.md');
writeFileSync(outPath, lines.join('\n'));
console.log(`\nwrote ${gauntlet.length} sheets → ${outPath} · ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
