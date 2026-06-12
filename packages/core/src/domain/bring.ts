import type { OpponentEntry, PokemonSet, FieldState } from './types.js';
import { NEUTRAL_FIELD } from './types.js';
import { damageRange, maxHpFor } from './damage.js';
import { getSpecies, toId, isPivotMove } from './data.js';
import { mostLikely } from './inference.js';
import { bestOffensive, offensiveTypes, speciesTypes } from './typechart.js';
import { detectTactics, profileFromSet, profileFromSpecies, tacticLabel, type TacticInstance } from './tactics.js';

// Scoring a 4-of-6 "bring":
//  - offense:   for each opp mon, max % HP my best attacker can take in one move
//  - defense:   for each opp mon, min % HP my mons take from their plausible best move
//  - speed:     # of my mons that outspeed each opp mon (with Tailwind / Trick Room considered)
//  - roles:     does the bring include speed control / redirector / support if the team has one?

export interface BringScore {
  myIndices: [number, number, number, number];
  offense: number;
  defense: number;
  speed: number;
  roles: number;
  matchup: number;
  /** Synergy credit for complete multi-part combos inside this bring. */
  tactics: number;
  /** Net counter-credit vs the opponent's available combos (can be negative). */
  threats: number;
  total: number;
  rationale: string[];
}

// Per-pair offensive multiplier of one of my mons vs one opp species.
// Considers my mon's actual damaging move types (not just STAB) so coverage
// counts. Capped at 2x so a single 4x doesn't dwarf 24 other pairs.
function pairOffense(my: PokemonSet, opp: PokemonSet): number {
  const myTypes = offensiveTypes(my.moves);
  const oppDef = speciesTypes(opp.species);
  if (!myTypes.length || !oppDef.length) return 1;
  return Math.min(2, bestOffensive(myTypes, oppDef));
}

// Per-pair defensive multiplier. We don't know the opponent's moves at preview
// time, so use their STAB types as the threat surface.
function pairDefense(my: PokemonSet, opp: PokemonSet): number {
  const myDef = speciesTypes(my.species);
  const oppStab = speciesTypes(opp.species);
  if (!myDef.length || !oppStab.length) return 1;
  return bestOffensive(oppStab, myDef);
}

// Heuristic placeholder set used when we have no info about an opponent: a level-50
// neutral spread with no item / no boosting ability.
export function defaultOpponentSet(entry: OpponentEntry, level: number): PokemonSet {
  // Use the post-mega forme's base stats once the opp has mega-evolved, so a
  // candidate-less default still calcs on the right stats (mega Aerodactyl's
  // +Atk etc.). applyMegaAction sets megaUsed + megaForme.
  const speciesName = entry.megaUsed && entry.megaForme ? entry.megaForme : entry.species;
  const species = getSpecies(speciesName);
  const abilities = species?.abilities ? (Object.values(species.abilities) as string[]) : [];
  return {
    species: species?.name ?? speciesName,
    level,
    item: entry.item ?? undefined,
    ability: entry.ability ?? abilities[0] ?? undefined,
    nature: 'Hardy',
    evs: { hp: 0, atk: 252, def: 0, spa: 252, spd: 4, spe: 0 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    moves: entry.knownMoves.length ? entry.knownMoves : ['Tackle'],
  };
}

function resolvedOpponentSet(entry: OpponentEntry, level: number): PokemonSet {
  if (entry.candidates && entry.candidates.length) {
    return entry.candidates[0]!;
  }
  return defaultOpponentSet(entry, level);
}

const SPEED_CONTROL_MOVES = new Set(['Tailwind', 'Trick Room', 'Icy Wind', 'Electroweb', 'Thunder Wave']);
const REDIRECTION_MOVES = new Set(['Follow Me', 'Rage Powder']);
const REDIRECTION_ABILITIES = new Set(['Lightning Rod', 'Storm Drain']);

function hasRole(set: PokemonSet, kind: 'speedControl' | 'redirection'): boolean {
  if (kind === 'speedControl') return set.moves.some(m => SPEED_CONTROL_MOVES.has(m));
  if (kind === 'redirection') {
    if (set.ability && REDIRECTION_ABILITIES.has(set.ability)) return true;
    return set.moves.some(m => REDIRECTION_MOVES.has(m));
  }
  return false;
}

function speedFor(set: PokemonSet): number {
  // approx — use calc to derive raw stat
  try {
    const r = damageRange({
      attacker: set,
      defender: set,
      move: set.moves[0] ?? 'Tackle',
      field: NEUTRAL_FIELD,
      attackerSide: 'mine',
    });
    // we don't really need this — fall through to species base * nature heuristic instead
    void r;
  } catch {}
  const species = getSpecies(set.species);
  const base = species?.baseStats?.spe ?? 70;
  const evBonus = Math.floor(set.evs.spe / 4);
  const natureMult = set.nature === 'Timid' || set.nature === 'Jolly' ? 1.1 :
                     set.nature === 'Modest' || set.nature === 'Adamant' || set.nature === 'Bold' || set.nature === 'Calm' ? 0.9 : 1.0;
  return Math.floor((Math.floor(((2 * base + 31 + evBonus) * set.level) / 100) + 5) * natureMult);
}

// ---------------------------------------------------------------------------
// Tactic integration (see domain/tactics.ts).
// ---------------------------------------------------------------------------

// Does one of MY sets counter an opponent tactic pattern? Checked against the
// set's real moves/ability/types — this is what earns counter-credit when the
// opponent's six could run the combo.
const PATTERN_COUNTERS: Record<string, (set: PokemonSet) => boolean> = {
  'perish-trap': s => abilityIs(s, 'soundproof') || hasMove(s, 'taunt') || s.moves.some(isPivotMove),
  'baton-pass': s => hasMove(s, 'haze') || hasMove(s, 'clearsmog') || hasMove(s, 'spectralthief') || hasMove(s, 'roar') || hasMove(s, 'whirlwind') || hasMove(s, 'taunt'),
  'stored-power': s => speciesTypes(s.species).includes('Dark') || hasMove(s, 'haze') || hasMove(s, 'clearsmog') || hasMove(s, 'taunt'),
  'trick-room': s => hasMove(s, 'trickroom') || hasMove(s, 'taunt'),
  tailwind: s => hasMove(s, 'tailwind') || hasMove(s, 'icywind') || hasMove(s, 'electroweb') || hasMove(s, 'trickroom'),
  weather: s => abilityIs(s, 'cloudnine') || abilityIs(s, 'airlock') || abilityIs(s, 'drought') || abilityIs(s, 'drizzle') || abilityIs(s, 'sandstream') || abilityIs(s, 'snowwarning') || hasMove(s, 'raindance') || hasMove(s, 'sunnyday') || hasMove(s, 'sandstorm') || hasMove(s, 'snowscape'),
  terrain: s => abilityIs(s, 'electricsurge') || abilityIs(s, 'psychicsurge') || abilityIs(s, 'grassysurge') || abilityIs(s, 'mistysurge') || hasMove(s, 'steelroller') || hasMove(s, 'icespinner'),
  'fake-out-setup': s => abilityIs(s, 'innerfocus') || abilityIs(s, 'shielddust') || abilityIs(s, 'psychicsurge') || speciesTypes(s.species).includes('Ghost'),
  'spread-immune': s => hasMove(s, 'wideguard'),
  'beat-up-justified': s => abilityIs(s, 'intimidate') || hasMove(s, 'haze') || hasMove(s, 'clearsmog'),
  'crit-anger-point': s => abilityIs(s, 'intimidate') || hasMove(s, 'haze') || hasMove(s, 'clearsmog'),
  unburden: s => hasMove(s, 'gastroacid') || abilityIs(s, 'neutralizinggas'),
  'aurora-veil': s => hasMove(s, 'brickbreak') || hasMove(s, 'ragingbull') || hasMove(s, 'psychicfangs') || abilityIs(s, 'screencleaner') || abilityIs(s, 'infiltrator'),
};

const hasMove = (s: PokemonSet, id: string) => s.moves.some(m => toId(m) === id);
const abilityIs = (s: PokemonSet, id: string) => !!s.ability && toId(s.ability) === id;

/** Best instance per pattern fully contained in the given species subset. */
function bestPerPatternWithin(instances: TacticInstance[], species: Set<string>): TacticInstance[] {
  const best = new Map<string, TacticInstance>();
  for (const t of instances) {
    if (!t.pieces.every(p => species.has(p.species))) continue;
    if ((best.get(t.pattern)?.score ?? -1) < t.score) best.set(t.pattern, t);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

function comb4(n: number): number[][] {
  const out: number[][] = [];
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++)
    for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++)
      out.push([a, b, c, d]);
  return out;
}

export function scoreBrings(myTeam: PokemonSet[], opponent: OpponentEntry[], field: FieldState = NEUTRAL_FIELD): BringScore[] {
  const level = myTeam[0]?.level ?? 50;
  const opponentSets = opponent.map(o => resolvedOpponentSet(o, level));
  // safeScore: a broken species (one calc can't construct) shouldn't crash
  // the whole bring screen — return a neutral 0 for that slot.
  const safeScore = (fn: () => number): number => {
    try {
      const v = fn();
      return Number.isFinite(v) ? v : 0;
    } catch {
      return 0;
    }
  };
  const myOffenseTable: number[][] = myTeam.map((my, i) =>
    opponentSets.map((opp, j) => safeScore(() => {
      const best = bestMoveAgainst(my, opp, field);
      const maxHP = maxHpFor(opp);
      return (best.max / maxHP) * 100;
    })),
  );
  const myDefenseTable: number[][] = myTeam.map((my, i) =>
    opponentSets.map((opp, j) => safeScore(() => {
      const worst = bestMoveAgainst(opp, my, field);
      const maxHP = maxHpFor(my);
      return (worst.max / maxHP) * 100;
    })),
  );

  const mySpeeds = myTeam.map(speedFor);
  const oppSpeeds = opponentSets.map(speedFor);

  const teamHasSpeedControl = myTeam.some(s => hasRole(s, 'speedControl'));
  const teamHasRedirection = myTeam.some(s => hasRole(s, 'redirection'));

  // Tactic synergy: combos my ACTUAL sets complete (real moves/items), once
  // over all 6 — per-bring filtering below just checks containment.
  const myTactics = detectTactics(myTeam.map(profileFromSet));
  // Opponent threats: combos their six COULD run (full learnsets, any legal
  // ability). Top instance per pattern, strong ones only.
  const oppAll = detectTactics(opponent.map(o => profileFromSpecies(o.species)), { minScore: 50 });
  const oppThreatByPattern = new Map<string, TacticInstance>();
  for (const t of oppAll) {
    if (!oppThreatByPattern.has(t.pattern)) oppThreatByPattern.set(t.pattern, t);
  }
  const oppThreats = [...oppThreatByPattern.values()].slice(0, 4);

  // Type-matchup tables, populated once per scoring pass.
  const offenseMatchup: number[][] = myTeam.map(my =>
    opponentSets.map(opp => pairOffense(my, opp)),
  );
  const defenseMatchup: number[][] = myTeam.map(my =>
    opponentSets.map(opp => pairDefense(my, opp)),
  );

  const out: BringScore[] = [];
  for (const indices of comb4(myTeam.length) as Array<[number, number, number, number]>) {
    const offense = indices.reduce((acc, i) =>
      acc + opponentSets.reduce((s, _, j) => s + Math.min(100, myOffenseTable[i]![j]!), 0), 0);
    const defense = indices.reduce((acc, i) =>
      acc + opponentSets.reduce((s, _, j) => s + (100 - Math.min(100, myDefenseTable[i]![j]!)), 0), 0);
    const speed = indices.reduce((acc, i) =>
      acc + oppSpeeds.reduce((s, oppSpe) => s + (mySpeeds[i]! >= oppSpe ? 1 : 0), 0), 0);
    // matchup: sum of (offense - defense) across all 24 pairs. Positive means
    // the bring tends to hit super-effectively while resisting the opp's STAB.
    const matchup = indices.reduce((acc, i) =>
      acc + opponentSets.reduce((s, _, j) =>
        s + (offenseMatchup[i]![j]! - defenseMatchup[i]![j]!), 0), 0);
    let roles = 0;
    const rationale: string[] = [];
    if (teamHasSpeedControl) {
      const hasIt = indices.some(i => hasRole(myTeam[i]!, 'speedControl'));
      if (hasIt) { roles += 30; rationale.push('Includes speed control'); }
      else rationale.push('Missing speed control (team has one available)');
    }
    if (teamHasRedirection) {
      const hasIt = indices.some(i => hasRole(myTeam[i]!, 'redirection'));
      if (hasIt) { roles += 20; rationale.push('Includes redirection'); }
    }
    // Synergy: best instance per pattern fully inside this bring, top 3.
    const bringSpecies = new Set(indices.map(i => myTeam[i]!.species));
    const combos = bestPerPatternWithin(myTactics, bringSpecies).slice(0, 3);
    const tactics = Math.round(combos.reduce((s, t) => s + t.score * 0.35, 0));
    for (const t of combos) rationale.push(`Combo: ${t.name} — ${tacticLabel(t)}`);
    // Threats: ±12 per strong opponent combo depending on whether the bring
    // packs a counter for it.
    let threats = 0;
    for (const t of oppThreats) {
      const counter = PATTERN_COUNTERS[t.pattern];
      const covered = !!counter && indices.some(i => counter(myTeam[i]!));
      threats += covered ? 12 : -12;
      rationale.push(`${covered ? 'Covers' : '⚠ No answer to'} opp ${t.name}: ${tacticLabel(t)}`);
    }
    const total = offense * 0.4 + defense * 0.3 + speed * 5 + roles + matchup * 8 + tactics + threats;
    out.push({
      myIndices: indices,
      offense: Math.round(offense),
      defense: Math.round(defense),
      speed,
      roles,
      matchup: Math.round(matchup * 10) / 10,
      tactics,
      threats,
      total: Math.round(total),
      rationale,
    });
  }
  out.sort((a, b) => b.total - a.total);
  return out;
}

// Exposed for the bring UI: per (my mon, opp mon) offensive multiplier.
// Returns a 4x6 grid for the chosen indices.
export function matchupGrid(myTeam: PokemonSet[], opponent: OpponentEntry[], indices: number[]): number[][] {
  return indices.map(i => opponent.map(o => {
    const oppSet = resolvedOpponentSet(o, myTeam[i]?.level ?? 50);
    return pairOffense(myTeam[i]!, oppSet);
  }));
}

function bestMoveAgainst(attacker: PokemonSet, defender: PokemonSet, field: FieldState) {
  let best = { max: 0, min: 0, move: attacker.moves[0] ?? '' };
  for (const move of attacker.moves) {
    try {
      const r = damageRange({ attacker, defender, move, field, attackerSide: 'mine' });
      if (r.max > best.max) best = { max: r.max, min: r.min, move };
    } catch { /* unknown move id, skip */ }
  }
  return best;
}

export { resolvedOpponentSet, mostLikely };
