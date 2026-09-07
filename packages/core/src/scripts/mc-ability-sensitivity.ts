// How much does an UNREVEALED mega ability actually move our matchup?
//
//   npx tsx packages/core/src/scripts/mc-ability-sensitivity.ts [team.json]
//        [--only <forme substring>] [--depth N] [--budget MS] [--allBrings]
//
// WHY. Golisopod-Mega and Baxcalibur-Mega go live on Sept 8, 2026 with abilities
// Champions never published, so `mcThreats.ts` runs them on the dex placeholder
// (the base forme's ability) and every number we have for those two matchups is
// provisional. Rather than wait for the reveal to find out whether that matters,
// this sweeps a spanning set of ability EFFECT CLASSES and reports how far our
// score moves. Then on switch-day the reveal is a lookup, not a re-derivation:
// if the envelope is tight, the placeholder baseline stands and nothing needs
// re-running; if it is wide, we know immediately to re-tune that matchup.
//
// THESE ARE NOT PREDICTIONS. The list below is chosen to span the mechanical
// CLASSES an ability can belong to (offense multiplier, damage-taken reduction,
// type-specific halving, entry disruption, speed) using abilities the calc and
// the search already implement natively — so every number is a real search
// result, not a guess dressed up as one. Nobody should read "Tough Claws +140"
// as evidence Golisopod-Mega gets Tough Claws.
//
// CAVEAT. The threat SET is held fixed and only the ability varies, so each row
// isolates the ability's mechanical effect and does NOT include the archetype
// re-tune a real reveal would enable. Speed Boost on a Trick Room shell is the
// clearest case: the number below is a floor on its true impact, because a real
// Speed Boost Golisopod would not be built around Trick Room at all.
//
// THE ANCHOR MUST ACTUALLY BE BROUGHT. evaluateMatchup does not force the mega
// into the opponent's four — it takes scoreBrings' top-1 bring for that side, and
// scoreBrings scores a stone holder on its BASE forme (bring.ts only swaps in the
// mega once entry.megaUsed is set, which never happens at preview time). Seven of
// the twelve gauntlet teams bench their own mega as a result, and a sweep over a
// benched mon returns a flat line that reads exactly like "the ability does not
// matter". So this checks first, and escalates the opponent to an EXHAUSTIVE bring
// (all 15, maximin) when the anchor is not in the top-1 — costly, but the only
// honest way to measure. See gauntlet-anchor-check.ts.
//
// IN-PROCESS ON PURPOSE. MEGA_ABILITY_OVERRIDES is module state, so the sweep
// mutates it around each evaluateMatchup call. Do NOT "speed this up" with
// MatchupPool — its workers are separate processes that would never see the
// override and would silently re-score the baseline N times.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { evaluateMatchup } from '../domain/teamSim.js';
import { MEGA_ABILITY_OVERRIDES, MEGA_ABILITY_UNREVEALED, megaFormeAbility } from '../domain/gimmicks/mega.js';
import { ALL_THREATS } from './mcThreats.js';
import { holdsOwnStone, anchorBringRank } from './gauntlet-anchor-check.js';
import type { PokemonSet } from '../domain/types.js';

const argNum = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const argStr = (f: string, d: string) => { const i = process.argv.indexOf(f); return i >= 0 ? (process.argv[i + 1] ?? d) : d; };
const DEPTH = argNum('--depth', 5);
const BUDGET = argNum('--budget', 20000);
const BRING_K = process.argv.includes('--allBrings') ? 15 : argNum('--bringK', 1);
const OPP_BRING_K = argNum('--oppBringK', BRING_K);
const ONLY = argStr('--only', '').toLowerCase();

// One representative ability per mechanical class. Every one is calc-native, so
// the search resolves it for real. See the header: classes, not predictions.
const PROBES: { ability: string; klass: string }[] = [
  { ability: 'Shell Armor', klass: 'combat-inert (crit immunity only)' },
  { ability: 'Tough Claws', klass: 'offense x1.3 on contact moves' },
  { ability: 'Sheer Force', klass: 'offense x1.3 on secondary-effect moves' },
  { ability: 'Filter', klass: 'defense x0.75 vs super-effective' },
  { ability: 'Thick Fat', klass: 'defense x0.5 vs Fire and Ice' },
  { ability: 'Intimidate', klass: 'entry-time board effect (-1 Atk)' },
  { ability: 'Speed Boost', klass: 'speed plan (+1 Spe per turn)' },
];

const teamArg = process.argv.slice(2).find(a => a.endsWith('.json'));
const teamPath = teamArg
  ? (teamArg.includes('/') || teamArg.includes('\\') ? teamArg : join(dataDirPath(), 'my-teams', teamArg))
  : join(dataDirPath(), 'my-teams', 'TalonFlameAndyBoy.json');
const team: PokemonSet[] = JSON.parse(readFileSync(teamPath, 'utf8'));

// The formes worth sweeping are exactly the ones the readiness report flags as
// unrevealed — driven by the registry, so this needs no edit when one is pinned
// (it just drops out) or a new unrevealed forme appears.
const targets = [...MEGA_ABILITY_UNREVEALED].filter(f => !ONLY || f.toLowerCase().includes(ONLY));
if (!targets.length) { console.error(`no unrevealed mega forme matches --only "${ONLY}"`); process.exit(1); }

// Find each target's threat team by looking for the base species in its sets.
const baseOf = (forme: string) => forme.replace(/-Mega(-[XYZ])?$/i, '').toLowerCase();
const teamFor = (forme: string) =>
  ALL_THREATS.find(t => t.sets.some(s => s.species.toLowerCase() === baseOf(forme)));

console.log(`team: ${teamPath.split(/[\\/]/).pop()} — ${team.map(s => s.species).join(', ')}`);
console.log(`deepen 1->${DEPTH} · ${BUDGET / 1000}s/board · bring ${BRING_K >= 15 ? 'EXHAUSTIVE (all 15)' : `top-${BRING_K}`}x opp-${OPP_BRING_K}`);
console.log('score is OURS (+ favors us); delta is vs the placeholder baseline.\n');

for (const forme of targets) {
  const threat = teamFor(forme);
  if (!threat) { console.log(`${forme}: no gauntlet team uses it — skipped\n`); continue; }
  console.log(`=== ${forme}  vs  ${threat.anchor} ===`);
  const stoneIdx = threat.sets.findIndex(holdsOwnStone);
  let oppK = OPP_BRING_K;
  if (stoneIdx >= 0) {
    const { rank, total, broughtAtTop1 } = anchorBringRank(threat.sets, team, stoneIdx);
    if (!broughtAtTop1) {
      oppK = total;
      console.log(`  NOTE  the heuristic top-1 bring BENCHES ${threat.sets[stoneIdx]!.species} (first bring holding it: rank ${rank}/${total}).`);
      console.log(`        escalating the opponent to an exhaustive ${total}-bring maximin so this measures the mega.`);
    }
  }

  const placeholder = megaFormeAbility(forme);
  const had = Object.prototype.hasOwnProperty.call(MEGA_ABILITY_OVERRIDES, forme);
  const prior = MEGA_ABILITY_OVERRIDES[forme];

  const run = () => evaluateMatchup(team, threat.sets, threat.anchor, DEPTH, BUDGET || undefined, { bringK: BRING_K, oppBringK: oppK });

  const base = run();
  console.log(`  ${'PLACEHOLDER'.padEnd(13)} ${String(placeholder).padEnd(15)} ${String(Math.round(base.score)).padStart(7)}          ${base.myBring.join('/')}`);

  const rows: { ability: string; klass: string; score: number; bring: string }[] = [];
  for (const { ability, klass } of PROBES) {
    if (ability === placeholder) continue;   // the baseline row already covers it
    MEGA_ABILITY_OVERRIDES[forme] = ability;
    try {
      const r = run();
      rows.push({ ability, klass, score: r.score, bring: r.myBring.join('/') });
      const d = r.score - base.score;
      console.log(`  ${'probe'.padEnd(13)} ${ability.padEnd(15)} ${String(Math.round(r.score)).padStart(7)}  ${(d >= 0 ? '+' : '') + Math.round(d).toString().padStart(6)}  ${r.myBring.join('/')}${r.myBring.join('/') !== base.myBring.join('/') ? '   <-- bring changes' : ''}`);
    } finally {
      if (had) MEGA_ABILITY_OVERRIDES[forme] = prior!; else delete MEGA_ABILITY_OVERRIDES[forme];
    }
  }

  const scores = [base.score, ...rows.map(r => r.score)];
  const lo = Math.min(...scores), hi = Math.max(...scores);
  const worst = rows.reduce((a, b) => (b.score < a.score ? b : a), rows[0]!);
  console.log(`\n  envelope ${Math.round(lo)} .. ${Math.round(hi)}  (spread ${Math.round(hi - lo)})`);
  console.log(`  worst class: ${worst.ability} — ${worst.klass}`);
  console.log(`  verdict: ${hi - lo < 200
    ? 'ability-INSENSITIVE — the placeholder baseline stands whatever is revealed'
    : 'ability-SENSITIVE — re-run this matchup the moment the real ability lands'}\n`);
}
