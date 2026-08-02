// perish-counter-deep.ts — the 2026-07-28 perish-trap matchup, re-analysed with
// the deep search built 2026-08-01/02 (opponent-foresight model + root-commit +
// my-side LMR: depth 4-5 is now reachable, which is the FULL perish cycle —
// cast → three ticks). The earlier answers came from @pkmn/sim seed studies
// (talonflame-perish-counter.ts, perish-real-game.ts) and the pattern advisory;
// this asks whether the SEARCH now independently finds the same counter-play.
//
//   npx tsx packages/core/src/scripts/perish-counter-deep.ts [--budget MS]
//
// Model note: for counter-play the OPPONENT is the trap pilot, so it must not
// be modelled too dumb — a 1-ply chooser barely values casting a song whose
// payoff is three turns out. Foresight 2 (cast → first tick, with the leaf's
// perishWeight crediting sealed traps) is the floor used here; the exact model
// at its affordable depth is printed alongside as the conservative reference.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import {
  createSearch, searchBudgeted, type SearchInput, type SearchBreadth, type SearchResult,
} from '../domain/endgameSearch.js';
import { NEUTRAL_FIELD, MAX_IVS, ZERO_EVS, type PokemonSet, type OpponentEntry } from '../domain/types.js';

const arg = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const BUDGET = arg('--budget', 180_000);

const team: PokemonSet[] = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'TalonFlameAndyBoy.json'), 'utf8'));
const mine = (species: string): PokemonSet => {
  const m = team.find(t => t.species === species);
  if (!m) throw new Error(`${species} not on the team`);
  return m;
};

const set = (p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet =>
  ({ level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p });
const oppOf = (s: PokemonSet): OpponentEntry =>
  ({ species: s.species, knownMoves: s.moves, candidates: [s], item: s.item ?? undefined, ability: s.ability ?? undefined });

// The reconstructed 2026-07-28 opponents (perish-real-game.ts, 6/6 verified).
const gengar = set({
  species: 'Gengar', ability: 'Cursed Body', item: 'Gengarite', nature: 'Timid',
  evs: { ...ZERO_EVS, hp: 4, spa: 252, spe: 252 },
  moves: ['Perish Song', 'Destiny Bond', 'Shadow Ball', 'Protect'],
});
const blastoise = set({
  species: 'Blastoise', ability: 'Torrent', item: 'Leftovers', nature: 'Bold',
  evs: { ...ZERO_EVS, hp: 252, def: 252, spd: 4 },
  moves: ['Fake Out', 'Surf', 'Ice Beam', 'Protect'],
});
const incin = set({
  species: 'Incineroar', ability: 'Intimidate', item: 'Safety Goggles', nature: 'Careful',
  evs: { ...ZERO_EVS, hp: 252, atk: 4, spd: 252 },
  moves: ['Fake Out', 'Knock Off', 'Flare Blitz', 'Parting Shot'],
});
const archaludon = set({
  species: 'Archaludon', ability: 'Stamina', item: 'Assault Vest', nature: 'Modest',
  evs: { ...ZERO_EVS, hp: 252, spa: 252, spd: 4 },
  moves: ['Electro Shot', 'Draco Meteor', 'Flash Cannon', 'Body Press'],
});

function run(label: string, input: SearchInput, breadth: SearchBreadth | undefined, maxDepth: number): SearchResult {
  const t0 = performance.now();
  let last: SearchResult | null = null;
  last = searchBudgeted(input, maxDepth, BUDGET, undefined, breadth);
  const ms = ((performance.now() - t0) / 1000).toFixed(1);
  const plays = last.plays.map(p => `${p.mySpecies} ${p.move} → ${p.targetSpecies}`).join(' · ');
  console.log(`\n  [${label}] d${last.depth} in ${ms}s · ${last.verdict}${last.forced ? ' (FORCED)' : ''} · score ${Math.round(last.score)}${last.winChance != null ? ` · win ${(last.winChance * 100).toFixed(0)}%` : ''}`);
  console.log(`    plays: ${plays || '(none)'}${last.megaMon ? ` · mega ${last.megaMon}` : ''}`);
  if (last.oppLine?.length) console.log(`    their line: ${last.oppLine.map(p => `${p.mySpecies} ${p.move}`).join(' · ')}`);
  if (last.perishTrap) console.log(`    perish advisory: ${JSON.stringify(last.perishTrap).slice(0, 220)}`);
  if (last.risks?.length) console.log(`    risks: ${last.risks.slice(0, 3).map(r => r.label ?? JSON.stringify(r).slice(0, 80)).join(' | ')}`);
  return last;
}

// ---------------------------------------------------------------------------
// P1 — TURN 1. Playbook-advised leads (Meowscarada + Garchomp — "lead your
// answers", c6f4012) vs their real leads (Gengar + Blastoise). Gengar has the
// stone but has not yet mega'd: the search branches the mega decision itself.
// ---------------------------------------------------------------------------
console.log('=== P1: turn 1 · my advised leads vs Gengar + Blastoise (all sets known) ===');
const p1: SearchInput = {
  mine: [
    { set: mine('Meowscarada'), hpPercent: 100, active: true },
    { set: mine('Garchomp'), hpPercent: 100, active: true },
    { set: mine('Talonflame'), hpPercent: 100, active: false },
    { set: mine('Dragonite'), hpPercent: 100, active: false },
  ],
  opp: [
    { entry: oppOf(gengar), hpPercent: 100, active: true },
    { entry: oppOf(blastoise), hpPercent: 100, active: true },
    { entry: oppOf(incin), hpPercent: 100, active: false },
    { entry: oppOf(archaludon), hpPercent: 100, active: false },
  ],
  field: { ...NEUTRAL_FIELD },
  allOppRevealed: true,
};
run('exact · reference', p1, undefined, 3);
run('foresight 2 · deep', p1, { oppForesight: 2 }, 5);

// ---------------------------------------------------------------------------
// P2 — THE POST-SONG TURN (the playbook's "coin flip"). Song landed T1 while
// Blastoise Fake-Out'd; every clock is on 3, Gengar is MEGA (Shadow Tag traps
// my grounded mons), Fake Out is spent (firstTurnOut false everywhere).
// Playbook line: T2 Earthquake the Gengar; their perfect reply is Protect ×2
// then withdraw. Does the deep search find the same structure — and does it
// value the switch-out timing (T3) that clears my counts?
// ---------------------------------------------------------------------------
console.log('\n=== P2: post-song turn · all clocks 3 · Mega Gengar traps · Fake Out spent ===');
const p2: SearchInput = {
  mine: [
    { set: mine('Meowscarada'), hpPercent: 100, active: true, perishCount: 3, firstTurnOut: false },
    { set: mine('Garchomp'), hpPercent: 100, active: true, perishCount: 3, firstTurnOut: false },
    { set: mine('Talonflame'), hpPercent: 100, active: false, perishCount: 3 },
    { set: mine('Dragonite'), hpPercent: 100, active: false, perishCount: 3 },
  ],
  opp: [
    { entry: { ...oppOf(gengar), megaUsed: true }, hpPercent: 100, active: true, megaActive: true, perishCount: 3, firstTurnOut: false },
    { entry: oppOf(blastoise), hpPercent: 100, active: true, perishCount: 3, firstTurnOut: false },
    { entry: oppOf(incin), hpPercent: 100, active: false },
    { entry: oppOf(archaludon), hpPercent: 100, active: false },
  ],
  field: { ...NEUTRAL_FIELD },
  allOppRevealed: true,
  oppMegaSpent: true,
};
run('exact · reference', p2, undefined, 3);
run('foresight 2 · deep', p2, { oppForesight: 2 }, 5);
run('foresight 1 · deepest', p2, { oppForesight: 1 }, 5);
