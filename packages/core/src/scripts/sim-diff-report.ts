/**
 * sim-diff-report.ts — batch the @pkmn/sim diff-harness over many random doubles
 * positions and RANK where our fast search diverges from the real engine. This
 * turns the gap backlog from a guess into evidence: the most frequent structural
 * divergences are the mechanics worth porting first (see
 * `project_sim_engine_strategy` step 2).
 *
 * Run: `npx tsx packages/core/src/scripts/sim-diff-report.ts [N]`
 * DEV ONLY (drives the @pkmn/sim devDependency via simDiff).
 */
import type { SearchInput, TurnAction } from '../domain/endgameSearch.js';
import { resolveOneTurn } from '../domain/endgameSearch.js';
import { diffTurn, type Divergence } from '../domain/simDiff.js';
import type { PokemonSet, OpponentEntry } from '../domain/types.js';
import { ZERO_EVS, MAX_IVS } from '../domain/types.js';

// A roster of real Gen 9 doubles mons whose sets DELIBERATELY span gap mechanics
// (speed-control, sleep, status, setup, weather, self-drop, redirection) so the
// report exercises them. customgame doesn't enforce learnsets/legality.
type RosterMon = { species: string; ability: string; moves: string[]; nature: string; evs: PokemonSet['evs'] };
const e = (o: Partial<PokemonSet['evs']>): PokemonSet['evs'] => ({ ...ZERO_EVS, ...o });
const ROSTER: RosterMon[] = [
  { species: 'Incineroar', ability: 'Intimidate', moves: ['Fake Out', 'Knock Off', 'Flare Blitz', 'Parting Shot'], nature: 'Careful', evs: e({ hp: 252, spd: 252 }) },
  { species: 'Amoonguss', ability: 'Regenerator', moves: ['Spore', 'Pollen Puff', 'Sludge Bomb', 'Protect'], nature: 'Calm', evs: e({ hp: 252, spd: 252 }) },
  { species: 'Flutter Mane', ability: 'Protosynthesis', moves: ['Moonblast', 'Shadow Ball', 'Icy Wind', 'Protect'], nature: 'Timid', evs: e({ spa: 252, spe: 252 }) },
  { species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake', 'Dragon Claw', 'Stone Edge', 'Protect'], nature: 'Jolly', evs: e({ atk: 252, spe: 252 }) },
  { species: 'Dragapult', ability: 'Clear Body', moves: ['Draco Meteor', 'Shadow Ball', 'Dragon Darts', 'Protect'], nature: 'Timid', evs: e({ spa: 252, spe: 252 }) },
  { species: 'Rotom-Wash', ability: 'Levitate', moves: ['Hydro Pump', 'Thunderbolt', 'Will-O-Wisp', 'Protect'], nature: 'Modest', evs: e({ hp: 252, spa: 252 }) },
  { species: 'Gholdengo', ability: 'Good as Gold', moves: ['Make It Rain', 'Shadow Ball', 'Nasty Plot', 'Protect'], nature: 'Modest', evs: e({ spa: 252, spe: 252 }) },
  { species: 'Tyranitar', ability: 'Sand Stream', moves: ['Rock Slide', 'Crunch', 'Low Kick', 'Protect'], nature: 'Adamant', evs: e({ hp: 252, atk: 252 }) },
  { species: 'Dondozo', ability: 'Unaware', moves: ['Wave Crash', 'Body Press', 'Liquidation', 'Protect'], nature: 'Impish', evs: e({ hp: 252, def: 252 }) },
  { species: 'Talonflame', ability: 'Flame Body', moves: ['Brave Bird', 'Tailwind', 'Will-O-Wisp', 'Protect'], nature: 'Jolly', evs: e({ atk: 252, spe: 252 }) },
  { species: 'Kingambit', ability: 'Defiant', moves: ['Kowtow Cleave', 'Sucker Punch', 'Iron Head', 'Protect'], nature: 'Adamant', evs: e({ hp: 252, atk: 252 }) },
  { species: 'Pelipper', ability: 'Drizzle', moves: ['Hurricane', 'Hydro Pump', 'Tailwind', 'Protect'], nature: 'Modest', evs: e({ spa: 252, spe: 4 }) },
  { species: 'Glimmora', ability: 'Toxic Debris', moves: ['Power Gem', 'Sludge Bomb', 'Spiky Shield', 'Stealth Rock'], nature: 'Modest', evs: e({ spa: 252, spe: 252 }) },
  { species: 'Annihilape', ability: 'Defiant', moves: ['Rage Fist', 'Drain Punch', 'Bulk Up', 'Protect'], nature: 'Adamant', evs: e({ hp: 252, atk: 252 }) },
];

function toSet(r: RosterMon): PokemonSet {
  return { species: r.species, ability: r.ability, moves: r.moves, nature: r.nature, evs: r.evs, ivs: MAX_IVS, level: 50, item: '' };
}

// Tiny deterministic PRNG (mulberry32) so the report is reproducible.
function rng(seed: number) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function buildPosition(rand: () => number): SearchInput {
  const pick = () => ROSTER[Math.floor(rand() * ROSTER.length)]!;
  const four = new Set<RosterMon>();
  while (four.size < 4) four.add(pick());
  const [a, b, c, d] = [...four];
  const oppOf = (s: PokemonSet): OpponentEntry => ({ species: s.species, knownMoves: s.moves, candidates: [s] });
  const hp = () => 60 + Math.floor(rand() * 41);   // 60–100% so most turns don't KO
  return {
    mine: [{ set: toSet(a!), hpPercent: hp(), active: true }, { set: toSet(b!), hpPercent: hp(), active: true }],
    opp: [{ entry: oppOf(toSet(c!)), hpPercent: hp(), active: true }, { entry: oppOf(toSet(d!)), hpPercent: hp(), active: true }],
    field: { weather: null, terrain: null, trickRoom: false } as SearchInput['field'],
    allOppRevealed: true,
  };
}

function main() {
  const N = Number(process.argv[2] ?? 300);
  // `--detail <field>` (e.g. `--detail fainted`): for every divergence on that
  // field, dump the full position — species/HP/abilities, the moves both engines
  // resolved, and our per-mon post-turn HP — so the math can be replayed by hand.
  const detailIdx = process.argv.indexOf('--detail');
  const detailField = detailIdx >= 0 ? (process.argv[detailIdx + 1] ?? 'fainted') : null;
  const rand = rng(20260531);
  const byField = new Map<string, number>();
  const examples = new Map<string, Divergence>();
  let positions = 0, withDiv = 0, errors = 0;

  for (let n = 0; n < N; n++) {
    const input = buildPosition(rand);
    // Each active attacks a random live foe (index 0 or 1).
    const myAct = new Map<number, TurnAction>([[0, { kind: 'attack', target: Math.floor(rand() * 2) }], [1, { kind: 'attack', target: Math.floor(rand() * 2) }]]);
    const opAct = new Map<number, TurnAction>([[0, { kind: 'attack', target: Math.floor(rand() * 2) }], [1, { kind: 'attack', target: Math.floor(rand() * 2) }]]);
    try {
      // Skip degenerate positions where our engine has no move for an actor.
      const our = resolveOneTurn(input, myAct, opAct);
      if (![our.mine[0], our.mine[1], our.opp[0], our.opp[1]].every(s => s)) continue;
      const seed: [number, number, number, number] = [(n * 2 + 1) % 9999, (n * 7 + 3) % 9973, (n * 13 + 5) % 9967, (n * 31 + 7) % 9949];
      // 8 varied seeds for the multi-seed faint check — primary seed + 7 offsets.
      const faintSeeds: [number, number, number, number][] = Array.from({ length: 8 }, (_, k) => [
        ((n * 2 + 1) + k * 1009) % 9999,
        ((n * 7 + 3) + k * 1013) % 9973,
        ((n * 13 + 5) + k * 1019) % 9967,
        ((n * 31 + 7) + k * 1021) % 9949,
      ] as [number, number, number, number]);
      const { divergences, hpGaps } = diffTurn(input, myAct, opAct, seed, faintSeeds);
      positions++;
      if (divergences.length) withDiv++;
      for (const d of divergences) {
        byField.set(d.field, (byField.get(d.field) ?? 0) + 1);
        if (!examples.has(d.field)) examples.set(d.field, d);
      }
      if (detailField && divergences.some(d => d.field === detailField)) {
        const monLine = (set: PokemonSet, hp: number) =>
          `${set.species} (${set.ability}) ${hp}% [${(set.moves ?? []).join('/')}]`;
        console.log(`\n--- position #${n} (${detailField} divergence) ---`);
        console.log(`  mine: ${input.mine.map(m => monLine(m.set, m.hpPercent)).join('  |  ')}`);
        console.log(`  opp:  ${input.opp.map(o => monLine(o.entry.candidates![0]!, o.hpPercent)).join('  |  ')}`);
        const actLine = (acts: Map<number, TurnAction>, slots: typeof our.mine) =>
          [...acts.entries()].map(([i, a]) => `#${i}→${a.kind === 'attack' ? `foe${(a as { target: number }).target}` : a.kind} (${slots[i]?.moveUsed ?? '?'})`).join('  ');
        console.log(`  myActs:  ${actLine(myAct, our.mine)}`);
        console.log(`  oppActs: ${actLine(opAct, our.opp)}`);
        console.log(`  ours post-turn: mine=${our.mine.map(s => s ? `${s.species}:${s.hpPct.toFixed(1)}%${s.fainted ? ' KO' : ''}` : '-').join(' ')} opp=${our.opp.map(s => s ? `${s.species}:${s.hpPct.toFixed(1)}%${s.fainted ? ' KO' : ''}` : '-').join(' ')}`);
        for (const d of divergences.filter(d => d.field === detailField)) {
          console.log(`  >> ${d.who}: ours=${d.ours} sim=${d.sim} (hpGap ${hpGaps[d.who]?.toFixed(1) ?? '?'}%)`);
        }
      }
    } catch (err) { errors++; }
  }

  console.log(`\n=== sim diff-harness report (${positions} positions, ${errors} skipped) ===`);
  console.log(`${withDiv}/${positions} positions diverged structurally from the real engine.\n`);
  const ranked = [...byField.entries()].sort((a, b) => b[1] - a[1]);
  console.log('Divergences by field (most frequent first — the porting priority):');
  for (const [field, count] of ranked) {
    const ex = examples.get(field)!;
    console.log(`  ${String(count).padStart(4)}  ${field.padEnd(12)}  e.g. ${ex.who}: ours=${ex.ours} sim=${ex.sim}`);
  }
  if (!ranked.length) console.log('  (none — fast search matched the engine on every sampled turn)');
  console.log('\nNotes:');
  console.log('  - boost:* and status are the CLEAN, discrete gaps that rank the backlog. The');
  console.log('    GUARANTEED ones are portable (self-drops [done], Defiant +2, Parting Shot -1/-1).');
  console.log('    The rest are PROBABILISTIC secondaries (10-30% burn/poison/def-drop, Flame Body)');
  console.log('    which we deliberately do NOT auto-apply — same policy as flinch / 25% para.');
  console.log('  - `fainted` uses MULTI-SEED sampling (8 seeds per position). Only positions where');
  console.log('    the sim faints a mon in 0/8 OR 8/8 seeds AND our engine disagrees are flagged.');
  console.log('    Positions where the sim faints in some-but-not-all seeds are roll-boundary noise');
  console.log('    (KO threshold straddles the mid-estimate) and are excluded. Residual `fainted`');
  console.log('    divergences are genuine modelling gaps — the mid-estimate is wrong by enough that');
  console.log('    every seed agrees, pointing to a real damage-formula difference.\n');
}

main();
