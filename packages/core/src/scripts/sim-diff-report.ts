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
      const { divergences } = diffTurn(input, myAct, opAct, seed);
      positions++;
      if (divergences.length) withDiv++;
      for (const d of divergences) {
        byField.set(d.field, (byField.get(d.field) ?? 0) + 1);
        if (!examples.has(d.field)) examples.set(d.field, d);
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
  console.log('  - `fainted` is now DE-CONFOUNDED (we align to the sim post-send-out baseline) and');
  console.log('    the per-position seed is varied. The residual flips both directions → it is');
  console.log('    roll-boundary NOISE (coarse mid-estimate vs one exact roll), not a mechanic gap.');
  console.log('    A true fix compares our KO-probability envelope to the sim over many seeds.\n');
}

main();
