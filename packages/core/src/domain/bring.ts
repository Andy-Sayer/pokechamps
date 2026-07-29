import type { OpponentEntry, PokemonSet, FieldState } from './types.js';
import { NEUTRAL_FIELD } from './types.js';
import { damageRange, maxHpFor } from './damage.js';
import { getSpecies, toId, isPivotMove } from './data.js';
import { mostLikely } from './inference.js';
import { bestOffensive, offensiveTypes, speciesTypes } from './typechart.js';
import { detectTactics, profileFromSet, profileFromSpecies, tacticLabel, type TacticInstance } from './tactics.js';
import { getMegaOptions } from './gimmicks/mega.js';

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

// Speed control = anything that swings the speed order in our favour: our-side
// boosts (Tailwind), the inverter (Trick Room), foe-speed drops (Icy Wind /
// Electroweb / paralysis / Scary Face / Cotton Spore / String Shot). Scary Face
// et al. were missing, so a Prankster speed-dropper (e.g. Grimmsnarl) was wrongly
// scored as "no speed control" — handing brings with a Tailwind setter a free
// role edge they didn't deserve.
const SPEED_CONTROL_MOVES = new Set(['Tailwind', 'Trick Room', 'Icy Wind', 'Electroweb', 'Thunder Wave', 'Scary Face', 'Cotton Spore', 'String Shot']);
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
// opponent's six could run the combo. Exported so the battle screen's combo
// watch can name WHICH of my brought mons answers a live threat.
/** Extra context a counter may use. Optional so the existing one-argument call
 *  sites keep working; only perish-trap needs it today. */
export interface CounterCtx {
  /** Speed to beat — the singer/setter AFTER any mega, since that is the forme
   *  that actually moves. Outrunning it is a counter in its own right. */
  threatSpeed?: number;
}

/** Speed including a Choice Scarf, which is the whole reason a Scarf mon counts
 *  as a perish answer at all. */
export function effectiveSpeed(set: PokemonSet): number {
  const raw = speedFor(set);
  return toId(set.item ?? '') === 'choicescarf' ? Math.floor(raw * 1.5) : raw;
}

export const PATTERN_COUNTERS: Record<string, (set: PokemonSet, ctx?: CounterCtx) => boolean> = {
  // Rewritten 2026-07-29 after the live loss + sim work (docs/notes/tactics.md).
  // The old test was `soundproof || taunt || pivot`, which gave the Choice Scarf
  // Garchomp ZERO credit — and the Scarf was the only real answer on the team,
  // because outrunning the singer kills it before the song is ever sung. The
  // passive escapes (Ghost typing, Shed Shell) were missing too.
  'perish-trap': (s, ctx) =>
    abilityIs(s, 'soundproof')                                   // the song cannot touch it
    || hasMove(s, 'taunt')                                       // deny the song outright
    || speciesTypes(s.species).includes('Ghost')                 // ignores trapping entirely
    || toId(s.item ?? '') === 'shedshell'                        // switches out regardless
    || s.moves.some(isPivotMove)                                 // escapes AND clears the count
    || (ctx?.threatSpeed != null && effectiveSpeed(s) > ctx.threatSpeed),  // kill it first
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

/** Predicted opponent lead pair from their combo space: the strongest
 *  two-mon tactic their six could run wants its pieces on the field together
 *  from turn 1. Null when nothing pair-shaped clears the bar — predicting
 *  leads off a weak signal is worse than staying quiet. */
export function predictOppLeads(opponent: OpponentEntry[]): { species: [string, string]; tactic: TacticInstance } | null {
  const tactics = detectTactics(opponent.map(o => profileFromSpecies(o.species)), { minScore: 60 });
  // Setup-shaped pair combos want to LEAD; pure damage cores less reliably so.
  const leady = new Set(['perish-trap', 'trick-room', 'tailwind', 'weather', 'terrain', 'redirection', 'fake-out-setup', 'aurora-veil', 'baton-pass', 'beat-up-justified', 'crit-anger-point']);
  for (const t of tactics) {
    if (t.pieces.length !== 2 || !leady.has(t.pattern)) continue;
    const [a, b] = t.pieces;
    if (a!.species === b!.species) continue;
    return { species: [a!.species, b!.species], tactic: t };
  }
  return null;
}

/** The speed a counter has to beat for this tactic — the fastest piece, read at
 *  its MEGA forme where one exists, because that is the forme that moves. A
 *  Gengar that will become Gengar-Mega must be raced at 130 base, not 110. */
function threatSpeedFor(t: TacticInstance, opponent: OpponentEntry[], level: number): number | undefined {
  const names = new Set(t.pieces.map(p => p.species));
  let best: number | undefined;
  for (const o of opponent) {
    if (!names.has(o.species)) continue;
    for (const name of [o.species, ...getMegaOptions(o.species).map(m => m.forme)]) {
      const sp = getSpecies(name);
      if (!sp) continue;
      // Assume the threat is invested in speed — a slow perish singer is not the
      // one that beats you, and under-estimating here loses the whole point.
      const v = Math.floor((Math.floor(((2 * (sp.baseStats?.spe ?? 70) + 31 + 63) * level) / 100) + 5) * 1.1);
      if (best == null || v > best) best = v;
    }
  }
  return best;
}

/** Can the opponent's six take a turn away from one of my mons? Fake Out is the
 *  clean case; a flinch or a Prankster Taunt does the same job. If they can, a
 *  single answer to anything is fragile by construction. */
function oppCanDenyATurn(opponent: OpponentEntry[]): boolean {
  return opponent.some(o => {
    const learn = (o.knownMoves ?? []).map(m => toId(m));
    if (learn.includes('fakeout') || learn.includes('taunt')) return true;
    // Nothing revealed yet: fall back to whether the SPECIES is a known Fake Out
    // user, since at preview that is all we have.
    return FAKE_OUT_SPECIES.has(toId(o.species));
  });
}

/** Common Fake Out carriers — used only when no moves have been revealed. */
const FAKE_OUT_SPECIES: ReadonlySet<string> = new Set([
  'incineroar', 'rillaboom', 'hitmontop', 'meowscarada', 'blastoise', 'mienshao',
  'kangaskhan', 'ambipom', 'weavile', 'sneasler', 'infernape', 'lucario', 'scrafty',
]);

export interface LeadAdvice {
  lead: string[];
  hold: string[];
  /** One line per rule that fired, most important first. */
  reasons: string[];
}

/** Can this set walk away from trouble on its own terms? Pivot moves, Ghost
 *  typing and Shed Shell all mean "the field is not a cage for me". */
function isResilient(s: PokemonSet): boolean {
  return s.moves.some(isPivotMove)
    || speciesTypes(s.species).includes('Ghost')
    || toId(s.item ?? '') === 'shedshell';
}
/** Can this set refuse a turn being taken from it, or refuse a setup? */
function isDenier(s: PokemonSet): boolean {
  return abilityIs(s, 'soundproof') || abilityIs(s, 'innerfocus') || abilityIs(s, 'shielddust')
    || toId(s.item ?? '') === 'covertcloak' || hasMove(s, 'taunt');
}

/**
 * WHICH TWO OF THE FOUR TO LEAD.
 *
 * Deliberately generic: it reads the opponent's detected tactics through the same
 * PATTERN_COUNTERS table the bring score uses, so every threat is treated alike and
 * no single matchup is special-cased. The perish trap that prompted it is just the
 * case that exposed the rule.
 *
 * Three rules, in order:
 *   1. HOLD A SOLE ANSWER. If a mon is the only thing in the bring that answers some
 *      threat, and the opponent can take a turn away (Fake Out, Prankster Taunt),
 *      leading it aims that denial at exactly the mon you cannot afford to lose.
 *      This is the 2026-07-28 loss in one sentence.
 *   2. LEAD A DENIER. Something that refuses the denial outright (Inner Focus,
 *      Covert Cloak, Soundproof, Taunt) is the best thing to have on the field.
 *   3. ELSE LEAD A RESILIENT MON. One that can leave (pivot / Ghost / Shed Shell)
 *      takes the hit that lands on turn 1 and walks away from it, and its pivot is
 *      how the held-back answer arrives clean.
 *
 * Returns null when nothing applies — no detected threat, or they cannot deny a
 * turn, in which case lead normally and let your best mon do its job on turn 1.
 */
export function leadAdvice(bring: PokemonSet[], opponent: OpponentEntry[]): LeadAdvice | null {
  if (bring.length < 2) return null;
  const level = bring[0]?.level ?? 50;
  const threats = detectTactics(opponent.map(o => profileFromSpecies(o.species)), { minScore: 60 });
  if (!threats.length) return null;
  if (!oppCanDenyATurn(opponent)) return null;

  // For each threat, who in this bring answers it?
  const soleAnswerFor = new Map<PokemonSet, string[]>();
  const answersSomething = new Set<PokemonSet>();
  for (const t of threats) {
    const counter = PATTERN_COUNTERS[t.pattern];
    if (!counter) continue;
    const ctx: CounterCtx = { threatSpeed: threatSpeedFor(t, opponent, level) };
    const answers = bring.filter(s => counter(s, ctx));
    for (const a of answers) answersSomething.add(a);
    if (answers.length !== 1) continue;                 // 0 = no answer, 2+ = redundant
    const only = answers[0]!;
    // detectTactics can return several instances of the same pattern (different
    // piece pairs); name them once or the reason reads "X and X and X".
    const named = soleAnswerFor.get(only) ?? [];
    if (!named.includes(t.name)) named.push(t.name);
    soleAnswerFor.set(only, named);
  }

  const reasons: string[] = [];
  const holdBack = [...soleAnswerFor.keys()].filter(s => !isDenier(s) && !isResilient(s));
  for (const s of holdBack) {
    reasons.push(`Hold ${s.species} back — it is your ONLY answer to ${soleAnswerFor.get(s)!.join(' and ')}, ` +
      `and they can take a turn away from it (Fake Out / Taunt). Leading it aims that denial at exactly the mon you cannot lose.`);
  }

  const candidates = bring.filter(s => !holdBack.includes(s));
  if (candidates.length < 2) return null;               // holding everything is not advice

  // Prefer to lead mons that can absorb the opener: a denier refuses it, a resilient
  // mon walks away from it. And keep ANSWERS off the field where a denial can blank
  // them — an answer that cannot leave is worth more held back than led, even when it
  // is not the only one. This is the generalisation of "do not lead your Scarf into a
  // Fake Out": nothing about it is specific to perish or to speed.
  const rank = (s: PokemonSet) =>
    (isDenier(s) ? 2 : 0) + (isResilient(s) ? 1 : 0) - (answersSomething.has(s) && !isResilient(s) ? 1 : 0);
  const ordered = [...candidates].sort((a, b) => rank(b) - rank(a));
  const lead = ordered.slice(0, 2);
  if (!lead.some(s => rank(s) > 0) && !holdBack.length) return null;   // nothing to say

  for (const s of lead) {
    if (isDenier(s)) {
      reasons.push(`Lead ${s.species} — it refuses the denial itself (${hasMove(s, 'taunt') ? 'Taunt' : s.ability ?? 'its ability'}), so their opener does nothing.`);
    } else if (isResilient(s)) {
      const how = s.moves.find(isPivotMove) ?? (toId(s.item ?? '') === 'shedshell' ? 'Shed Shell' : 'Ghost typing');
      reasons.push(`Lead ${s.species} — it can leave (${how}), so whatever lands on turn 1 does not stick` +
        (holdBack.length ? `, and it is how ${holdBack[0]!.species} arrives clean once the opener is spent.` : '.'));
    } else if (!answersSomething.has(s)) {
      reasons.push(`Lead ${s.species} — it answers none of their combos, so it is the cheapest thing to expose to the opener.`);
    }
  }
  if (!reasons.length) return null;
  return {
    lead: lead.map(s => s.species),
    hold: bring.filter(s => !lead.includes(s)).map(s => s.species),
    reasons,
  };
}

function comb4(n: number): number[][] {
  const out: number[][] = [];
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++)
    for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++)
      out.push([a, b, c, d]);
  return out;
}

/** Tunable weights for the bring score. Calibrated against the exhaustive-best
 *  bring (`mb-bring-analysis` → `mb-calibrate-brings`) so the fast live heuristic
 *  approximates what full simulation would pick. */
export interface BringWeights {
  offense: number; defense: number; speed: number; matchup: number;
  speedControl: number; redirection: number; tactics: number; threat: number;
  fairyPrankster: number;
}
export const DEFAULT_BRING_WEIGHTS: BringWeights = {
  // defense doubled (0.3->0.6) + offense 0.4->0.6: calibrated against the playout
  // ground truth (calibrate-bring) — up-weighting survival is the proven fix for
  // the heuristic under-valuing bulky supports vs frail attackers (regret 11%->7%
  // across the 17-opponent gauntlet, no meta regression).
  offense: 0.6, defense: 0.6, speed: 5, matchup: 8,
  speedControl: 30, redirection: 20, tactics: 0.35, threat: 12,
  // vs a Fairy-spam team (>=2 Fairies), bringing a Prankster support is the
  // SIM-VALIDATED answer the per-pair heuristic can't see (it over-values frail
  // paper-offense, ignores screens/debuffs/bulk). Big enough to clear the ~130
  // offense edge a frail attacker bring otherwise wins by. Scoped to Fairy teams,
  // so it never fires elsewhere. See project_mb_team / bring-search.
  fairyPrankster: 150,
};

export function scoreBrings(myTeam: PokemonSet[], opponent: OpponentEntry[], field: FieldState = NEUTRAL_FIELD, w: BringWeights = DEFAULT_BRING_WEIGHTS): BringScore[] {
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
  // Fairy-spam detection: a Prankster support (screens/debuffs/WoW) is the
  // sim-validated answer when the opponent fields multiple Fairies (Moonblast
  // shreds Dragon-heavy brings). Only fires when we actually have such a support.
  const oppFairyCount = opponentSets.filter(o => speciesTypes(o.species).includes('Fairy')).length;
  const teamHasPranksterSupport = myTeam.some(s => s.ability === 'Prankster');

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
      if (hasIt) { roles += w.speedControl; rationale.push('Includes speed control'); }
      else rationale.push('Missing speed control (team has one available)');
    }
    if (teamHasRedirection) {
      const hasIt = indices.some(i => hasRole(myTeam[i]!, 'redirection'));
      if (hasIt) { roles += w.redirection; rationale.push('Includes redirection'); }
    }
    if (oppFairyCount >= 2 && teamHasPranksterSupport) {
      const hasIt = indices.some(i => myTeam[i]!.ability === 'Prankster');
      if (hasIt) { roles += w.fairyPrankster; rationale.push(`Prankster support vs ${oppFairyCount} Fairies (sim-validated default)`); }
      else rationale.push(`⚠ No Prankster support vs ${oppFairyCount} Fairies — sim prefers one`);
    }
    // Synergy: best instance per pattern fully inside this bring, top 3.
    const bringSpecies = new Set(indices.map(i => myTeam[i]!.species));
    const combos = bestPerPatternWithin(myTactics, bringSpecies).slice(0, 3);
    const tactics = Math.round(combos.reduce((s, t) => s + t.score * w.tactics, 0));
    for (const t of combos) rationale.push(`Combo: ${t.name} — ${tacticLabel(t)}`);
    // Threats: ±12 per strong opponent combo depending on whether the bring
    // packs a counter for it.
    let threats = 0;
    for (const t of oppThreats) {
      const counter = PATTERN_COUNTERS[t.pattern];
      const ctx: CounterCtx = { threatSpeed: threatSpeedFor(t, opponent, level) };
      const answers = counter ? indices.filter(i => counter(myTeam[i]!, ctx)) : [];
      const covered = answers.length > 0;
      // REDUNDANCY. Coverage used to be binary — one answer scored the same as
      // four. The live 2026-07-28 loss is exactly the failure that hides: the
      // bring had a single answer (Scarf Garchomp) and their Blastoise Fake Out
      // switched it off for the one turn that mattered. When the opponent can
      // deny a mon's turn, a lone answer is not an answer.
      const denial = oppCanDenyATurn(opponent);
      const thin = covered && answers.length === 1 && denial;
      threats += thin ? 0 : covered ? w.threat : -w.threat;
      const names = answers.map(i => myTeam[i]!.species).join('/');
      rationale.push(
        thin ? `⚠ ONLY ONE answer to opp ${t.name} (${names}) — they carry Fake Out/priority denial, so it can be blanked for the turn that matters`
        : covered ? `Covers opp ${t.name} (${names}): ${tacticLabel(t)}`
        : `⚠ No answer to opp ${t.name}: ${tacticLabel(t)}`);
    }
    const total = offense * w.offense + defense * w.defense + speed * w.speed + roles + matchup * w.matchup + tactics + threats;
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
