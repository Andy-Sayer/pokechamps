/**
 * endgameSearch.ts — bounded, depth-limited lookahead for Pokémon doubles.
 *
 * This is the engine behind the always-on background recommender (see
 * docs/notes/endgame-search-plan.md). Unlike the 1-ply `endgame.ts`, it plays
 * the position forward several turns and reasons about turn ORDER (KO-first
 * avoids retaliation) and focus-fire vs spread.
 *
 * Design choices that keep it fast enough to run continuously:
 *   - Damage % is independent of a defender's current HP, so we precompute the
 *     full my×opp and opp×my representative-damage matrices ONCE at the root
 *     (one predictOffense / predictThreat per pair). The tree search itself is
 *     then pure arithmetic on HP totals + a speed sort — no predictor calls.
 *   - Each active's "options" are reduced to "best move vs each live foe" (one
 *     per target), so a side has at most 2×2 = 4 joint actions. Spread moves,
 *     status, and voluntary switches are out of scope for v1.
 *   - Maximin: I maximise, the opponent replies worst-case-for-me. Transparent
 *     and consistent with endgame.ts; not an exact simultaneous-move
 *     equilibrium. Alpha-beta-style pruning on the inner min.
 *   - Damage collapses to a single representative value (likely-mid %); ranges
 *     are a display concept, not searched.
 *
 * All exports are PURE — no I/O, no mutation of inputs.
 */
import type { PokemonSet, OpponentEntry, FieldState, Match, HazardState } from './types.js';
import { ZERO_EVS, MAX_IVS } from './types.js';
import { predictOffense, predictThreat, pikalyticsMoves } from './predictions.js';
import { representativeSpreadIndices } from './inference.js';
import { actualSpeed, actualStat, effectiveSpeedRange } from './speed.js';
import { getMove, getSpecies, getNature, toId, isSpreadMove, moveFlinchChance } from './data.js';
import { getMegaOptions } from './gimmicks/mega.js';
import { defaultOpponentSet } from './bring.js';
import { maxHpFor } from './damage.js';
import { getPikalytics } from './pikalytics.js';
import { hpItemTriggerFor, isHpItemTriggerItem } from './hpItemTriggers.js';
import { statusBerryFor, isStatusBerry } from './statusBerries.js';
import { applyHazardsToSwitchIn, type HazardEffect } from './hazards.js';
import { unmodeledMechanics, type UnmodeledMechanic } from './unmodeled.js';
import { effectiveness } from './typechart.js';
import { firstTurnOut } from './itemSignals.js';
import { foeDropOf, statDropImmune, defiantStat } from './abilities.js';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Chance (0..1) a mon survives one lethal-from-full hit (Focus Sash / Sturdy),
 *  plus a short label for risk display. */
export interface Survival { prob: number; label: string }

export interface SearchMyMon {
  set: PokemonSet;
  /** Remaining HP, 0–100% of max. */
  hpPercent: number;
  /** True if this mon is currently on the field. Up to 2 of mine are active. */
  active: boolean;
  /** Already mega-evolved this battle → use its mega stats unconditionally. */
  megaActive?: boolean;
  /** Live stat-stage boosts on this active (cleared on switch-out). Feeds the
   *  damage calc AND the Spe stage into turn order. */
  boosts?: Partial<Record<string, number>>;
  /** Non-volatile status (burn halves physical damage, paralysis halves speed). */
  status?: string;
  /** Focus Sash / Sturdy survival (my items are known, so prob is 0 or 1). */
  survival?: Survival;
  /** Already under Leech Seed — the OPP search-index of the seeder (heals it). */
  seededBy?: number;
  /** True if this mon is on its FIRST turn out (just switched in / battle start) —
   *  gates Fake Out's guaranteed flinch. Threaded from the live match's tracking. */
  firstTurnOut?: boolean;
  /** Substitute HP remaining (% of max), if this mon is behind a sub. */
  subHpPercent?: number;
}
export interface SearchOppMon {
  entry: OpponentEntry;
  hpPercent: number;
  active: boolean;
  /** Already mega-evolved → entry.candidates already carry the mega forme. */
  megaActive?: boolean;
  boosts?: Partial<Record<string, number>>;
  status?: string;
  /** Focus Sash / Sturdy survival — probabilistic (from inference or usage %). */
  survival?: Survival;
  /** A KNOWN-but-not-yet-brought mon, folded in so the opponent can switch it in
   *  at the root. It is NOT counted as material until actually switched in. */
  phantom?: boolean;
  /** Already under Leech Seed — the MY search-index of the seeder (heals it). */
  seededBy?: number;
  /** On its first turn out (gates Fake Out's flinch). */
  firstTurnOut?: boolean;
  /** Substitute HP remaining (% of max), if this mon is behind a sub. */
  subHpPercent?: number;
}
export interface SearchInput {
  mine: SearchMyMon[];
  opp: SearchOppMon[];
  field: FieldState;
  /** This side has already used its (once-per-battle) mega — no hypothetical
   *  mega branch should be offered for it. */
  myMegaSpent?: boolean;
  oppMegaSpent?: boolean;
  /** True once all of the opponent's brought Pokémon (4 in VGC) are revealed.
   *  Until then we can never claim a forced WIN — KOing the visible mons isn't
   *  winning the game. */
  allOppRevealed?: boolean;
  /** Opponent's KNOWN-but-not-yet-brought mons (seen at preview). The search
   *  doesn't model switches, but we surface the scariest as a concrete risk. */
  oppBench?: OpponentEntry[];
}

export interface SearchPlay {
  mySpecies: string;
  move: string;
  targetSpecies: string;
  /** True when `move` is a spread move hitting all live foes at once. */
  spread?: boolean;
  /** True when `move` targets the user itself (e.g. Protect). Display omits target. */
  self?: boolean;
  /** True when this play is a voluntary switch; `targetSpecies` is the incoming mon. */
  switch?: boolean;
}
/** A named uncertainty that affects the outcome, with its probability. */
export interface SearchRisk {
  /** Human label, e.g. "Aerodactyl Focus Sash" or "Heat Wave low roll vs Abomasnow". */
  label: string;
  /** Probability (0..1) the BAD-for-me resolution happens. Omitted for caveats
   *  with no meaningful number (e.g. unrevealed bench). */
  prob?: number;
  /** Short effect note, e.g. "survives a lethal hit". */
  effect: string;
  /** True if this uncertainty, resolved against me, flips the expected verdict. */
  blocking: boolean;
}

/** A scope-derived note explaining a pivotal assumption behind the verdict
 *  (e.g. a contingent-speed outspeed). `prob`, when present, is the chance the
 *  assumption holds AGAINST me (so the user can weigh it). */
export interface SearchAssumption {
  text: string;
  prob?: number;
}

/** A concrete damage cutpoint that flips the verdict for one exchange — stated
 *  as an observation the user can check against the real roll this turn. */
export interface SearchBreakpoint {
  /** The mon the threshold is read against (my mon for 'survive', the foe for 'ko'). */
  subject: string;
  /** The move whose damage we're thresholding. */
  move: string;
  /** 'survive' — "if their hit does < thresholdHp we live"; 'ko' — "we OHKO
   *  unless it invested enough bulk to push its effective HP past thresholdHp". */
  direction: 'survive' | 'ko';
  /** The HP% cutpoint (of the subject's max) that flips the outcome. */
  thresholdHp: number;
  /** What happens on the good-for-me side of the cutpoint. */
  thenNote: string;
  /** Short note on the spread investment behind the bad side, if known. */
  spreadNote?: string;
  /** Probability (0..1) the good-for-me side actually occurs, from pooled rolls. */
  prob?: number;
}

/** Honest, scope-derived report of how much the search actually explored. The
 *  `actionClasses` list is generated from the action kinds REALLY in the tree,
 *  so the breadth wording never overclaims (no "switches" until they're nodes). */
export interface SearchExplored {
  depth: number;
  /** My joint actions enumerated at the root this turn. */
  myActions: number;
  /** The opponent's joint replies enumerated at the root. */
  oppActions: number;
  /** Largest number of candidate opp spreads pooled behind any damage cell. */
  spreads: number;
  /** Damage-matrix combos built (mega plans per side multiplied). */
  megaBranches: number;
  /** Roll/survival regimes evaluated (expected + pessimistic + optimistic). */
  regimes: number;
  /** Action kinds present in the tree: 'attack' | 'spread' | 'protect' |
   *  'switch' | 'tailwind' | 'trickroom' | 'leech' | 'setup' | 'batonpass' |
   *  'speedboost' | 'screen' | 'weather' | 'terrain' | 'status' | 'recover' |
   *  'hazard'. Drives the breadth wording. */
  actionClasses: string[];
}

/** A single lucky event that could flip a losing position. */
export interface HailMaryOut {
  /** Human label, e.g. "Aerodactyl KO needs top roll" */
  label: string;
  /** Probability (0..1) this event fires. */
  prob: number;
}

/** Analysis surfaced only when verdict === 'losing' && !forced && a winning
 *  path exists under optimistic conditions. */
export interface HailMary {
  /** The optimal play under the optimistic regime — what to do to chase the out. */
  plays: SearchPlay[];
  /** Lucky events required for the optimistic line to close. */
  outs: HailMaryOut[];
  /** Approximate combined probability all outs fire simultaneously. */
  combined: number;
  /** True when combined < 0.005 — no realistic path to win. */
  noRealisticOut: boolean;
}

export interface SearchResult {
  /** How many plies deep this result was computed to. */
  depth: number;
  /** Maximin value of the position (higher = better for me). */
  score: number;
  /** Recommended move for each of my live actives this turn (best joint action). */
  plays: SearchPlay[];
  verdict: 'winning' | 'even' | 'losing';
  /** Species I should Mega-Evolve this turn for the best line, if any. */
  megaMon?: string;
  /** True only when the outcome is GUARANTEED: it holds under worst-case rolls,
   *  modelled survival items, and worst-case opp mega/speed — and (for a win)
   *  all brought opp mons are revealed. */
  forced: boolean;
  /** Approximate probability I achieve the expected-pass outcome, ∏(1−p) over
   *  blocking risks. Undefined when not computable. */
  winChance?: number;
  /** Whether all brought opp mons are known (gates a forced win). */
  allOppRevealed: boolean;
  /** Named uncertainties (survival items, swing rolls, unrevealed bench). */
  risks: SearchRisk[];
  /** The opponent's minimizing reply to my recommended joint — "how they beat
   *  us". Populated whenever an opp reply exists (most useful when losing). */
  oppLine?: SearchPlay[];
  /** "1D chess" — the opponent's FLAT, obvious greedy play per active (max-damage,
   *  or the obvious disruption: a priority KO / turn-1 Fake Out / Protect-when-
   *  doomed), independent of my move. A heuristic intent read, NOT the maximin. */
  obviousOppPlay?: SearchPlay[];
  /** Pivotal assumptions behind the verdict (contingent speed, etc.). */
  assumptions?: SearchAssumption[];
  /** Concrete damage cutpoints that flip the verdict this turn. */
  breakpoints?: SearchBreakpoint[];
  /** Honest breadth-of-search report for the confidence chip. */
  explored?: SearchExplored;
  /** Restriction breadth this pass ran at (Step C widening). `full` is true for an
   *  un-restricted pass (default knobs); a restricted pass is a fast, TENTATIVE
   *  deep read and can never claim `forced`. */
  breadth?: { spreadK: number; switchPlyLimit: number; full: boolean };
  /** True when the opponent's spread/item has been refined from observed damage
   *  (inference produced candidates) — surfaced so the user knows the read is
   *  data-driven, not a prior. */
  adapted?: boolean;
  /** Dice-roll outs analysis — only present when verdict === 'losing' && !forced
   *  and the optimistic regime finds a winning path. */
  hailMary?: HailMary;
  /** Mechanics in THIS position that the fast search only approximates (sleep,
   *  redirection, two-turn moves, …). Surfaced so the user knows the verdict has
   *  blind spots here and can opt into the exact `@pkmn/sim` engine. Omitted when
   *  the position is fully within the model. */
  unmodeled?: UnmodeledMechanic[];
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const WIN = 100_000;          // terminal magnitude; faster wins score higher
const MATERIAL = 1_000;       // per-mon material weight (dominates HP)
const MAX_ACTIVE = 2;
// Non-attack target sentinels (vs a foe index ≥ 0). Small negatives are single
// actions; switches occupy a separate range below SWITCH_BASE so a benched-index
// encoding never collides with them.
const SPREAD = -1;        // spread move — hit every live foe
const PROTECT = -2;       // Protect/Detect/etc. on self
const SET_TAILWIND = -3;  // set Tailwind (order field move; no damage)
const SET_TRICKROOM = -4; // set/flip Trick Room (order field move; no damage)
const SET_BOOST = -5;     // setup move (Calm Mind / Swords Dance …) — self-boost
const SET_SCREEN = -6;    // screen move (Reflect / Light Screen / Aurora Veil)
const SET_WEATHER = -7;   // weather move (Sunny Day / Rain Dance / …)
const SET_TERRAIN = -8;   // terrain move (Electric / Grassy / Misty / Psychic)
const RECOVER = -9;       // recovery move (Recover / Roost / Synthesis / …) — self-heal
const SET_HAZARD = -10;   // dedicated hazard move (Stealth Rock / Spikes / …) — sets on the FOE's side
const REDIRECT = -11;     // Follow Me / Rage Powder — pull the foes' single-target moves onto self
const SLEEP_SKIP = -12;   // forced no-op for an asleep mon (can't act this turn)
const HELP_HAND = -13;    // Helping Hand (+5) — the ally's move deals ×1.5 this turn
const WIDE_GUARD = -14;   // Wide Guard (+3) — blocks the foes' SPREAD moves this turn (whole side)
const QUICK_GUARD = -15;  // Quick Guard (+3) — blocks the foes' PRIORITY moves this turn (whole side)
const SAP = -16;          // Strength Sap — heal by the (highest-Atk) foe's Attack stat + drop its Atk −1
const CLEAR_HAZARD = -17; // Rapid Spin / Defog / Court Change / Tidy Up — remove entry hazards
const SET_SUB = -18;      // Substitute — pay 25% HP to put up a damage-absorbing sub
const COUNTER = -19;      // Counter / Mirror Coat / Metal Burst — reflect damage taken this turn
const SET_ROOM = -20;     // Gravity / Wonder Room / Magic Room — set a field room (5 turns)
// Ranged sentinel blocks that each carry an index, kept disjoint so a code is
// unambiguous. Switches: [-29,-20] → bench idx. Leech Seed: [-39,-30] → foe idx.
// Baton Pass: [-49,-40] → bench idx (switch that passes boosts). Status: ≤ -50 →
// foe idx. All ROOT-ply only. Bases sit 10 below the singles so a benched-index
// encoding never collides with a single-action sentinel.
const SWITCH_BASE = -20;  // switch → bench idx `SWITCH_BASE - target`
const LEECH_BASE = -30;   // Leech Seed → foe idx `LEECH_BASE - target`
const BATON_BASE = -40;   // Baton Pass → bench idx `BATON_BASE - target`
const STATUS_BASE = -50;  // status move → foe idx `STATUS_BASE - target`
const PIVOT_BASE = -60;   // pivot move (U-turn/…) → foe idx; user auto-switches out
const DEBUFF_BASE = -70;  // dedicated stat-lowering move (Charm/Scary Face/…) → foe idx
const TAUNT_BASE = -80;   // Taunt → foe idx (foe can't use status moves for a few turns)
const ENCORE_BASE = -90;  // Encore → foe idx (foe locked into its last move)
const FAKEOUT_BASE = -100; // Fake Out → foe idx (chip + guaranteed flinch, first turn out only)
const PRIO_BASE = -110;   // priority attack (Sucker Punch/Grassy Glide/Aqua Jet/…) → foe idx
function isSwitchTarget(t: number): boolean { return t <= SWITCH_BASE && t > LEECH_BASE; }
function switchBenchIdx(t: number): number { return SWITCH_BASE - t; }
function switchCode(benchIdx: number): number { return SWITCH_BASE - benchIdx; }
function isLeechTarget(t: number): boolean { return t <= LEECH_BASE && t > BATON_BASE; }
function leechFoeIdx(t: number): number { return LEECH_BASE - t; }
function leechCode(foeIdx: number): number { return LEECH_BASE - foeIdx; }
function isBatonTarget(t: number): boolean { return t <= BATON_BASE && t > STATUS_BASE; }
function batonBenchIdx(t: number): number { return BATON_BASE - t; }
function batonCode(benchIdx: number): number { return BATON_BASE - benchIdx; }
function isStatusTarget(t: number): boolean { return t <= STATUS_BASE && t > PIVOT_BASE; }
function statusFoeIdx(t: number): number { return STATUS_BASE - t; }
function statusCode(foeIdx: number): number { return STATUS_BASE - foeIdx; }
function isPivotTarget(t: number): boolean { return t <= PIVOT_BASE && t > DEBUFF_BASE; }
function pivotFoeIdx(t: number): number { return PIVOT_BASE - t; }
function pivotCode(foeIdx: number): number { return PIVOT_BASE - foeIdx; }
function isDebuffTarget(t: number): boolean { return t <= DEBUFF_BASE && t > TAUNT_BASE; }
function debuffFoeIdx(t: number): number { return DEBUFF_BASE - t; }
function debuffCode(foeIdx: number): number { return DEBUFF_BASE - foeIdx; }
function isTauntTarget(t: number): boolean { return t <= TAUNT_BASE && t > ENCORE_BASE; }
function tauntFoeIdx(t: number): number { return TAUNT_BASE - t; }
function tauntCode(foeIdx: number): number { return TAUNT_BASE - foeIdx; }
function isEncoreTarget(t: number): boolean { return t <= ENCORE_BASE && t > FAKEOUT_BASE; }
function encoreFoeIdx(t: number): number { return ENCORE_BASE - t; }
function encoreCode(foeIdx: number): number { return ENCORE_BASE - foeIdx; }
function isFakeOutTarget(t: number): boolean { return t <= FAKEOUT_BASE && t > PRIO_BASE; }
function fakeOutFoeIdx(t: number): number { return FAKEOUT_BASE - t; }
function fakeOutCode(foeIdx: number): number { return FAKEOUT_BASE - foeIdx; }
function isPrioTarget(t: number): boolean { return t <= PRIO_BASE && t > PRIO_BASE - 10; }
function prioFoeIdx(t: number): number { return PRIO_BASE - t; }
function prioCode(foeIdx: number): number { return PRIO_BASE - foeIdx; }
function isFieldTarget(t: number): boolean { return t === SET_TAILWIND || t === SET_TRICKROOM; }
// Benched live team-indices a side can switch INTO (not on the field, hp > 0).
function benchSwitchTargets(active: number[], hp: number[], n: number): number[] {
  const onField = new Set(active);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if ((hp[i] ?? 0) > 0 && !onField.has(i)) out.push(i);
  return out;
}

// ---------------------------------------------------------------------------
// Internal flat model (indices into precomputed arrays)
// ---------------------------------------------------------------------------

// Damage as % of target max, at three roll points so the tree can be evaluated
// under different regimes without rebuilding the (expensive) matrix. Roll risk
// is derived from the dmgMin..dmgMax envelope vs the target's HP at use time.
interface Cell { dmgMin: number; dmgMid: number; dmgMax: number; move: string; priority: number; multiHit: boolean; koRolls: number[]; candidates: number; physical: boolean; type: string; groundMove: boolean; drain: number; contact: boolean; recoil: number; setsHazard: HazardKind | null; selfDrop: BoostMap | null; foeDrop: BoostMap | null }

/** A spread move option for one of my mons: the move plus its (already
 *  spread-reduced) damage vs each opp index, at min/mid/max rolls. */
interface SpreadOpt { move: string; priority: number; dmgMin: number[]; dmgMid: number[]; dmgMax: number[]; physical: boolean; type: string; groundMove: boolean; selfDrop: BoostMap | null; foeDrop: BoostMap | null }

/** Live stat-stage boosts (−6..+6) per stat. */
type BoostMap = Partial<Record<'atk' | 'def' | 'spa' | 'spd' | 'spe', number>>;

// True for a physical move (uses Atk/Def); false = special (SpA/SpD). Status
// moves are physical=false but never deal damage so it's moot.
function isPhysicalMove(move: string): boolean {
  return ((getMove(move) as { category?: string } | undefined)?.category) === 'Physical';
}
function moveType(move: string): string {
  return ((getMove(move) as { type?: string } | undefined)?.type) ?? '';
}
// HP-draining fraction of a move (Giga Drain/Drain Punch 0.5, Draining Kiss 0.75),
// or 0. `drain` in the dex is [num, den].
function moveDrain(move: string): number {
  const d = (getMove(move) as { drain?: [number, number] } | undefined)?.drain;
  return d ? d[0] / d[1] : 0;
}
// True for a contact move (triggers Rocky Helmet / Rough Skin / Iron Barbs).
function moveContact(move: string): boolean {
  return !!(getMove(move) as { flags?: { contact?: number } } | undefined)?.flags?.contact;
}
// Recoil fraction of DAMAGE DEALT the attacker takes (Brave Bird/Flare Blitz/Wave
// Crash 33%, Head Smash 50%, Take Down 25%). `recoil` in the dex is [num, den].
// Rock Head and Magic Guard negate it (checked at apply time).
function moveRecoil(move: string): number {
  const r = (getMove(move) as { recoil?: [number, number] } | undefined)?.recoil;
  return r ? r[0] / r[1] : 0;
}
function hasRockHead(ability: string | null | undefined): boolean {
  return toId(ability ?? '') === 'rockhead';
}
// True if a mon takes Life Orb recoil (10% max HP) when it lands a damaging move:
// holds Life Orb, and not negated by Magic Guard / Sheer Force.
function takesLifeOrbRecoil(item: string | null | undefined, ability: string | null | undefined): boolean {
  if (!/life\s*orb/i.test(item ?? '')) return false;
  const a = toId(ability ?? '');
  return a !== 'magicguard' && a !== 'sheerforce';
}
// Guaranteed self-stat-drop a damaging move inflicts on its OWN user (Draco
// Meteor/Overheat/Leaf Storm/Fleur Cannon −2 SpA, Make It Rain −1 SpA, Close
// Combat/Superpower −Def/−SpD, V-create, Spin Out…). Reads `move.self.boosts`;
// null if none. Only the stat stages we track (no acc/eva).
function selfDropOf(move: string): BoostMap | null {
  const b = (getMove(move) as { self?: { boosts?: Record<string, number> } } | undefined)?.self?.boosts;
  if (!b) return null;
  const out: BoostMap = {};
  for (const k of ['atk', 'def', 'spa', 'spd', 'spe'] as const) if (b[k]) out[k] = b[k]!;
  return Object.keys(out).length ? out : null;
}
// Contrary inverts stat changes (a self-drop becomes a self-boost).
function hasContrary(ability: string | null | undefined): boolean {
  return toId(ability ?? '') === 'contrary';
}
function negateBoosts(b: BoostMap): BoostMap {
  const out: BoostMap = {};
  for (const k of ['atk', 'def', 'spa', 'spd', 'spe'] as const) if (b[k]) out[k] = -b[k]!;
  return out;
}
// foeDropOf / statDropImmune / defiantStat now live in abilities.ts (shared with the
// live engine's finalizeTurn so the search + live layers can't drift). Imported above.

// L50 / 31-IV stat value (same formula as actualSpeed), for Beast Boost's
// highest-stat pick. Nature multiplier applied per stat.
function statAt50(set: PokemonSet, key: 'atk' | 'def' | 'spa' | 'spd' | 'spe'): number {
  const base = (getSpecies(set.species) as { baseStats?: Record<string, number> } | undefined)?.baseStats?.[key] ?? 0;
  const ev = (set.evs as Record<string, number>)[key] ?? 0;
  const raw = Math.floor(((2 * base + 31 + Math.floor(ev / 4)) * 50) / 100) + 5;
  const nat = getNature(set.nature) as { plus?: string; minus?: string } | undefined;
  const mult = nat?.plus === key ? 1.1 : nat?.minus === key ? 0.9 : 1.0;
  return Math.floor(raw * mult);
}
function highestStat(set: PokemonSet): 'atk' | 'def' | 'spa' | 'spd' | 'spe' {
  let best: 'atk' | 'def' | 'spa' | 'spd' | 'spe' = 'atk', bestV = -1;
  for (const k of ['atk', 'def', 'spa', 'spd', 'spe'] as const) { const v = statAt50(set, k); if (v > bestV) { bestV = v; best = k; } }
  return best;
}
// The +1 stat boost a mon gains when it KOes a foe: Moxie/Chilling Neigh/As One-G
// → Atk, Grim Neigh/As One-S → SpA, Beast Boost → the mon's highest stat. null else.
function onKoBoost(set: PokemonSet, ability: string | null | undefined): BoostMap | null {
  switch (toId(ability ?? '')) {
    case 'moxie': case 'chillingneigh': case 'asoneglastrier': return { atk: 1 };
    case 'grimneigh': case 'asonespectrier': return { spa: 1 };
    case 'beastboost': return { [highestStat(set)]: 1 };
    default: return null;
  }
}
// Scale a boost map by an integer (n KOs → n× the on-KO boost, e.g. a spread that
// KOes two foes gives Moxie +2).
function scaleBoosts(b: BoostMap, n: number): BoostMap {
  const out: BoostMap = {};
  for (const k of ['atk', 'def', 'spa', 'spd', 'spe'] as const) if (b[k]) out[k] = b[k]! * n;
  return out;
}
// Ground moves halved by Grassy Terrain.
const GRASSY_HALVED = new Set(['earthquake', 'bulldoze', 'magnitude']);
function isGroundMove(move: string): boolean { return GRASSY_HALVED.has(toId(move)); }

// --- Entry hazards (setting) ------------------------------------------------
/** The four entry-hazard side conditions. Keys match HazardState fields. */
type HazardKind = 'rocks' | 'spikes' | 'toxicspikes' | 'stickyweb';
// Damaging moves that ALSO lay a hazard on the target's side as a (near-)100%
// secondary. Our @pkmn/dex dump flattens the secondary, so we key by name.
const HAZARD_SECONDARY: Record<string, HazardKind> = { stoneaxe: 'rocks', ceaselessedge: 'spikes' };
function hazardSecondaryOf(move: string): HazardKind | null { return HAZARD_SECONDARY[toId(move)] ?? null; }
// Dedicated hazard-setting STATUS moves → the hazard they put on the foe's side.
const HAZARD_MOVES: Record<string, HazardKind> = { stealthrock: 'rocks', spikes: 'spikes', toxicspikes: 'toxicspikes', stickyweb: 'stickyweb' };
function findHazardMove(moves: string[]): { move: string; hazard: HazardKind } | null {
  for (const m of moves) { const h = HAZARD_MOVES[toId(m)]; if (h) return { move: m, hazard: h }; }
  return null;
}
// Add one layer of `kind` to a side's hazards, returning a NEW state (Spikes
// stack to 3, Toxic Spikes to 2; Stealth Rock / Sticky Web are single-layer).
function addHazard(h: HazardState, kind: HazardKind): HazardState {
  const out: HazardState = { ...h };
  if (kind === 'rocks') out.rocks = true;
  else if (kind === 'spikes') out.spikes = Math.min((out.spikes ?? 0) + 1, 3) as 0 | 1 | 2 | 3;
  else if (kind === 'toxicspikes') out.toxicSpikes = Math.min((out.toxicSpikes ?? 0) + 1, 2) as 0 | 1 | 2;
  else if (kind === 'stickyweb') out.stickyWeb = true;
  return out;
}
// True if a hazard of `kind` could still be added to this side (not already maxed).
function hazardRoom(h: HazardState, kind: HazardKind): boolean {
  if (kind === 'rocks') return !h.rocks;
  if (kind === 'spikes') return (h.spikes ?? 0) < 3;
  if (kind === 'toxicspikes') return (h.toxicSpikes ?? 0) < 2;
  return !h.stickyWeb;
}
// The per-mon switch-in hazard effect, computed DYNAMICALLY from the live side
// hazards (so a hazard SET mid-search bites a later switch/refill-in).
function hazardEffectFor(hazards: HazardState | undefined, species: string, ability: string | null | undefined, item: string | undefined, gravity?: boolean): HazardEffect {
  return applyHazardsToSwitchIn(hazards, { species, ability: ability ?? undefined, item, gravity });
}

// Which roll point each side uses. "pessimistic"/"optimistic" are from MY
// perspective: pessimistic = my low rolls + opp high rolls (+ opp survives);
// optimistic = the reverse. expected = mid rolls, current behaviour.
type Regime = 'expected' | 'pessimistic' | 'optimistic';
interface Pass {
  regime: Regime;
  /** Per-index: should a Focus Sash / Sturdy survive-at-1 be applied this pass? */
  survMy: boolean[];
  survOpp: boolean[];
}
function myRoll(c: Cell, r: Regime): number {
  return r === 'pessimistic' ? c.dmgMin : r === 'optimistic' ? c.dmgMax : c.dmgMid;
}
function oppRoll(c: Cell, r: Regime): number {
  return r === 'pessimistic' ? c.dmgMax : r === 'optimistic' ? c.dmgMin : c.dmgMid;
}
function mySpreadRoll(s: SpreadOpt, r: Regime): number[] {
  return r === 'pessimistic' ? s.dmgMin : r === 'optimistic' ? s.dmgMax : s.dmgMid;
}
// Opp spread roll mirrors oppRoll: pessimistic (worst for me) = opp high rolls;
// optimistic = opp low rolls.
function oppSpreadRoll(s: SpreadOpt, r: Regime): number[] {
  return r === 'pessimistic' ? s.dmgMax : r === 'optimistic' ? s.dmgMin : s.dmgMid;
}

// Probability the hit KOs a target at current HP `h`. Prefers the EMPIRICAL
// distribution: the fraction of pooled rolls (across every surviving candidate
// spread × roll) that reach `h` — this folds in the chance the opponent is
// bulkier than the likely spread, not just roll variance. Falls back to a
// uniform envelope estimate when rolls aren't available (e.g. spread moves).
function rollKoProb(c: Cell, h: number): number {
  if (c.koRolls.length) return c.koRolls.filter(r => r >= h).length / c.koRolls.length;
  if (c.dmgMax <= c.dmgMin) return c.dmgMid >= h ? 1 : 0;
  return Math.max(0, Math.min(1, (c.dmgMax - h) / (c.dmgMax - c.dmgMin)));
}

// Move accuracy as a 0..100 percent. `accuracy === true` (never-miss) or unset
// → 100. Used by the Hail-Mary "the opp has to land it" out.
function moveAccuracyPct(moveName: string): number {
  const a = (getMove(moveName) as { accuracy?: number | true } | undefined)?.accuracy;
  return a === true || a == null ? 100 : a;
}

// Uniform-envelope KO chance for a spread option (no per-roll distribution).
function spreadKoProb(lo: number, mid: number, hi: number, h: number): number {
  if (hi < h) return 0;
  if (hi <= lo) return mid >= h ? 1 : 0;
  return Math.max(0, Math.min(1, (hi - h) / (hi - lo)));
}

interface Tables {
  myN: number;
  oppN: number;
  // Deeper plies that still enumerate bench/phantom switches (Step B/C breadth
  // knob). Defaults to SWITCH_PLY_LIMIT; the widening driver dials it per pass.
  switchPlyLimit?: number;
  // Transposition table for value(): keyed by (full state, depth, maxDepth, pass)
  // → fail-soft alpha-beta bound. Per-Tables so mega combos + breadth never share
  // entries; persists across toDepth() calls (the key's maxDepth keeps trees apart).
  tt?: Map<string, { value: number; flag: 0 | 1 | 2 }>;   // flag: 0 exact · 1 lower · 2 upper
  mySpecies: string[];
  oppSpecies: string[];
  mySpeed: number[];           // effective base speed incl. Spe stage (pre-field)
  oppSpeed: number[];
  myPar: boolean[];            // paralyzed → halve speed at sort time
  oppPar: boolean[];
  off: Cell[][];               // off[mi][oj] — my mi attacking opp oj (best single-target)
  thr: Cell[][];               // thr[oj][mi] — opp oj attacking my mi
  mySpread: (SpreadOpt | null)[]; // mySpread[mi] — best spread move, or null
  mySpreadActors: Set<number>; // indices of mine that have a spread option
  oppSpread: (SpreadOpt | null)[]; // oppSpread[oj] — opp's best spread move (dmg vs each my index), or null
  oppSpreadActors: Set<number>; // indices of opps that have a spread option
  myProtectMove: (string | null)[]; // protect move name per my mon, null = can't protect
  oppProtectMove: (string | null)[]; // protect move name per opp (from knownMoves), null = can't protect
  // Order-affecting field moves a mon can cast (null = doesn't have it). These
  // change turn order, not damage, so the live flags live in State; here we only
  // record CAPABILITY (who could set it).
  myTailwindMove: (string | null)[];
  oppTailwindMove: (string | null)[];
  myTrickRoomMove: (string | null)[];
  oppTrickRoomMove: (string | null)[];
  // Leech Seed capability (null = doesn't know it) + max HP per mon (for the
  // drain→heal conversion across differing HP totals) + Grass immunity flags.
  myLeechMove: (string | null)[];
  oppLeechMove: (string | null)[];
  myMaxHp: number[];
  oppMaxHp: number[];
  myGrass: boolean[];
  oppGrass: boolean[];
  // Boost stages baked into the damage cells (= the input boosts). Dynamic
  // boosts during the search scale damage by the ratio vs these.
  myBaked: BoostMap[];
  oppBaked: BoostMap[];
  // Setup-move capability: the self-boost map a mon applies if it sets up
  // (Calm Mind / Swords Dance / …), + the move name; null = no setup move.
  mySetup: (BoostMap | null)[];
  oppSetup: (BoostMap | null)[];
  mySetupMove: (string | null)[];
  oppSetupMove: (string | null)[];
  // Baton Pass capability (passes boosts to a switch-in).
  myBatonMove: (string | null)[];
  oppBatonMove: (string | null)[];
  // Speed Boost ability (+1 Spe each EOT while active).
  mySpeedBoost: boolean[];
  oppSpeedBoost: boolean[];
  // Intimidate (drops foes' Atk on switch-in) + which mons are immune to it.
  myIntimidate: boolean[]; oppIntimidate: boolean[];
  myIntimImmune: boolean[]; oppIntimImmune: boolean[];
  // Stat-drop immunity (Clear Body / White Smoke / Full Metal Body / Clear Amulet)
  // and the Defiant/Competitive reaction stat (+2 on any opponent-caused drop).
  myStatDropImmune: boolean[]; oppStatDropImmune: boolean[];
  myDefiantStat: ('atk' | 'spa' | null)[]; oppDefiantStat: ('atk' | 'spa' | null)[];
  // Unaware: ignores the opponent's stat stages when computing damage (both ways).
  myUnaware: boolean[]; oppUnaware: boolean[];
  // On-KO ability boost (Moxie/Beast Boost/Grim Neigh/…): the stage map a mon gains
  // each time it KOes a foe, or null.
  myOnKo: (BoostMap | null)[]; oppOnKo: (BoostMap | null)[];
  // Life Orb recoil: this mon loses 10% max HP when it lands a damaging move.
  myLifeOrb: boolean[]; oppLifeOrb: boolean[];
  // Redirection move (Follow Me / Rage Powder), or null.
  myRedirectMove: (string | null)[]; oppRedirectMove: (string | null)[];
  // Pivot move (U-turn/Volt Switch/Flip Turn/Parting Shot/Teleport/…): the move
  // name (null = none), the per-foe damage cell of THAT move, and the foe debuff it
  // applies as it leaves (Parting Shot −1 Atk/SpA). The user auto-switches out.
  myPivotMove: (string | null)[]; oppPivotMove: (string | null)[];
  myPivotCell: (Cell[] | null)[]; oppPivotCell: (Cell[] | null)[];
  myPivotDebuff: (BoostMap | null)[]; oppPivotDebuff: (BoostMap | null)[];
  // Dedicated debuff move (Charm/Scary Face/…): move + the foe boost-drop it applies.
  myDebuffMove: ({ move: string; boosts: BoostMap } | null)[]; oppDebuffMove: ({ move: string; boosts: BoostMap } | null)[];
  // Taunt / Encore moves (option-restriction), or null.
  myTauntMove: (string | null)[]; oppTauntMove: (string | null)[];
  myEncoreMove: (string | null)[]; oppEncoreMove: (string | null)[];
  // Meta items/abilities: resist-berry type (halves one SE hit of it), Unburden +
  // White Herb (item-consume → ×2 Spe / restore drops), Choice lock, Fake Out.
  myResistBerryType: (string | null)[]; oppResistBerryType: (string | null)[];
  myHasUnburden: boolean[]; oppHasUnburden: boolean[];
  myWhiteHerb: boolean[]; oppWhiteHerb: boolean[];
  myChoice: boolean[]; oppChoice: boolean[];
  myHasFakeOut: boolean[]; oppHasFakeOut: boolean[];
  myFakeOutCell: (Cell[] | null)[]; oppFakeOutCell: (Cell[] | null)[];
  // Helping Hand: which actives know it (the ally's move deals ×1.5 that turn).
  myHelpingHand: boolean[]; oppHelpingHand: boolean[];
  // Wide Guard (blocks foe spread moves) / Quick Guard (blocks foe priority moves):
  // which actives know each (team-protect for the turn).
  myWideGuard: boolean[]; oppWideGuard: boolean[];
  myQuickGuard: boolean[]; oppQuickGuard: boolean[];
  // Strength Sap: who knows it + each mon's Attack stat (heal = target's Atk stat).
  myStrengthSap: boolean[]; oppStrengthSap: boolean[];
  // Substitute: who knows it (can pay 25% HP to put up a sub).
  myHasSubMove: boolean[]; oppHasSubMove: boolean[];
  // Counter / Mirror Coat / Metal Burst: who knows one + which category it reflects.
  myCounter: (CounterMove | null)[]; oppCounter: (CounterMove | null)[];
  // Gravity / Wonder Room / Magic Room: which room (if any) each mon can set.
  myRoomMove: (RoomKind | null)[]; oppRoomMove: (RoomKind | null)[];
  myAtkStat: number[]; oppAtkStat: number[];
  // Weakness Policy: holders get +2 Atk/+2 SpA on surviving a super-effective hit.
  myWp: boolean[]; oppWp: boolean[];
  // Hazard-clear move per mon (Rapid Spin / Defog / Court Change / Tidy Up), or null.
  myHazardClear: (ReturnType<typeof findHazardClear>)[];
  oppHazardClear: (ReturnType<typeof findHazardClear>)[];
  myFlinchImmune: boolean[]; oppFlinchImmune: boolean[];
  // Best PRIORITY move per attacker×target (priority > 0; null = the mon has none).
  // The max-damage `off`/`thr` cell hides priority moves whenever they aren't the
  // hardest hit, so these are offered as a SEPARATE attack option — a priority KO
  // is endgame-decisive. Indexed like off/thr: myPrioCell[mi][oj], oppPrioCell[oj][mi].
  myPrioCell: (Cell | null)[][]; oppPrioCell: (Cell | null)[][];
  // Regenerator: heals 1/3 max HP when the mon switches OUT.
  myRegen: boolean[]; oppRegen: boolean[];
  // Rock Head: negates a recoil move's self-damage (Magic Guard does too, via myResidual).
  myRockHead: boolean[]; oppRockHead: boolean[];
  // Screen-move capability: what a SET_SCREEN action puts up for the caster's
  // side, + the move name; null = the mon knows no screen move.
  myScreen: (ScreenSet | null)[];
  oppScreen: (ScreenSet | null)[];
  // Weather: defender Rock/Ice flags (for Sand/Snow defensive boosts), the
  // weather that doubles each mon's Speed (Chlorophyll etc.; known-or-plausible
  // for the opp), the weather a SET_WEATHER move sets, and the weather an
  // ability sets on switch-in (Drought etc.).
  myRock: boolean[]; oppRock: boolean[];
  myIce: boolean[]; oppIce: boolean[];
  mySpeedWeather: (Weather | null)[]; oppSpeedWeather: (Weather | null)[];
  myWeatherMove: ({ move: string; weather: Weather } | null)[];
  oppWeatherMove: ({ move: string; weather: Weather } | null)[];
  myWeatherAbility: (Weather | null)[]; oppWeatherAbility: (Weather | null)[];
  // Terrain: grounded flags (terrain only affects grounded mons), terrain-move
  // capability, and the terrain a surge ability sets on switch-in.
  myGrounded: boolean[]; oppGrounded: boolean[];
  myTerrainMove: ({ move: string; terrain: Terrain } | null)[];
  oppTerrainMove: ({ move: string; terrain: Terrain } | null)[];
  myTerrainAbility: (Terrain | null)[]; oppTerrainAbility: (Terrain | null)[];
  // End-of-turn residual info per mon (status chip, sand immunity, heals).
  myResidual: ResidualInfo[]; oppResidual: ResidualInfo[];
  // Status-inflicting move a mon knows (Will-O-Wisp/Thunder Wave/Toxic/…), null
  // if none. + per-mon ability (for status-immunity checks at apply time).
  myStatusMove: (StatusMove | null)[]; oppStatusMove: (StatusMove | null)[];
  myAbility: (string | null | undefined)[]; oppAbility: (string | null | undefined)[];
  // Recovery move a mon knows (Recover/Roost/Synthesis/…), null if none.
  myRecover: (RecoverMove | null)[]; oppRecover: (RecoverMove | null)[];
  // Held item per mon (for HP-trigger / status berries). Known-only for the opp.
  myItem: (string | undefined)[]; oppItem: (string | undefined)[];
  // Dedicated hazard-setting move a mon knows (Stealth Rock / Spikes / Toxic
  // Spikes / Sticky Web), null if none. The switch-in hazard CHIP is computed
  // dynamically (hazardEffectFor) from the live side hazards in State, since a
  // hazard set mid-search must bite a later switch/refill-in.
  myHazardMove: ({ move: string; hazard: HazardKind } | null)[];
  oppHazardMove: ({ move: string; hazard: HazardKind } | null)[];
  // % HP a mon's Rocky Helmet / Rough Skin / Iron Barbs chips off a contacting
  // attacker (0 if none). Max HP per mon (for drain heal — already have *MaxHp).
  myContactChip: number[]; oppContactChip: number[];
  field: FieldState;
}

// Contact-punish % an attacker suffers hitting this mon (Rocky Helmet 1/6,
// Rough Skin / Iron Barbs / Spiky Surge-less 1/8). Both stack if present.
function contactChipFor(ability: string | null | undefined, item: string | null | undefined): number {
  let pct = 0;
  if (/rocky\s*helmet/i.test(item ?? '')) pct += 100 / 6;
  const ab = toId(ability ?? '');
  if (ab === 'roughskin' || ab === 'ironbarbs') pct += 100 / 8;
  return pct;
}

/** What a screen move sets on the caster's side. */
interface ScreenSet { move: string; reflect: boolean; lightScreen: boolean }
// The best screen move a mon knows. Aurora Veil (both) > Reflect > Light Screen.
function findScreenMove(moves: string[]): ScreenSet | null {
  const ids = new Set(moves.map(toId));
  if (ids.has('auroraveil')) return { move: 'Aurora Veil', reflect: true, lightScreen: true };
  if (ids.has('reflect')) return { move: 'Reflect', reflect: true, lightScreen: false };
  if (ids.has('lightscreen')) return { move: 'Light Screen', reflect: false, lightScreen: true };
  return null;
}

// Self-boost effects for the setup moves we model. Drops are included where they
// matter (Shell Smash) so the trade-off is honest.
const SETUP_MOVES: Record<string, BoostMap> = {
  swordsdance: { atk: 2 },
  howl: { atk: 1 },
  nastyplot: { spa: 2 },
  tailglow: { spa: 3 },
  calmmind: { spa: 1, spd: 1 },
  takeheart: { spa: 1, spd: 1 },
  dragondance: { atk: 1, spe: 1 },
  bulkup: { atk: 1, def: 1 },
  coil: { atk: 1, def: 1 },
  workup: { atk: 1, spa: 1 },
  growth: { atk: 1, spa: 1 },
  irondefense: { def: 2 },
  acidarmor: { def: 2 },
  amnesia: { spd: 2 },
  agility: { spe: 2 },
  rockpolish: { spe: 2 },
  quiverdance: { spa: 1, spd: 1, spe: 1 },
  victorydance: { atk: 1, def: 1, spe: 1 },
  clangoroussoul: { atk: 1, def: 1, spa: 1, spd: 1, spe: 1 },
  shellsmash: { atk: 2, spa: 2, spe: 2, def: -1, spd: -1 },
};
// The best setup move a mon knows (by total positive boost), + its boost map.
function findSetupMove(moves: string[]): { move: string; boosts: BoostMap } | null {
  let best: { move: string; boosts: BoostMap; score: number } | null = null;
  for (const mv of moves) {
    const b = SETUP_MOVES[toId(mv)];
    if (!b) continue;
    const score = (['atk', 'def', 'spa', 'spd', 'spe'] as const).reduce((a, k) => a + Math.max(0, b[k] ?? 0), 0);
    if (!best || score > best.score) best = { move: mv, boosts: b, score };
  }
  return best ? { move: best.move, boosts: best.boosts } : null;
}
function hasSpeedBoost(ability: string | null | undefined): boolean {
  return !!ability && toId(ability) === 'speedboost';
}
function hasIntimidate(ability: string | null | undefined): boolean {
  return !!ability && toId(ability) === 'intimidate';
}
function hasRegenerator(ability: string | null | undefined): boolean {
  return !!ability && toId(ability) === 'regenerator';
}
// Abilities/items that block an Intimidate Atk drop (Defiant/Competitive/Guard
// Dog REACTIONS are deferred — we just don't drop for the immune ones).
const INTIM_IMMUNE_ABILITIES = new Set(['clearbody', 'whitesmoke', 'fullmetalbody', 'hypercutter', 'innerfocus', 'oblivious', 'owntempo', 'scrappy', 'guarddog']);
function intimidateImmune(ability: string | null | undefined, item: string | null | undefined): boolean {
  return INTIM_IMMUNE_ABILITIES.has(toId(ability ?? '')) || /clear\s*amulet/i.test(item ?? '');
}

// True for a Grass-type species (immune to Leech Seed).
function isGrassType(species: string): boolean {
  const sp = getSpecies(species) as { types?: string[] } | undefined;
  return (sp?.types ?? []).includes('Grass');
}

// Single-user protection moves (user fully blocks incoming damage for one turn).
// Wide Guard / Quick Guard / Mat Block protect the TEAM and are not modelled here.
const PROTECT_MOVE_IDS = new Set(['protect', 'detect', 'kingsshield', 'banefulbunker', 'spikyshield', 'obstruct', 'silktrap', 'burningbulwark']);
function isProtectMove(move: string): boolean {
  return PROTECT_MOVE_IDS.has(toId(move));
}
function findProtectMove(moves: string[]): string | null {
  return moves.find(m => isProtectMove(m)) ?? null;
}
function findMoveId(moves: string[], id: string): string | null {
  return moves.find(m => toId(m) === id) ?? null;
}

// Best spread move for my mon (by total damage across the current opponents),
// or null if it has none. Damage per opp index parallels `opps`. Honors the
// attacker's mega/boosts/status and each defender's mega/boosts/status so the
// spread numbers match the single-target cells.
function bestSpread(
  m: SearchMyMon,
  opps: SearchOppMon[],
  field: FieldState,
  o: { attackerGimmickActive: boolean; defHypoMega: (j: number) => boolean },
): SpreadOpt | null {
  const spreads = (m.set.moves ?? []).filter(isSpreadMove);
  if (spreads.length === 0) return null;
  let best: { opt: SpreadOpt; total: number } | null = null;
  for (const mv of spreads) {
    const atk: PokemonSet = { ...m.set, moves: [mv] };
    const cells = opps.map((opp, j) => cellFrom(predictOffense({
      attacker: atk, opponent: opp.entry, field,
      attackerGimmickActive: o.attackerGimmickActive,
      defenderGimmickActive: o.defHypoMega(j),
      attackerBoosts: m.boosts, attackerStatus: m.status,
      defenderBoosts: opp.boosts, defenderStatus: opp.status,
    })));
    const opt: SpreadOpt = {
      move: mv, priority: movePriority(mv), physical: isPhysicalMove(mv), type: moveType(mv), groundMove: isGroundMove(mv), selfDrop: selfDropOf(mv), foeDrop: foeDropOf(mv),
      dmgMin: cells.map(c => c.dmgMin),
      dmgMid: cells.map(c => c.dmgMid),
      dmgMax: cells.map(c => c.dmgMax),
    };
    const total = opt.dmgMid.reduce((a, b) => a + b, 0);
    if (!best || total > best.total) best = { opt, total };
  }
  return best?.opt ?? null;
}

// Best spread move for an OPPONENT mon (by total damage across MY current
// actives), or null if it has none. Mirror of bestSpread. The move pool is
// drawn from the SAME source predictThreat uses — knownMoves when we've seen
// any, else Pikalytics top moves — so the spread option is consistent with the
// single-target threat cells. `entryResolved` is megaified for the hypothetical
// opp-mega branch; `o` carries the opp's live boosts/status.
function bestSpreadOpp(
  o: SearchOppMon,
  entryResolved: OpponentEntry,
  mine: SearchMyMon[],
  field: FieldState,
  opt: { attackerGimmickActive: boolean; myMega: (mi: number) => boolean },
): SpreadOpt | null {
  const pool = entryResolved.knownMoves.length ? entryResolved.knownMoves : pikalyticsMoves(entryResolved.species);
  const spreads = pool.filter(isSpreadMove);
  if (spreads.length === 0) return null;
  let best: { opt: SpreadOpt; total: number } | null = null;
  for (const mv of spreads) {
    const synth: OpponentEntry = { ...entryResolved, knownMoves: [mv] };
    const cells = mine.map((m, mi) => cellFrom(predictThreat({
      opponent: synth, defender: m.set, field,
      attackerGimmickActive: opt.attackerGimmickActive,
      defenderGimmickActive: opt.myMega(mi),
      attackerBoosts: o.boosts, attackerStatus: o.status,
      defenderBoosts: m.boosts, defenderStatus: m.status,
    })));
    const so: SpreadOpt = {
      move: mv, priority: movePriority(mv), physical: isPhysicalMove(mv), type: moveType(mv), groundMove: isGroundMove(mv), selfDrop: selfDropOf(mv), foeDrop: foeDropOf(mv),
      dmgMin: cells.map(c => c.dmgMin),
      dmgMid: cells.map(c => c.dmgMid),
      dmgMax: cells.map(c => c.dmgMax),
    };
    const total = so.dmgMid.reduce((a, b) => a + b, 0);
    if (!best || total > best.total) best = { opt: so, total };
  }
  return best?.opt ?? null;
}

interface State {
  myHp: number[];
  oppHp: number[];
  myActive: number[];          // indices currently on the field (≤2)
  oppActive: number[];
  myProtectStreak: number[];   // consecutive protect turns per my mon (0 = not protecting last turn)
  oppProtectStreak: number[];
  /** Per opp index: has this mon been revealed/brought? True for everything we've
   *  seen; false for an UNREVEALED phantom until it's switched in. Gates opp
   *  material so phantoms don't count until deployed. */
  oppSeen: boolean[];
  /** Order-affecting field flags — mutable because Tailwind / Trick Room can be
   *  SET mid-search (they change turn order, not damage). Seeded from the live
   *  field; a field action flips them for subsequent plies. */
  trickRoom: boolean;
  myTailwind: boolean;
  theirTailwind: boolean;
  /** Turns remaining for each timed order-effect. Undefined = duration unknown →
   *  the effect persists for the search horizon (no expiry). A known count ticks
   *  down each ply and clears the flag at 0 — so the search can STALL an effect
   *  out (e.g. Protect until the opponent's Tailwind / Trick Room ends). */
  trickRoomTurns?: number;
  myTailwindTurns?: number;
  theirTailwindTurns?: number;
  /** Leech Seed: per mon, the seeder's index ON THE OTHER SIDE (or null). The
   *  seeded mon drains 1/8 each EOT while active; the seeder heals. Removed when
   *  the seeded mon switches out. */
  mySeeded: (number | null)[];
  oppSeeded: (number | null)[];
  /** Live TOTAL stat-stage boosts per mon, seeded from the input boosts (= the
   *  level baked into the damage cells). Setup moves add to these, Speed Boost
   *  bumps Spe each EOT, Baton Pass transfers them — and damage/speed scale by
   *  the ratio vs the baked level (`Tables.my/oppBaked`). */
  myBoost: BoostMap[];
  oppBoost: BoostMap[];
  /** Screens per SIDE (Reflect halves physical, Light Screen halves special;
   *  Aurora Veil = both). Seeded from the field (= baked into the cells); damage
   *  scales by the current-vs-baked screen multiplier. Durations tick down each
   *  ply so the search can stall a screen out. */
  myReflect: boolean;
  myLightScreen: boolean;
  theirReflect: boolean;
  theirLightScreen: boolean;
  myReflectTurns?: number;
  myLightScreenTurns?: number;
  theirReflectTurns?: number;
  theirLightScreenTurns?: number;
  /** Global weather + turns remaining. Seeded from the field (= baked into the
   *  cells); ticks down so the search can stall a weather out (e.g. sun ending
   *  removes a Chlorophyll mon's speed). */
  weather: Weather;
  weatherTurns?: number;
  /** Global terrain + turns remaining (same stall-out treatment as weather). */
  terrain: Terrain;
  terrainTurns?: number;
  /** Toxic (badly-poisoned) counter per mon — damage escalates by n/16 each EOT.
   *  1 for a tox-statused mon at the root, 0 otherwise. */
  myToxicN: number[];
  oppToxicN: number[];
  /** Live non-volatile status per mon ('brn'|'par'|'psn'|'tox'|'slp'|'' ). Seeded
   *  from input (= baked into the cells/speeds); a status MOVE can inflict one
   *  mid-search, which then scales the victim's damage (burn)/speed (para) and
   *  drives the EOT residual. */
  myStatus: string[];
  oppStatus: string[];
  /** True once a mon's one-time consumable (Sitrus / pinch / status berry) has
   *  fired, so it can't fire again this search. */
  myBerryUsed: boolean[];
  oppBerryUsed: boolean[];
  /** Live entry hazards per SIDE (myHazards = on my side, oppHazards = on the
   *  opponent's). Seeded from the field; a hazard MOVE (Stealth Rock / Spikes /
   *  …) or a setting attack (Stone Axe → SR, Ceaseless Edge → Spikes) adds to the
   *  DEFENDER's side, so a later switch / refill-in eats the chip. */
  myHazards: HazardState;
  oppHazards: HazardState;
  /** Turns of sleep remaining per mon (0 = awake). A mon with status 'slp' and a
   *  positive count can't act; ticks down each turn it's on the field, waking at 0.
   *  Inflicted sleep starts at 2 (Gen 9 is 1-3 turns; the middle is a fair model). */
  mySleepTurns: number[];
  oppSleepTurns: number[];
  /** Taunt turns remaining per mon (>0 = can't use status moves). */
  myTaunt: number[];
  oppTaunt: number[];
  /** Encore turns remaining per mon (>0 = locked into `myEncoreAct`); the locked
   *  action code (the target/sentinel it must repeat), or NONE when not encored. */
  myEncore: number[];
  oppEncore: number[];
  myEncoreAct: number[];
  oppEncoreAct: number[];
  /** Unburden active (item consumed → ×2 Spe). */
  myUnburden: boolean[];
  oppUnburden: boolean[];
  /** Resist berry already spent (so a 2nd matching SE hit isn't halved again). */
  myResistBerryUsed: boolean[];
  oppResistBerryUsed: boolean[];
  /** On its first turn out this ply (Fake Out flinch). */
  myFirstTurn: boolean[];
  oppFirstTurn: boolean[];
  /** Disguise / Ice Face intact (absorbs the first damaging hit, then breaks).
   *  Seeded true for a holder of the ability. */
  myDisguise: boolean[];
  oppDisguise: boolean[];
  /** Must recharge this turn (used Hyper Beam / Giga Impact last turn → can't act). */
  myRecharge: boolean[];
  oppRecharge: boolean[];
  /** Turns still locked into a multi-turn move (Outrage / Petal Dance / Thrash):
   *  while >0 the mon can only attack — no switch / setup / protect. */
  myLocked: number[];
  oppLocked: number[];
  /** Substitute HP remaining (% of the mon's max HP; 0 = no sub). Incoming damage
   *  hits the sub first; status / secondaries are blocked while it stands. */
  mySubHp: number[];
  oppSubHp: number[];
  /** Wish: turns until the delayed heal lands on this slot's occupant (0 = none).
   *  Set to 2 on cast → ticks 2→1→heal. */
  myWish: number[];
  oppWish: number[];
  /** Future Sight: turns until the delayed Psychic hit lands on the foe slot
   *  (0 = none), plus the stored damage (% of the target's bar). */
  myFutureTurns: number[];
  oppFutureTurns: number[];
  myFutureDmg: number[];
  oppFutureDmg: number[];
  /** Field rooms (order-irrelevant; damage effects are baked at root, so a room
   *  SET mid-search is tracked + ticked but its damage swing is approximate). */
  gravity: boolean;
  wonderRoom: boolean;
  magicRoom: boolean;
  gravityTurns?: number;
  wonderRoomTurns?: number;
  magicRoomTurns?: number;
}
const NONE = 99;   // "no locked action" sentinel for encoreAct (not a valid target)

// Doubles screen damage reduction (2732/4096 ≈ 0.667), matching @smogon/calc's
// gameType:'Doubles' modifier. A screen on the DEFENDER's side reduces incoming
// damage of the matching category.
const SCREEN_MULT = 2732 / 4096;
function screenMult(up: boolean): number { return up ? SCREEN_MULT : 1; }

// --- Weather ----------------------------------------------------------------
type Weather = FieldState['weather'];           // 'Sun' | 'Rain' | 'Sand' | 'Snow' | … | null
// Normalize primal weather to its regular form for the multiplier/speed checks.
function normWeather(w: Weather): Weather {
  if (w === 'Harsh Sunshine') return 'Sun';
  if (w === 'Heavy Rain') return 'Rain';
  return w;
}
// Damage factor weather applies to ONE hit: Fire/Water boost/reduce in sun/rain
// (offensive), and the Gen-9 defensive stat boosts (Sand → Rock SpD ×1.5, Snow →
// Ice Def ×1.5, i.e. ×2/3 to the matching incoming category). 1 in clear weather.
function weatherDamageFactor(type: string, physical: boolean, defRock: boolean, defIce: boolean, w: Weather): number {
  const nw = normWeather(w);
  let f = 1;
  if (nw === 'Sun') { if (type === 'Fire') f *= 1.5; else if (type === 'Water') f *= 0.5; }
  else if (nw === 'Rain') { if (type === 'Water') f *= 1.5; else if (type === 'Fire') f *= 0.5; }
  else if (nw === 'Sand') { if (defRock && !physical) f *= 2 / 3; }
  else if (nw === 'Snow') { if (defIce && physical) f *= 2 / 3; }
  return f;
}
// The weather under which an ability doubles Speed (Chlorophyll → Sun, etc.).
function speedWeatherForAbility(ability: string | null | undefined): Weather | null {
  switch (toId(ability ?? '')) {
    case 'chlorophyll': return 'Sun';
    case 'swiftswim': return 'Rain';
    case 'sandrush': return 'Sand';
    case 'slushrush': return 'Snow';
    default: return null;
  }
}
// The weather a move SETS (Sunny Day → Sun, …), or null.
function weatherSetByMove(move: string): Weather | null {
  switch (toId(move)) {
    case 'sunnyday': return 'Sun';
    case 'raindance': return 'Rain';
    case 'sandstorm': return 'Sand';
    case 'snowscape': case 'chillyreception': return 'Snow';
    default: return null;
  }
}
// The weather an ability sets on switch-in (Drought → Sun, …), or null.
function weatherSetByAbility(ability: string | null | undefined): Weather | null {
  switch (toId(ability ?? '')) {
    case 'drought': case 'orichalcumpulse': return 'Sun';
    case 'drizzle': return 'Rain';
    case 'sandstream': return 'Sand';
    case 'snowwarning': return 'Snow';
    default: return null;
  }
}
function findWeatherMove(moves: string[]): { move: string; weather: Weather } | null {
  for (const m of moves) { const w = weatherSetByMove(m); if (w) return { move: m, weather: w }; }
  return null;
}
function isType(species: string, t: string): boolean {
  return ((getSpecies(species) as { types?: string[] } | undefined)?.types ?? []).includes(t);
}

// --- Terrain ----------------------------------------------------------------
type Terrain = FieldState['terrain'];           // 'Electric' | 'Grassy' | 'Misty' | 'Psychic' | null
// Terrain affects only GROUNDED mons: not Flying-type and not Levitate (Air
// Balloon / Iron Ball ignored — a documented simplification).
function isGrounded(species: string, ability: string | null | undefined): boolean {
  if (toId(ability ?? '') === 'levitate') return false;
  return !isType(species, 'Flying');
}
// Damage factor terrain applies to ONE hit. Electric/Grassy/Psychic boost the
// matching TYPE ×1.3 for a GROUNDED ATTACKER; Grassy halves Earthquake/Bulldoze/
// Magnitude and Misty halves Dragon against a GROUNDED DEFENDER. 1 otherwise.
function terrainDamageFactor(type: string, groundMove: boolean, attackerGrounded: boolean, defenderGrounded: boolean, ter: Terrain): number {
  let f = 1;
  if (ter === 'Electric') { if (attackerGrounded && type === 'Electric') f *= 1.3; }
  else if (ter === 'Grassy') {
    if (attackerGrounded && type === 'Grass') f *= 1.3;
    if (defenderGrounded && groundMove) f *= 0.5;
  }
  else if (ter === 'Psychic') { if (attackerGrounded && type === 'Psychic') f *= 1.3; }
  else if (ter === 'Misty') { if (defenderGrounded && type === 'Dragon') f *= 0.5; }
  return f;
}
function terrainSetByMove(move: string): Terrain | null {
  switch (toId(move)) {
    case 'electricterrain': return 'Electric';
    case 'grassyterrain': return 'Grassy';
    case 'mistyterrain': return 'Misty';
    case 'psychicterrain': return 'Psychic';
    default: return null;
  }
}
function terrainSetByAbility(ability: string | null | undefined): Terrain | null {
  switch (toId(ability ?? '')) {
    case 'electricsurge': case 'hadronengine': return 'Electric';
    case 'grassysurge': return 'Grassy';
    case 'mistysurge': return 'Misty';
    case 'psychicsurge': return 'Psychic';
    default: return null;
  }
}
function findTerrainMove(moves: string[]): { move: string; terrain: Terrain } | null {
  for (const m of moves) { const ter = terrainSetByMove(m); if (ter) return { move: m, terrain: ter }; }
  return null;
}

// --- Recovery moves ---------------------------------------------------------
/** A recovery move + how its heal scales: 'flat' = 50%, 'sun' = boosted in sun /
 *  cut in other weather (Synthesis/Moonlight/Morning Sun), 'sand' = Shore Up. */
interface RecoverMove { move: string; kind: 'flat' | 'sun' | 'sand' | 'wish' }
const FLAT_RECOVER = new Set(['recover', 'slackoff', 'softboiled', 'milkdrink', 'roost', 'healorder', 'lifedew', 'junglehealing']);
function findRecoverMove(moves: string[]): RecoverMove | null {
  for (const m of moves) {
    const id = toId(m);
    if (FLAT_RECOVER.has(id)) return { move: m, kind: 'flat' };
    if (id === 'synthesis' || id === 'moonlight' || id === 'morningsun') return { move: m, kind: 'sun' };
    if (id === 'shoreup') return { move: m, kind: 'sand' };
    if (id === 'wish') return { move: m, kind: 'wish' };   // delayed: heals the slot 50% next turn
  }
  return null;
}
// Heal % for a recovery move given the current weather.
function recoverPct(kind: RecoverMove['kind'], w: Weather): number {
  if (kind === 'flat') return 50;
  const nw = normWeather(w);
  if (kind === 'sun') return nw === 'Sun' ? 200 / 3 : nw == null ? 50 : 25;
  /* sand */ return nw === 'Sand' ? 200 / 3 : nw == null ? 50 : 25;
}

// --- End-of-turn residuals --------------------------------------------------
/** Per-mon info for the EOT residual pass (status chip, sand/heal eligibility). */
interface ResidualInfo { status: string; magicGuard: boolean; leftovers: boolean; sandImmune: boolean }
function residualInfo(species: string, ability: string | null | undefined, item: string | null | undefined, status: string | undefined): ResidualInfo {
  const ab = toId(ability ?? '');
  const magicGuard = ab === 'magicguard';
  const leftovers = /leftovers/i.test(item ?? '');
  const sandImmune = magicGuard || ['sandveil', 'sandrush', 'sandforce', 'overcoat'].includes(ab)
    || isType(species, 'Rock') || isType(species, 'Ground') || isType(species, 'Steel');
  return { status: status ?? '', magicGuard, leftovers, sandImmune };
}

// --- Inflicted status -------------------------------------------------------
/** A status-inflicting move + the status it applies (sleep deferred). */
interface StatusMove { move: string; status: string }
function findStatusMove(moves: string[]): StatusMove | null {
  for (const m of moves) {
    switch (toId(m)) {
      case 'willowisp': return { move: m, status: 'brn' };
      case 'thunderwave': return { move: m, status: 'par' };
      case 'glare': case 'stunspore': return { move: m, status: 'par' };
      case 'toxic': case 'toxicthread': return { move: m, status: 'tox' };
      case 'poisonpowder': case 'poisongas': return { move: m, status: 'psn' };
      case 'spore': case 'sleeppowder': case 'hypnosis': case 'lovelykiss':
      case 'sing': case 'grasswhistle': case 'darkvoid': return { move: m, status: 'slp' };
    }
  }
  return null;
}
// Powder moves are blocked by Grass-type / Overcoat / Safety Goggles (item check
// omitted — ability only here). Spore / Sleep Powder / Cotton Spore are powders.
const POWDER_MOVES = new Set(['spore', 'sleeppowder', 'cottonspore', 'poisonpowder', 'stunspore', 'ragepowder']);
function isPowderMove(move: string): boolean { return POWDER_MOVES.has(toId(move)); }
// A move that redirects the foes' single-target attacks onto the user this turn.
function findRedirectMove(moves: string[]): string | null {
  return moves.find(m => { const id = toId(m); return id === 'followme' || id === 'ragepowder'; }) ?? null;
}
// Pivot moves: the user damages/debuffs a foe, then switches out to a bench mon.
// Baton Pass is handled separately (it passes boosts); these don't.
const PIVOT_MOVE_IDS = new Set(['uturn', 'voltswitch', 'flipturn', 'partingshot', 'teleport', 'chillyreception']);
function findPivotMove(moves: string[]): string | null {
  return moves.find(m => PIVOT_MOVE_IDS.has(toId(m))) ?? null;
}
// The foe stat-drop a pivot move applies as it leaves (Parting Shot −1 Atk/−1 SpA).
function pivotDebuff(move: string): BoostMap | null {
  return toId(move) === 'partingshot' ? { atk: -1, spa: -1 } : null;
}
// Dedicated 0-damage stat-lowering STATUS moves the user can cast on a foe. Keyed by
// name (acc/eva drops omitted — we don't track those). Spread debuffs (Growl/Leer)
// and acc-droppers stay a gap (flagged by unmodeled.ts).
const DEBUFF_MOVES: Record<string, BoostMap> = {
  charm: { atk: -2 }, featherdance: { atk: -2 }, playnice: { atk: -1 }, babydolleyes: { atk: -1 },
  eerieimpulse: { spa: -2 }, confide: { spa: -1 }, captivate: { spa: -2 },
  scaryface: { spe: -2 }, cottonspore: { spe: -2 },
  screech: { def: -2 }, metalsound: { spd: -2 }, faketears: { spd: -2 },
  tickle: { atk: -1, def: -1 }, nobleroar: { atk: -1, spa: -1 },
};
function findDebuffMove(moves: string[]): { move: string; boosts: BoostMap } | null {
  for (const m of moves) { const b = DEBUFF_MOVES[toId(m)]; if (b) return { move: m, boosts: b }; }
  return null;
}
// Taunt (target can't use status moves for ~3 turns) / Encore (target locked into
// its last move for ~3 turns) — common option-restriction moves.
function findTauntMove(moves: string[]): string | null { return moves.find(m => toId(m) === 'taunt') ?? null; }
function findEncoreMove(moves: string[]): string | null { return moves.find(m => toId(m) === 'encore') ?? null; }

// --- Meta-driven items/abilities (Champions Reg M-A) -------------------------
// Resist berry → the type it halves a SUPER-EFFECTIVE hit of (once, then consumed).
const RESIST_BERRY_TYPE: Record<string, string> = {
  chopleberry: 'Fighting', yacheberry: 'Ice', occaberry: 'Fire', passhoberry: 'Water',
  wacanberry: 'Electric', rindoberry: 'Grass', kebiaberry: 'Poison', shucaberry: 'Ground',
  cobaberry: 'Flying', payapaberry: 'Psychic', tangaberry: 'Bug', chartiberry: 'Rock',
  kasibberry: 'Ghost', habanberry: 'Dragon', colburberry: 'Dark', babiriberry: 'Steel',
  roseliberry: 'Fairy', chilanberry: 'Normal',
};
function resistBerryType(item: string | null | undefined): string | null { return RESIST_BERRY_TYPE[toId(item ?? '')] ?? null; }
// Sucker Punch / Thunderclap: a priority attack that FAILS unless the target is
// using a damaging move this turn (and hasn't already moved). Kingambit's Sucker
// Punch is meta-defining (~38% mon, near-universal on it), so modelling the fail
// lets the search find the "switch out / go status to dodge it" line instead of
// assuming a free priority KO. Detected by move name on the cell.
const SUCKER_LIKE = new Set(['suckerpunch', 'thunderclap']);
function isSuckerLike(move: string | null | undefined): boolean { return SUCKER_LIKE.has(toId(move ?? '')); }
// Self-destruct moves (Explosion / Self-Destruct / Misty Explosion / Final Gambit /
// Memento / Healing Wish …): the user faints after the move resolves.
function isSelfdestruct(move: string | null | undefined): boolean {
  return !!(getMove(move ?? '') as { selfdestruct?: unknown } | undefined)?.selfdestruct;
}
function holdsWeaknessPolicy(item: string | null | undefined): boolean { return /weakness\s*policy/i.test(item ?? ''); }
// Super-effective check for Weakness Policy (types from the live forme name).
function isSuperEffectiveOn(species: string, moveType: string): boolean {
  if (!moveType) return false;
  const types = (getSpecies(species) as { types?: string[] } | undefined)?.types ?? [];
  return effectiveness(moveType, types) > 1;
}
// First-turn-only moves: have their own cell + first-turn-out gating, so they're
// excluded from the generic priority-attack cell.
const FIRST_TURN_MOVE_IDS = new Set(['fakeout', 'firstimpression', 'matblock']);
// Effective priority of a DAMAGING move given live state: base dex priority plus
// the conditional bumps that apply to ATTACKS — Grassy Glide (+1 in Grassy
// Terrain) and Gale Wings (+1 on a Flying move at full HP). Quick Claw is random
// (not a guaranteed bracket) so it's excluded; Prankster/Triage gate on status/
// heal moves, which aren't damaging attacks, so they don't reach the prio cell.
function effectiveAttackPriority(move: string, ability: string | null | undefined, hpPercent: number, terrain: Terrain | null): number {
  let p = movePriority(move);
  const ab = toId(ability ?? '');
  if (toId(move) === 'grassyglide' && terrain === 'Grassy') p += 1;
  if (ab === 'galewings' && hpPercent >= 100 && (getMove(move) as { type?: string } | undefined)?.type === 'Flying') p += 1;
  // Triage: +3 to draining moves (Giga Drain / Drain Punch / Draining Kiss …) — a
  // damaging priority attack. Pure heal moves are Status (excluded upstream).
  if (ab === 'triage' && moveDrain(move) > 0) p += 3;
  return p;
}
function hasUnburden(ability: string | null | undefined): boolean { return toId(ability ?? '') === 'unburden'; }
function isWhiteHerb(item: string | null | undefined): boolean { return toId(item ?? '') === 'whiteherb'; }
function isChoiceItem(item: string | null | undefined): boolean { const i = toId(item ?? ''); return i === 'choiceband' || i === 'choicespecs' || i === 'choicescarf'; }
function hasFakeOut(moves: string[]): boolean { return moves.some(m => toId(m) === 'fakeout'); }
function hasHelpingHand(moves: string[]): boolean { return moves.some(m => toId(m) === 'helpinghand'); }
function hasWideGuard(moves: string[]): boolean { return moves.some(m => toId(m) === 'wideguard'); }
function hasQuickGuard(moves: string[]): boolean { return moves.some(m => toId(m) === 'quickguard'); }
function hasStrengthSap(moves: string[]): boolean { return moves.some(m => toId(m) === 'strengthsap'); }
// Hazard-clear move a mon knows (Rapid Spin / Mortal Spin / Defog / Court Change /
// Tidy Up) + its effect kind + the user's stat boost. null = knows none.
const HAZARD_CLEAR: Record<string, { kind: 'self' | 'both' | 'swap'; spe?: number; atk?: number }> = {
  rapidspin: { kind: 'self', spe: 1 }, mortalspin: { kind: 'self' }, defog: { kind: 'both' },
  courtchange: { kind: 'swap' }, tidyup: { kind: 'both', spe: 1, atk: 1 },
};
function findHazardClear(moves: string[]): { move: string; kind: 'self' | 'both' | 'swap'; spe?: number; atk?: number } | null {
  for (const m of moves) { const e = HAZARD_CLEAR[toId(m)]; if (e) return { move: m, ...e }; }
  return null;
}
function hasAnyHazard(h: HazardState): boolean {
  return !!(h.rocks || (h.spikes ?? 0) > 0 || (h.toxicSpikes ?? 0) > 0 || h.stickyWeb);
}
// On-contact punish from a Protect-variant, applied to an attacker whose CONTACT
// move is blocked by the protecting mon. King's Shield −1 Atk (Aegislash, Gen 9),
// Spiky Shield 1/8 chip, Silk Trap −1 Spe, Obstruct −2 Def, Baneful Bunker poison,
// Burning Bulwark burn. Plain Protect/Detect/Wide/Quick Guard have none.
function protectPunish(move: string | null | undefined): { drop?: BoostMap; chip?: number; status?: string } | null {
  switch (toId(move ?? '')) {
    case 'kingsshield': return { drop: { atk: -1 } };
    case 'spikyshield': return { chip: 12.5 };
    case 'silktrap': return { drop: { spe: -1 } };
    case 'obstruct': return { drop: { def: -2 } };
    case 'banefulbunker': return { status: 'psn' };
    case 'burningbulwark': return { status: 'brn' };
    default: return null;
  }
}
// Flinch immunity: Inner Focus (ability) or Covert Cloak (item) — common in VGC.
function flinchImmune(ability: string | null | undefined, item: string | null | undefined): boolean {
  return toId(ability ?? '') === 'innerfocus' || /covert\s*cloak/i.test(item ?? '');
}
// Aegislash swaps to its Blade forme (offensive stats) when it uses a damaging move;
// build its OFFENSIVE cells from Blade so its attacks aren't underrated. (Defensive
// forme is action-dependent — left as Shield, a documented simplification.)
function bladeForme(species: string, ability: string | null | undefined): string | null {
  return (toId(species) === 'aegislash' && toId(ability ?? '') === 'stancechange') ? 'Aegislash-Blade' : null;
}
// Can `status` (via `move`) actually land on the target? Honors type immunities,
// the matching ability immunities, and Misty Terrain on grounded mons. We ignore
// already-statused / substitute (checked at apply time).
function statusLands(status: string, move: string, species: string, ability: string | null | undefined, grounded: boolean, ter: Terrain): boolean {
  if (ter === 'Misty' && grounded) return false;        // Misty blocks status on grounded mons
  const ab = toId(ability ?? '');
  if (status === 'brn') return !isType(species, 'Fire') && ab !== 'waterveil' && ab !== 'waterbubble';
  if (status === 'par') {
    if (isType(species, 'Electric') || ab === 'limber') return false;
    if (toId(move) === 'thunderwave' && isType(species, 'Ground')) return false; // Electric-type move misses Ground
    return true;
  }
  if (status === 'psn' || status === 'tox') return !isType(species, 'Poison') && !isType(species, 'Steel') && ab !== 'immunity';
  if (status === 'slp') {
    if (ab === 'insomnia' || ab === 'vitalspirit' || ab === 'comatose' || ab === 'sweetveil') return false;
    if (ter === 'Electric' && grounded) return false;     // Electric Terrain blocks sleep on grounded mons
    if (isPowderMove(move) && (isType(species, 'Grass') || ab === 'overcoat')) return false; // powder immunity
    return true;
  }
  return false;
}
// The weather that doubles a mon's Speed. Known ability wins; if the opp's
// ability is unknown, fall back to a weather-speed ability the species could
// plausibly have (worst-case: it might outspeed me in that weather).
function plausibleSpeedWeather(ability: string | null | undefined, species: string): Weather | null {
  const known = speedWeatherForAbility(ability);
  if (known) return known;
  if (ability) return null;                       // known, but not a weather-speed ability
  const pool = (getSpecies(species) as { abilities?: Record<string, string> } | undefined)?.abilities ?? {};
  for (const ab of Object.values(pool)) { const w = speedWeatherForAbility(ab); if (w) return w; }
  return null;
}

// Add boost stages onto a map (clamped to ±6), returning a NEW map.
function addBoosts(base: BoostMap, add: BoostMap): BoostMap {
  const out: BoostMap = { ...base };
  for (const k of ['atk', 'def', 'spa', 'spd', 'spe'] as const) {
    const v = (out[k] ?? 0) + (add[k] ?? 0);
    if (v !== 0) out[k] = Math.max(-6, Math.min(6, v));
  }
  return out;
}

// Gimmick flags plus the live boosts/status that shape the damage roll. Keys
// mirror predictOffense / predictThreat args so they can be spread straight in.
interface CellOpts {
  attackerGimmickActive?: boolean;
  defenderGimmickActive?: boolean;
  attackerBoosts?: Partial<Record<string, number>>;
  defenderBoosts?: Partial<Record<string, number>>;
  attackerStatus?: string;
  defenderStatus?: string;
}

// Build a Cell's three roll points from a MatchupCell. mid = likely-spread
// midpoint (the old representative value); min/max = the honest envelope edges
// (worst/best roll across surviving candidate spreads).
function cellFrom(c: ReturnType<typeof predictOffense>): Cell {
  if (!c) return { dmgMin: 0, dmgMid: 0, dmgMax: 0, move: '', priority: 0, multiHit: false, koRolls: [], candidates: 0, physical: false, type: '', groundMove: false, drain: 0, contact: false, recoil: 0, setsHazard: null, selfDrop: null, foeDrop: null };
  const lo = c.likelyMinPercent ?? c.minPercent;
  const hi = c.likelyMaxPercent ?? c.maxPercent;
  return {
    dmgMin: c.minPercent,
    dmgMid: (lo + hi) / 2,
    dmgMax: c.maxPercent,
    move: c.move,
    priority: movePriority(c.move),
    multiHit: isMultiHit(c.move),
    koRolls: c.percentRolls ?? [],
    candidates: c.candidatesConsidered ?? 0,
    physical: isPhysicalMove(c.move),
    type: moveType(c.move),
    groundMove: isGroundMove(c.move),
    drain: moveDrain(c.move),
    contact: moveContact(c.move),
    recoil: moveRecoil(c.move),
    setsHazard: hazardSecondaryOf(c.move),
    selfDrop: selfDropOf(c.move),
    foeDrop: foeDropOf(c.move),
  };
}
function cellFromOffense(attacker: PokemonSet, defender: OpponentEntry, field: FieldState, o: CellOpts = {}): Cell {
  return cellFrom(predictOffense({ attacker, opponent: defender, field, ...o }));
}
function cellFromThreat(attacker: OpponentEntry, defender: PokemonSet, field: FieldState, o: CellOpts = {}): Cell {
  return cellFrom(predictThreat({ opponent: attacker, defender, field, ...o }));
}

// Spe stat-stage multiplier. +n → (2+n)/2, −n → 2/(2+|n|). Folded into the
// base speed used for turn order (a stat-level change, like nature/EVs).
// Stat-stage multiplier for a regular stat (Atk/Def/SpA/SpD/Spe): +n → (2+n)/2,
// −n → 2/(2+|n|). Damage scales ~linearly with Atk and ~inversely with Def, so a
// boost's effect on a precomputed cell is the RATIO of the new/old multipliers.
function statStageMult(stage: number | undefined): number {
  const n = stage ?? 0;
  if (n === 0) return 1;
  return n > 0 ? (2 + n) / 2 : 2 / (2 - n);
}
const speStageMult = statStageMult; // back-compat alias (Spe uses the same curve)

// Damage scale factor applied to a precomputed cell when the live boost stage
// DIFFERS from the level baked into the cell. Offensive (Atk/SpA) scales up with
// the attacker's stage; defensive (Def/SpD) scales down with the defender's. The
// ratio is exactly 1 when no boost changed, so positions without setup are
// numerically identical to before. An approximation (ignores the formula's +2 /
// rounding) but well within the roll envelope the search already collapses.
function boostDamageScale(
  attacker: BoostMap | undefined, attackerBaked: BoostMap | undefined,
  defender: BoostMap | undefined, defenderBaked: BoostMap | undefined,
  physical: boolean,
  // Unaware: a defender with it ignores the ATTACKER's offensive boosts; an attacker
  // with it ignores the DEFENDER's defensive boosts. The calc already bakes Unaware
  // for the input boosts, so the dynamic scale must match (offScale/defScale = 1).
  defenderUnaware = false, attackerUnaware = false,
): number {
  const off = physical ? 'atk' : 'spa';
  const def = physical ? 'def' : 'spd';
  const offScale = defenderUnaware ? 1 : statStageMult(attacker?.[off]) / statStageMult(attackerBaked?.[off]);
  const defScale = attackerUnaware ? 1 : statStageMult(defenderBaked?.[def]) / statStageMult(defender?.[def]);
  return offScale * defScale;
}

function movePriority(move: string): number {
  if (!move) return 0;
  const m = getMove(move) as { priority?: number } | undefined;
  return m?.priority ?? 0;
}

// Multi-hit moves (Dual Wingbeat, Bullet Seed, Rock Blast…) strike 2+ times, so
// they break through Focus Sash / Sturdy (the first hit drops the survival, the
// next KOs). Truthy `multihit` (a number or [min,max]) marks them.
function isMultiHit(move: string): boolean {
  if (!move) return false;
  return !!(getMove(move) as { multihit?: number | number[] } | undefined)?.multihit;
}


// Worst-case mega-forme speed for a species at L50 (max Spe investment, +Spe
// nature), or null if it can't mega. We don't know the opp's real EVs, so the
// conservative bound for "could it outspeed me after mega" is the cap.
export function megaMaxSpeed(species: string): number | null {
  const options = getMegaOptions(species);
  if (options.length === 0) return null;
  const maxSet: PokemonSet = {
    species, level: 50, nature: 'Jolly',
    evs: { ...ZERO_EVS, spe: 252 }, ivs: { ...MAX_IVS }, moves: [],
  };
  let best: number | null = null;
  for (const opt of options) {
    const spe = actualSpeed(maxSet, opt.forme);
    if (best == null || spe > best) best = spe;
  }
  return best;
}

// Opponent speed for the turn-order sort WITHOUT any mega bump (mega is now an
// explicit plan choice). Worst-case for me: ceiling outside Trick Room, floor
// under it.
function oppBaseSpeed(entry: OpponentEntry, field: FieldState): number {
  const r = effectiveSpeedRange(entry);
  if (r) return field.trickRoom ? r.min : r.max;
  return entry.candidates?.[0] ? actualSpeed(entry.candidates[0]!) : 100;
}

// The mega forme my mon would become IF it megas — only when it actually holds
// the matching stone. null otherwise.
function myMegaForme(set: PokemonSet): string | null {
  if (!set.item) return null;
  const itemId = toId(set.item);
  const match = getMegaOptions(set.species).find(o => toId(o.stone) === itemId);
  return match?.forme ?? null;
}

// The opponent's (assumed worst-case) mega forme + its stone, or null if the
// species has no mega. We don't know the opp's real item, so for the
// adversarial "could they mega" branch we assume they hold the stone.
function oppMegaInfo(species: string): { forme: string; stone: string } | null {
  const opts = getMegaOptions(species);
  return opts[0] ? { forme: opts[0].forme, stone: opts[0].stone } : null;
}

// Can this opponent actually Mega-Evolve? Only if it could plausibly be holding
// the matching stone. If we've committed a non-stone item, watched it consume an
// item, or every inferred candidate carries a known non-stone item, a mega is
// impossible — and assuming one anyway yields misleading verdicts (an Absol
// holding Scope Lens can't become Mega Absol). When the item is still unknown
// (no commit, no candidates) we keep the worst-case mega branch.
export function oppCanMega(entry: OpponentEntry): boolean {
  const info = oppMegaInfo(entry.species);
  if (!info) return false;
  if (entry.itemConsumed) return false;          // consumed a (non-stone) held item
  const stoneId = toId(info.stone);
  if (entry.item && toId(entry.item) !== stoneId) return false; // committed non-stone item
  const cands = entry.candidates;
  if (cands && cands.length && cands.every(c => c.item && toId(c.item) !== stoneId)) return false;
  return true;
}

// An opponent entry rewritten to hold its mega stone, so predict*'s
// gimmickActive path resolves the mega forme. Falls back to a default set when
// inference hasn't produced candidates yet.
function megaifyOppEntry(entry: OpponentEntry): OpponentEntry {
  const info = oppMegaInfo(entry.species);
  if (!info) return entry;
  const base = entry.candidates?.length ? entry.candidates : [defaultOpponentSet(entry, 50)];
  return { ...entry, candidates: base.map(c => ({ ...c, item: info.stone })) };
}

/** Which active (≤1 per side) is mega-evolved in a given search branch. */
interface MegaPlan { myMega: number | null; oppMega: number | null }

function buildTables(input: SearchInput, plan: MegaPlan): Tables {
  const mine = input.mine;
  const opp = input.opp;
  // My mon is mega in this branch if the plan megas it OR it already mega'd.
  const myMega = (mi: number) => mi === plan.myMega || !!mine[mi]!.megaActive;
  // Opp gimmick flag is only needed for the HYPOTHETICAL mega (plan.oppMega) —
  // an already-mega'd opp carries the mega forme in its candidates already, so
  // the calc uses mega stats without the flag.
  const oppHypoMega = (oj: number) => oj === plan.oppMega;
  // Megaify only the hypothetical opp; already-mega'd opps are used as-is.
  const oppEntries = opp.map((o, j) => (j === plan.oppMega ? megaifyOppEntry(o.entry) : o.entry));
  // Aegislash Stance Change: an attacking Aegislash is in its Blade forme (high
  // offense). Swap the ATTACKER's species to Aegislash-Blade for the damage cells so
  // its attacks aren't underrated by Shield's 50 base offenses.
  const bladeSet = (set: PokemonSet): PokemonSet => bladeForme(set.species, set.ability) ? { ...set, species: 'Aegislash-Blade' } : set;
  const bladeEntry = (e: OpponentEntry): OpponentEntry => bladeForme(e.species, e.ability)
    ? { ...e, species: 'Aegislash-Blade', candidates: (e.candidates ?? []).map(c => ({ ...c, species: 'Aegislash-Blade' })) } : e;
  const off: Cell[][] = mine.map((m, mi) => oppEntries.map((oe, oj) =>
    cellFromOffense(bladeSet(m.set), oe, input.field, {
      attackerGimmickActive: myMega(mi),
      defenderGimmickActive: oppHypoMega(oj),
      attackerBoosts: m.boosts, attackerStatus: m.status,
      defenderBoosts: opp[oj]!.boosts, defenderStatus: opp[oj]!.status,
    })));
  const thr: Cell[][] = oppEntries.map((oe, oj) => mine.map((m, mi) =>
    cellFromThreat(bladeEntry(oe), m.set, input.field, {
      attackerGimmickActive: oppHypoMega(oj),
      defenderGimmickActive: myMega(mi),
      attackerBoosts: opp[oj]!.boosts, attackerStatus: opp[oj]!.status,
      defenderBoosts: m.boosts, defenderStatus: m.status,
    })));
  const mySpread = mine.map((m, mi) => bestSpread(m, opp, input.field, {
    attackerGimmickActive: myMega(mi), defHypoMega: oppHypoMega,
  }));
  const mySpreadActors = new Set<number>();
  mySpread.forEach((s, i) => { if (s) mySpreadActors.add(i); });
  // Opp spread moves (Rock Slide / Blizzard / Earthquake …) hit ALL my actives
  // at once. Modeled symmetrically to mine so the maximin can pick the opp's
  // spread reply when it's worst for me. entryResolved carries the mega forme
  // for the hypothetical opp-mega branch.
  const oppSpread = opp.map((o, oj) => bestSpreadOpp(o, oppEntries[oj]!, mine, input.field, {
    attackerGimmickActive: oppHypoMega(oj), myMega,
  }));
  const oppSpreadActors = new Set<number>();
  oppSpread.forEach((s, i) => { if (s) oppSpreadActors.add(i); });
  // Pivot-move damage cells (U-turn etc.) — the pivot move specifically, vs each foe.
  const myPivotMoveArr = mine.map(m => findPivotMove(m.set.moves ?? []));
  const oppPivotMoveArr = opp.map(o => findPivotMove(o.entry.knownMoves));
  const myPivotCell: (Cell[] | null)[] = mine.map((m, mi) => {
    const pm = myPivotMoveArr[mi]; if (!pm) return null;
    const atk: PokemonSet = { ...m.set, moves: [pm] };
    return oppEntries.map((oe, oj) => cellFromOffense(atk, oe, input.field, {
      attackerGimmickActive: myMega(mi), defenderGimmickActive: oppHypoMega(oj),
      attackerBoosts: m.boosts, attackerStatus: m.status,
      defenderBoosts: opp[oj]!.boosts, defenderStatus: opp[oj]!.status,
    }));
  });
  const oppPivotCell: (Cell[] | null)[] = opp.map((o, oj) => {
    const pm = oppPivotMoveArr[oj]; if (!pm) return null;
    const synth: OpponentEntry = { ...oppEntries[oj]!, knownMoves: [pm] };
    return mine.map((m, mi) => cellFromThreat(synth, m.set, input.field, {
      attackerGimmickActive: oppHypoMega(oj), defenderGimmickActive: myMega(mi),
      attackerBoosts: o.boosts, attackerStatus: o.status,
      defenderBoosts: m.boosts, defenderStatus: m.status,
    }));
  });
  // Fake Out damage cells (the chip dealt alongside the flinch).
  const myFakeOutCell: (Cell[] | null)[] = mine.map((m, mi) => {
    if (!hasFakeOut(m.set.moves ?? [])) return null;
    const atk: PokemonSet = { ...m.set, moves: ['Fake Out'] };
    return oppEntries.map((oe, oj) => cellFromOffense(atk, oe, input.field, {
      attackerGimmickActive: myMega(mi), defenderGimmickActive: oppHypoMega(oj),
      attackerBoosts: m.boosts, attackerStatus: m.status, defenderBoosts: opp[oj]!.boosts, defenderStatus: opp[oj]!.status,
    }));
  });
  const oppFakeOutCell: (Cell[] | null)[] = opp.map((o, oj) => {
    if (!hasFakeOut(oppEntries[oj]!.knownMoves)) return null;
    const synth: OpponentEntry = { ...oppEntries[oj]!, knownMoves: ['Fake Out'] };
    return mine.map((m, mi) => cellFromThreat(synth, m.set, input.field, {
      attackerGimmickActive: oppHypoMega(oj), defenderGimmickActive: myMega(mi),
      attackerBoosts: o.boosts, attackerStatus: o.status, defenderBoosts: m.boosts, defenderStatus: m.status,
    }));
  });
  // Priority-attack cells: the best EFFECTIVE-priority (> 0) DAMAGING move vs each
  // foe. The max-damage off/thr cell hides priority moves whenever a stronger
  // normal move exists (Kingambit's Kowtow out-damages its Sucker Punch), so a
  // priority KO would be invisible without this. Fake Out / First Impression are
  // excluded (own cell + first-turn gating); status-priority moves (Protect/Detect)
  // aren't attacks. Effective priority folds in the conditional bumps —
  // Grassy Glide (Grassy Terrain) and Gale Wings (Flying move, full HP) — and the
  // chosen cell's stored priority is overridden to that effective value so the
  // turn-order sort in resolveTurn uses it.
  const isPrioCandidate = (mv: string): boolean =>
    !FIRST_TURN_MOVE_IDS.has(toId(mv)) && (getMove(mv) as { category?: string } | undefined)?.category !== 'Status';
  const ter: Terrain | null = input.field.terrain ?? null;
  const myPrioCell: (Cell | null)[][] = mine.map((m, mi) => {
    const eff = (mv: string) => effectiveAttackPriority(mv, m.set.ability, m.hpPercent, ter);
    const pri = (m.set.moves ?? []).filter(mv => isPrioCandidate(mv) && eff(mv) > 0);
    if (!pri.length) return oppEntries.map(() => null);
    const atk: PokemonSet = { ...bladeSet(m.set), moves: pri };
    return oppEntries.map((oe, oj) => {
      const c = cellFromOffense(atk, oe, input.field, {
        attackerGimmickActive: myMega(mi), defenderGimmickActive: oppHypoMega(oj),
        attackerBoosts: m.boosts, attackerStatus: m.status,
        defenderBoosts: opp[oj]!.boosts, defenderStatus: opp[oj]!.status,
      });
      return c.dmgMax > 0 ? { ...c, priority: eff(c.move) } : null;
    });
  });
  const oppPrioCell: (Cell | null)[][] = opp.map((o, oj) => {
    const eff = (mv: string) => effectiveAttackPriority(mv, oppEntries[oj]!.ability, o.hpPercent, ter);
    // Same move source as the main threat cell: known moves, else the Pikalytics
    // likely pool (so a meta Sucker Punch is modelled before it's been revealed).
    const pool = oppEntries[oj]!.knownMoves.length ? oppEntries[oj]!.knownMoves : pikalyticsMoves(oppEntries[oj]!.species);
    const pri = pool.filter(mv => isPrioCandidate(mv) && eff(mv) > 0);
    if (!pri.length) return mine.map(() => null);
    const synth: OpponentEntry = { ...bladeEntry(oppEntries[oj]!), knownMoves: pri };
    return mine.map((m, mi) => {
      const c = cellFromThreat(synth, m.set, input.field, {
        attackerGimmickActive: oppHypoMega(oj), defenderGimmickActive: myMega(mi),
        attackerBoosts: o.boosts, attackerStatus: o.status,
        defenderBoosts: m.boosts, defenderStatus: m.status,
      });
      return c.dmgMax > 0 ? { ...c, priority: eff(c.move) } : null;
    });
  });
  return {
    tt: new Map(),
    myN: mine.length,
    oppN: opp.length,
    mySpecies: mine.map(m => m.set.species),
    oppSpecies: opp.map(o => o.entry.species),
    // Spe stat stage folds into the base speed (a stat-level change); Tailwind
    // and paralysis are applied at sort time in resolveTurn.
    mySpeed: mine.map((m, mi) => actualSpeed(m.set, myMega(mi) ? (myMegaForme(m.set) ?? undefined) : undefined) * speStageMult(m.boosts?.spe)),
    // Hypothetical opp mega → mega-speed cap; otherwise oppBaseSpeed, which
    // already returns mega speed for an already-mega'd opp (effectiveSpeedRange
    // keys off its mega forme).
    oppSpeed: opp.map((o, oj) => (oj === plan.oppMega ? (megaMaxSpeed(o.entry.species) ?? oppBaseSpeed(o.entry, input.field)) : oppBaseSpeed(o.entry, input.field)) * speStageMult(o.boosts?.spe)),
    myPar: mine.map(m => m.status === 'par'),
    oppPar: opp.map(o => o.status === 'par'),
    off, thr, mySpread, mySpreadActors, oppSpread, oppSpreadActors,
    myProtectMove: mine.map(m => findProtectMove(m.set.moves ?? [])),
    // Opp protect: only offer it in the search when the opp has REVEALED a
    // protect variant (opp-conservatism rule — we don't model unseen moves).
    oppProtectMove: opp.map(o => findProtectMove(o.entry.knownMoves)),
    // Order field moves. Mine come from the real moveset; the opp's only from
    // REVEALED moves (same opp-conservatism — we don't assume an unseen Tailwind
    // / Trick Room).
    myTailwindMove: mine.map(m => findMoveId(m.set.moves ?? [], 'tailwind')),
    oppTailwindMove: opp.map(o => findMoveId(o.entry.knownMoves, 'tailwind')),
    myTrickRoomMove: mine.map(m => findMoveId(m.set.moves ?? [], 'trickroom')),
    oppTrickRoomMove: opp.map(o => findMoveId(o.entry.knownMoves, 'trickroom')),
    myLeechMove: mine.map(m => findMoveId(m.set.moves ?? [], 'leechseed')),
    oppLeechMove: opp.map(o => findMoveId(o.entry.knownMoves, 'leechseed')),
    myMaxHp: mine.map(m => maxHpFor(m.set)),
    oppMaxHp: opp.map(o => maxHpFor(o.entry.candidates?.[0] ?? defaultOpponentSet(o.entry, 50))),
    myGrass: mine.map(m => isGrassType(m.set.species)),
    oppGrass: opp.map(o => isGrassType(o.entry.species)),
    myBaked: mine.map(m => ({ ...(m.boosts as BoostMap | undefined) })),
    oppBaked: opp.map(o => ({ ...(o.boosts as BoostMap | undefined) })),
    mySetup: mine.map(m => findSetupMove(m.set.moves ?? [])?.boosts ?? null),
    oppSetup: opp.map(o => findSetupMove(o.entry.knownMoves)?.boosts ?? null),
    mySetupMove: mine.map(m => findSetupMove(m.set.moves ?? [])?.move ?? null),
    oppSetupMove: opp.map(o => findSetupMove(o.entry.knownMoves)?.move ?? null),
    myBatonMove: mine.map(m => findMoveId(m.set.moves ?? [], 'batonpass')),
    oppBatonMove: opp.map(o => findMoveId(o.entry.knownMoves, 'batonpass')),
    mySpeedBoost: mine.map(m => hasSpeedBoost(m.set.ability)),
    oppSpeedBoost: opp.map(o => hasSpeedBoost(o.entry.ability)),
    myIntimidate: mine.map(m => hasIntimidate(m.set.ability)),
    oppIntimidate: opp.map(o => hasIntimidate(o.entry.ability)),
    myStatDropImmune: mine.map(m => statDropImmune(m.set.ability, m.set.item)),
    oppStatDropImmune: opp.map(o => statDropImmune(o.entry.ability, o.entry.item)),
    myDefiantStat: mine.map(m => defiantStat(m.set.ability)),
    oppDefiantStat: opp.map(o => defiantStat(o.entry.ability)),
    myUnaware: mine.map(m => toId(m.set.ability ?? '') === 'unaware'),
    oppUnaware: opp.map(o => toId(o.entry.ability ?? '') === 'unaware'),
    myOnKo: mine.map(m => onKoBoost(m.set, m.set.ability)),
    oppOnKo: opp.map(o => onKoBoost(o.entry.candidates?.[0] ?? defaultOpponentSet(o.entry, 50), o.entry.ability)),
    myLifeOrb: mine.map(m => takesLifeOrbRecoil(m.set.item, m.set.ability)),
    oppLifeOrb: opp.map(o => takesLifeOrbRecoil(o.entry.item, o.entry.ability)),
    myRedirectMove: mine.map(m => findRedirectMove(m.set.moves ?? [])),
    oppRedirectMove: opp.map(o => findRedirectMove(o.entry.knownMoves)),
    myPivotMove: myPivotMoveArr,
    oppPivotMove: oppPivotMoveArr,
    myPivotCell, oppPivotCell,
    myPivotDebuff: myPivotMoveArr.map(pm => pm ? pivotDebuff(pm) : null),
    oppPivotDebuff: oppPivotMoveArr.map(pm => pm ? pivotDebuff(pm) : null),
    myDebuffMove: mine.map(m => findDebuffMove(m.set.moves ?? [])),
    oppDebuffMove: opp.map(o => findDebuffMove(o.entry.knownMoves)),
    myTauntMove: mine.map(m => findTauntMove(m.set.moves ?? [])),
    oppTauntMove: opp.map(o => findTauntMove(o.entry.knownMoves)),
    myEncoreMove: mine.map(m => findEncoreMove(m.set.moves ?? [])),
    oppEncoreMove: opp.map(o => findEncoreMove(o.entry.knownMoves)),
    myResistBerryType: mine.map(m => resistBerryType(m.set.item)),
    oppResistBerryType: opp.map(o => resistBerryType(o.entry.item)),
    myHasUnburden: mine.map(m => hasUnburden(m.set.ability)),
    oppHasUnburden: opp.map(o => hasUnburden(o.entry.ability)),
    myWhiteHerb: mine.map(m => isWhiteHerb(m.set.item)),
    oppWhiteHerb: opp.map(o => isWhiteHerb(o.entry.item)),
    myChoice: mine.map(m => isChoiceItem(m.set.item)),
    oppChoice: opp.map(o => isChoiceItem(o.entry.item)),
    myHasFakeOut: mine.map(m => hasFakeOut(m.set.moves ?? [])),
    oppHasFakeOut: opp.map(o => hasFakeOut(o.entry.knownMoves)),
    myFakeOutCell, oppFakeOutCell,
    myHelpingHand: mine.map(m => hasHelpingHand(m.set.moves ?? [])),
    oppHelpingHand: opp.map((o, oj) => hasHelpingHand(oppEntries[oj]!.knownMoves)),
    myWideGuard: mine.map(m => hasWideGuard(m.set.moves ?? [])),
    oppWideGuard: opp.map((o, oj) => hasWideGuard(oppEntries[oj]!.knownMoves)),
    myQuickGuard: mine.map(m => hasQuickGuard(m.set.moves ?? [])),
    oppQuickGuard: opp.map((o, oj) => hasQuickGuard(oppEntries[oj]!.knownMoves)),
    myStrengthSap: mine.map(m => hasStrengthSap(m.set.moves ?? [])),
    oppStrengthSap: opp.map((o, oj) => hasStrengthSap(oppEntries[oj]!.knownMoves)),
    myHasSubMove: mine.map(m => hasSubstitute(m.set.moves ?? [])),
    oppHasSubMove: opp.map((o, oj) => hasSubstitute(oppEntries[oj]!.knownMoves)),
    myCounter: mine.map(m => findCounterMove(m.set.moves ?? [])),
    oppCounter: opp.map((o, oj) => findCounterMove(oppEntries[oj]!.knownMoves)),
    myRoomMove: mine.map(m => findRoomMove(m.set.moves ?? [])),
    oppRoomMove: opp.map((o, oj) => findRoomMove(oppEntries[oj]!.knownMoves)),
    myWp: mine.map(m => holdsWeaknessPolicy(m.set.item)),
    oppWp: opp.map(o => holdsWeaknessPolicy(o.entry.item)),
    myHazardClear: mine.map(m => findHazardClear(m.set.moves ?? [])),
    oppHazardClear: opp.map((o, oj) => findHazardClear(oppEntries[oj]!.knownMoves)),
    myAtkStat: mine.map(m => actualStat(m.set, 'atk')),
    oppAtkStat: opp.map(o => actualStat(o.entry.candidates?.[0] ?? defaultOpponentSet(o.entry, 50), 'atk')),
    myPrioCell, oppPrioCell,
    myFlinchImmune: mine.map(m => flinchImmune(m.set.ability, m.set.item)),
    oppFlinchImmune: opp.map(o => flinchImmune(o.entry.ability, o.entry.item)),
    myIntimImmune: mine.map(m => intimidateImmune(m.set.ability, m.set.item)),
    oppIntimImmune: opp.map(o => intimidateImmune(o.entry.ability, o.entry.item)),
    myRockHead: mine.map(m => hasRockHead(m.set.ability)),
    oppRockHead: opp.map(o => hasRockHead(o.entry.ability)),
    myRegen: mine.map(m => hasRegenerator(m.set.ability)),
    oppRegen: opp.map(o => hasRegenerator(o.entry.ability)),
    myScreen: mine.map(m => findScreenMove(m.set.moves ?? [])),
    oppScreen: opp.map(o => findScreenMove(o.entry.knownMoves)),
    myRock: mine.map(m => isType(m.set.species, 'Rock')),
    oppRock: opp.map(o => isType(o.entry.species, 'Rock')),
    myIce: mine.map(m => isType(m.set.species, 'Ice')),
    oppIce: opp.map(o => isType(o.entry.species, 'Ice')),
    mySpeedWeather: mine.map(m => speedWeatherForAbility(m.set.ability)),
    oppSpeedWeather: opp.map(o => plausibleSpeedWeather(o.entry.ability, o.entry.species)),
    myWeatherMove: mine.map(m => findWeatherMove(m.set.moves ?? [])),
    oppWeatherMove: opp.map(o => findWeatherMove(o.entry.knownMoves)),
    myWeatherAbility: mine.map(m => weatherSetByAbility(m.set.ability)),
    oppWeatherAbility: opp.map(o => weatherSetByAbility(o.entry.ability)),
    myGrounded: mine.map(m => isGrounded(m.set.species, m.set.ability)),
    oppGrounded: opp.map(o => isGrounded(o.entry.species, o.entry.ability)),
    myTerrainMove: mine.map(m => findTerrainMove(m.set.moves ?? [])),
    oppTerrainMove: opp.map(o => findTerrainMove(o.entry.knownMoves)),
    myTerrainAbility: mine.map(m => terrainSetByAbility(m.set.ability)),
    oppTerrainAbility: opp.map(o => terrainSetByAbility(o.entry.ability)),
    myResidual: mine.map(m => residualInfo(m.set.species, m.set.ability, m.set.item, m.status)),
    oppResidual: opp.map(o => residualInfo(o.entry.species, o.entry.ability, o.entry.item, o.status)),
    myStatusMove: mine.map(m => findStatusMove(m.set.moves ?? [])),
    oppStatusMove: opp.map(o => findStatusMove(o.entry.knownMoves)),
    myAbility: mine.map(m => m.set.ability),
    oppAbility: opp.map(o => o.entry.ability),
    myRecover: mine.map(m => findRecoverMove(m.set.moves ?? [])),
    oppRecover: opp.map(o => findRecoverMove(o.entry.knownMoves)),
    myItem: mine.map(m => m.set.item ?? undefined),
    oppItem: opp.map(o => o.entry.item ?? undefined),
    myHazardMove: mine.map(m => findHazardMove(m.set.moves ?? [])),
    oppHazardMove: opp.map(o => findHazardMove(o.entry.knownMoves)),
    myContactChip: mine.map(m => contactChipFor(m.set.ability, m.set.item)),
    oppContactChip: opp.map(o => contactChipFor(o.entry.ability, o.entry.item)),
    field: input.field,
  };
}

function initialState(input: SearchInput): State {
  const myActive: number[] = [];
  const oppActive: number[] = [];
  input.mine.forEach((m, i) => { if (m.active && m.hpPercent > 0) myActive.push(i); });
  input.opp.forEach((o, i) => { if (o.active && o.hpPercent > 0) oppActive.push(i); });
  return {
    myHp: input.mine.map(m => m.hpPercent),
    oppHp: input.opp.map(o => o.hpPercent),
    myActive: myActive.slice(0, MAX_ACTIVE),
    oppActive: oppActive.slice(0, MAX_ACTIVE),
    myProtectStreak: input.mine.map(() => 0),
    oppProtectStreak: input.opp.map(() => 0),
    oppSeen: input.opp.map(o => !o.phantom),
    trickRoom: !!input.field.trickRoom,
    myTailwind: !!input.field.myTailwind,
    theirTailwind: !!input.field.theirTailwind,
    trickRoomTurns: input.field.trickRoomTurns,
    myTailwindTurns: input.field.myTailwindTurns,
    theirTailwindTurns: input.field.theirTailwindTurns,
    mySeeded: input.mine.map(m => m.seededBy ?? null),
    oppSeeded: input.opp.map(o => o.seededBy ?? null),
    myBoost: input.mine.map(m => ({ ...(m.boosts as BoostMap | undefined) })),
    oppBoost: input.opp.map(o => ({ ...(o.boosts as BoostMap | undefined) })),
    myReflect: !!input.field.myReflect,
    myLightScreen: !!input.field.myLightScreen,
    theirReflect: !!input.field.theirReflect,
    theirLightScreen: !!input.field.theirLightScreen,
    myReflectTurns: input.field.myReflectTurns,
    myLightScreenTurns: input.field.myLightScreenTurns,
    theirReflectTurns: input.field.theirReflectTurns,
    theirLightScreenTurns: input.field.theirLightScreenTurns,
    weather: input.field.weather ?? null,
    weatherTurns: input.field.weatherTurns,
    terrain: input.field.terrain ?? null,
    terrainTurns: input.field.terrainTurns,
    myToxicN: input.mine.map(m => (m.status === 'tox' ? 1 : 0)),
    oppToxicN: input.opp.map(o => (o.status === 'tox' ? 1 : 0)),
    myStatus: input.mine.map(m => m.status ?? ''),
    oppStatus: input.opp.map(o => o.status ?? ''),
    // A consumed item (Sitrus already eaten, Knock Off'd, …) can't fire again.
    myBerryUsed: input.mine.map(m => !m.set.item),
    oppBerryUsed: input.opp.map(o => !!o.entry.itemConsumed || !o.entry.item),
    myHazards: { ...(input.field.myHazards ?? {}) },
    oppHazards: { ...(input.field.theirHazards ?? {}) },
    // A mon already asleep at the root: we don't know the remaining count, so assume
    // ~2 turns (the middle of Gen 9's 1-3).
    mySleepTurns: input.mine.map(m => (m.status === 'slp' ? 2 : 0)),
    oppSleepTurns: input.opp.map(o => (o.status === 'slp' ? 2 : 0)),
    // Taunt/Encore volatiles aren't carried on SearchInput yet → start clear.
    myTaunt: input.mine.map(() => 0),
    oppTaunt: input.opp.map(() => 0),
    myEncore: input.mine.map(() => 0),
    oppEncore: input.opp.map(() => 0),
    myEncoreAct: input.mine.map(() => NONE),
    oppEncoreAct: input.opp.map(() => NONE),
    myUnburden: input.mine.map(() => false),
    oppUnburden: input.opp.map(() => false),
    myResistBerryUsed: input.mine.map(() => false),
    oppResistBerryUsed: input.opp.map(() => false),
    myFirstTurn: input.mine.map(m => !!m.firstTurnOut),
    oppFirstTurn: input.opp.map(o => !!o.firstTurnOut),
    myDisguise: input.mine.map(m => hasDisguise(m.set.ability)),
    oppDisguise: input.opp.map(o => hasDisguise(o.entry.ability)),
    myRecharge: input.mine.map(() => false),
    oppRecharge: input.opp.map(() => false),
    myLocked: input.mine.map(() => 0),
    oppLocked: input.opp.map(() => 0),
    mySubHp: input.mine.map(m => m.subHpPercent ?? 0),
    oppSubHp: input.opp.map(o => o.subHpPercent ?? 0),
    myWish: input.mine.map(() => 0),
    oppWish: input.opp.map(() => 0),
    myFutureTurns: input.mine.map(() => 0),
    oppFutureTurns: input.opp.map(() => 0),
    myFutureDmg: input.mine.map(() => 0),
    oppFutureDmg: input.opp.map(() => 0),
    gravity: !!input.field.gravity,
    wonderRoom: !!input.field.wonderRoom,
    magicRoom: !!input.field.magicRoom,
    gravityTurns: input.field.gravityTurns,
    wonderRoomTurns: input.field.wonderRoomTurns,
    magicRoomTurns: input.field.magicRoomTurns,
  };
}

// Disguise (Mimikyu) / Ice Face (Eiscue): the first damaging hit is absorbed,
// then the forme breaks. Seeded intact for a holder.
function hasDisguise(ability: string | null | undefined): boolean {
  const id = toId(ability ?? '');
  return id === 'disguise' || id === 'iceface';
}

// Recharge moves (Hyper Beam family): the user can't act the turn AFTER using one.
const RECHARGE_MOVES: ReadonlySet<string> = new Set([
  'hyperbeam', 'gigaimpact', 'roaroftime', 'prismaticlaser', 'eternabeam',
  'frenzyplant', 'hydrocannon', 'blastburn', 'rockwrecker', 'gigatonhammer',
]);
function isRechargeMove(move: string | null | undefined): boolean {
  return RECHARGE_MOVES.has(toId(move ?? ''));
}

// Locked multi-turn moves (Outrage family): the user is locked into attacking for
// 2 more turns (can't switch / setup / protect), then becomes confused.
const LOCKED_MOVES: ReadonlySet<string> = new Set(['outrage', 'petaldance', 'thrash', 'ragingfury']);
function isLockedMove(move: string | null | undefined): boolean {
  return LOCKED_MOVES.has(toId(move ?? ''));
}

function hasSubstitute(moves: string[]): boolean {
  return moves.some(m => toId(m) === 'substitute');
}

// Field rooms a mon can set. NOTE: the search models SETTING + tracking + stall-out
// of a room; the room's DAMAGE effect (Wonder Room Def/SpD swap, Magic Room item
// suppression, Gravity's Ground-immunity removal) is baked into the cells at root,
// so a mid-search cast doesn't retro-adjust damage — only Gravity's hazard-grounding
// (a non-damage effect) is applied live. (Full damage recompute = the GPU phase.)
type RoomKind = 'gravity' | 'wonderRoom' | 'magicRoom';
function findRoomMove(moves: string[]): RoomKind | null {
  for (const m of moves) {
    const id = toId(m);
    if (id === 'gravity') return 'gravity';
    if (id === 'wonderroom') return 'wonderRoom';
    if (id === 'magicroom') return 'magicRoom';
  }
  return null;
}

// Future Sight / Doom Desire: a damaging move that lands 2 turns AFTER it's used,
// on the targeted slot. Modelled as a scheduled hit (no damage the turn it's cast).
function isFutureMove(move: string | null | undefined): boolean {
  const id = toId(move ?? '');
  return id === 'futuresight' || id === 'doomdesire';
}

// Counter / Mirror Coat / Metal Burst: deal back a multiple of the damage taken
// this turn (Counter ← physical, Mirror Coat ← special, Metal Burst ← either).
interface CounterMove { mult: number; cat: 'phys' | 'spec' | 'any' }
function findCounterMove(moves: string[]): CounterMove | null {
  for (const m of moves) {
    const id = toId(m);
    if (id === 'counter') return { mult: 2, cat: 'phys' };
    if (id === 'mirrorcoat') return { mult: 2, cat: 'spec' };
    if (id === 'metalburst') return { mult: 1.5, cat: 'any' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Turn resolution
// ---------------------------------------------------------------------------

// Effective speed with field modifiers. Tailwind doubles; paralysis halves;
// Trick Room is handled at sort time (we invert the comparison), not here. The
// Spe stat stage is already folded into `base`.
function effSpeed(base: number, tailwind: boolean, paralyzed: boolean): number {
  return base * (tailwind ? 2 : 1) * (paralyzed ? 0.5 : 1);
}

// Does opp active `oj` move before my active `mi` this turn (ignoring move
// priority — used for "can it KO/flinch me before I act"). Trick Room inverts.
function oppOutspeeds(t: Tables, s: State, oj: number, mi: number): boolean {
  const myS = effSpeed(t.mySpeed[mi]!, s.myTailwind, t.myPar[mi]!);
  const oppS = effSpeed(t.oppSpeed[oj]!, s.theirTailwind, t.oppPar[oj]!);
  return s.trickRoom ? oppS < myS : oppS > myS;
}

interface Acting { side: 'mine' | 'opp'; actor: number; target: number; priority: number; speed: number }

// Pure per-turn helpers hoisted to module scope so they're defined ONCE instead of
// recreated (and re-`__name`d under tsx) on every one of ~1.5M resolveTurn calls.
// Each takes all its inputs as parameters / uses only module-scope helpers, so the
// call sites inside resolveTurn are unchanged.
const accDrop = (m: Map<number, BoostMap>, idx: number, d: BoostMap) => m.set(idx, addBoosts(m.get(idx) ?? {}, d));
const redirect = (target: number, defSwitch: Map<number, number>) => defSwitch.get(target) ?? target;
const burnMult = (status: string, physical: boolean) => (status === 'brn' && physical ? 0.5 : 1);
const powderImmune = (species: string, ability: string | null | undefined) => isType(species, 'Grass') || toId(ability ?? '') === 'overcoat';
const lockable = (act: number | undefined): act is number => act != null && !isSwitchTarget(act) && !isBatonTarget(act) && !isPivotTarget(act) && act !== SLEEP_SKIP;
const hasNeg = (b: BoostMap) => (['atk', 'def', 'spa', 'spd', 'spe'] as const).some(k => (b[k] ?? 0) < 0);
const isEjectItem = (item: string | undefined) => { const id = toId(item ?? ''); return id === 'ejectbutton' || id === 'ejectpack'; };
const isRedCardItem = (item: string | undefined) => toId(item ?? '') === 'redcard';
const tick = (active: boolean, turns: number | undefined): [boolean, number | undefined] => {
  if (active && turns != null) { const t = turns - 1; return t <= 0 ? [false, undefined] : [true, t]; }
  return [active, turns];
};

// Resolve one turn given each side's target assignment (active index → enemy
// index, or SPREAD/PROTECT sentinel). Returns a NEW state; inputs are not mutated.
function resolveTurn(
  t: Tables,
  s: State,
  myTargets: Map<number, number>,
  oppTargets: Map<number, number>,
  pass: Pass,
): State {
  const myHp = s.myHp.slice();
  const oppHp = s.oppHp.slice();
  // Live side hazards — mutable so a setting move/attack THIS turn lays a layer
  // that a refill-in eats at EOT. Switch-ins (start of turn) still read the
  // START-of-turn hazards (s.my/oppHazards) below.
  let myHazards = { ...s.myHazards };
  let oppHazards = { ...s.oppHazards };
  // Resist-berry-spent + Unburden flags (mutated this turn, read NEXT ply by the
  // damage/speed helpers above — consistent with the apply-next-ply pattern).
  const myResistBerryUsed = s.myResistBerryUsed.slice();
  const oppResistBerryUsed = s.oppResistBerryUsed.slice();
  const myUnburden = s.myUnburden.slice();
  const oppUnburden = s.oppUnburden.slice();
  // New long-tail mechanic state (mutated below; defaults to a pass-through clone).
  const myDisguise = s.myDisguise.slice();
  const oppDisguise = s.oppDisguise.slice();
  const myRecharge = s.myRecharge.map(() => false);   // recharge is consumed this turn (see below)
  const oppRecharge = s.oppRecharge.map(() => false);
  const myLocked = s.myLocked.slice();
  const oppLocked = s.oppLocked.slice();
  const mySubHp = s.mySubHp.slice();
  const oppSubHp = s.oppSubHp.slice();
  const myWish = s.myWish.slice();
  const oppWish = s.oppWish.slice();
  const myFutureTurns = s.myFutureTurns.slice();
  const oppFutureTurns = s.oppFutureTurns.slice();
  const myFutureDmg = s.myFutureDmg.slice();
  const oppFutureDmg = s.oppFutureDmg.slice();
  // Self-stat-drops a mon's own move inflicts on it this turn (Draco Meteor −2 SpA
  // …), applied to the user's boosts at end of turn. actor index → drop map.
  const mySelfDrop = new Map<number, BoostMap>();
  const oppSelfDrop = new Map<number, BoostMap>();
  // Foe stat-drops a move inflicts on its TARGET this turn (Icy Wind −1 Spe …),
  // accumulated per DEFENDER index (multiple hits stack), applied at end of turn.
  const myToFoeDrop = new Map<number, BoostMap>();   // drops I put on opp mons (opp index → drop)
  const oppToFoeDrop = new Map<number, BoostMap>();   // drops opp puts on my mons (my index → drop)  // Weakness Policy: a holder that SURVIVES a super-effective hit gets +2 Atk/+2 SpA
  // (once, applied at end of turn → boosts NEXT ply, the search's main lever).
  const myWpProc = new Set<number>();
  const oppWpProc = new Set<number>();
  const procWp = (side: 'mine' | 'opp', idx: number, moveType: string) => {
    const hp = side === 'mine' ? myHp : oppHp;
    if ((hp[idx] ?? 0) <= 0) return;                  // fainted → no proc
    const has = side === 'mine' ? t.myWp[idx] : t.oppWp[idx];
    const species = side === 'mine' ? t.mySpecies[idx]! : t.oppSpecies[idx]!;
    if (has && isSuperEffectiveOn(species, moveType)) (side === 'mine' ? myWpProc : oppWpProc).add(idx);
  };
  // Protect-variant on-contact punish deferred to the status pass (poison/burn).
  const myPunishStatus = new Map<number, string>();   // my attacker statused by an OPP protect
  const oppPunishStatus = new Map<number, string>();  // opp attacker statused by MY protect
  // Apply a Protect-variant's on-contact punish to `attacker` on `side` (its CONTACT
  // move was blocked by the protecting foe). Drops route through the foe-drop
  // accumulators (Defiant / immunity apply); chip is direct; status is deferred.
  const applyProtectPunish = (move: string | null | undefined, side: 'mine' | 'opp', attacker: number) => {
    const p = protectPunish(move); if (!p) return;
    if (p.drop) accDrop(side === 'mine' ? oppToFoeDrop : myToFoeDrop, attacker, p.drop);
    if (p.chip != null) {
      const hp = side === 'mine' ? myHp : oppHp;
      const mg = (side === 'mine' ? t.myResidual[attacker] : t.oppResidual[attacker])?.magicGuard;
      if (!mg) hp[attacker] = Math.max(0, (hp[attacker] ?? 0) - p.chip);
    }
    if (p.status) (side === 'mine' ? myPunishStatus : oppPunishStatus).set(attacker, p.status);
  };
  // KOs each attacker scored this turn → on-KO ability boost (Moxie/Beast Boost),
  // applied ×count at end of turn. actor index → KO count.
  const myKoCount = new Map<number, number>();
  const oppKoCount = new Map<number, number>();
  // Counter / Mirror Coat / Metal Burst: the single biggest hit each mon took this
  // turn (attacker index, damage dealt, was-it-physical) — the reflect target.
  const myBigHit = new Map<number, { atk: number; dmg: number; phys: boolean }>();   // on MY mons (opp dealt it)
  const oppBigHit = new Map<number, { atk: number; dmg: number; phys: boolean }>();   // on OPP mons (I dealt it)
  const trackHit = (m: Map<number, { atk: number; dmg: number; phys: boolean }>, tgt: number, atk: number, dmg: number, phys: boolean) => {
    if (dmg <= 0) return;
    const cur = m.get(tgt);
    if (!cur || dmg > cur.dmg) m.set(tgt, { atk, dmg, phys });
  };
  const tr = s.trickRoom;            // THIS turn's order uses the current flags;
  const r = pass.regime;             // a Tailwind/TR set this turn applies NEXT ply.
  // Survival charges available this turn (Focus Sash / Sturdy), consumed on
  // first use. Only meaningful from full HP — enforced at apply time.
  const oppSurv = pass.survOpp.slice();
  const mySurv = pass.survMy.slice();

  // Voluntary switches resolve BEFORE any move (standard VGC ordering). Build
  // out→in maps and the post-switch active slots: a switching mon neither acts
  // nor is hit on its old index; the incoming mon occupies that slot and takes
  // any hit aimed there (no free dodge in doubles — switching into a resist is
  // the value, not avoiding the slot).
  // Switches AND Baton Pass both swap a slot to a bench mon; Baton Pass also
  // PASSES the outgoing mon's boosts (handled at end of turn). Both populate the
  // out→in maps so the active swap + hit-redirect work identically.
  const mySwitchIn = new Map<number, number>();
  const oppSwitchIn = new Map<number, number>();
  const myBaton = new Map<number, number>();   // out → in, only the Baton Pass ones
  const oppBaton = new Map<number, number>();
  // Pivot moves (U-turn/…): the user chips/debuffs a foe, then auto-switches out to
  // the best live bench mon (fast-pivot model — the bench mon is treated as in from
  // the start, like a regular switch; the chip is dealt before the main attack loop).
  const myPivotChip = new Map<number, number>();   // pivot user → foe to chip
  const oppPivotChip = new Map<number, number>();
  const pickBench = (taken: number[], hp: number[], n: number, dmgRows: Cell[][], foeHp: number[], eligible?: boolean[]): number | null => {
    const onField = new Set(taken);
    const liveFoes = foeHp.map((h, j) => (h > 0 ? j : -1)).filter(j => j >= 0);
    let best = -1, bestDmg = -1;
    for (let i = 0; i < n; i++) {
      if ((hp[i] ?? 0) <= 0 || onField.has(i)) continue;
      if (eligible && !eligible[i]) continue;
      const total = liveFoes.reduce((a, j) => a + (dmgRows[i]?.[j]?.dmgMid ?? 0), 0);
      if (total > bestDmg) { bestDmg = total; best = i; }
    }
    return best >= 0 ? best : null;
  };
  for (const [actor, target] of myTargets) {
    if (isSwitchTarget(target)) mySwitchIn.set(actor, switchBenchIdx(target));
    else if (isBatonTarget(target)) { const b = batonBenchIdx(target); mySwitchIn.set(actor, b); myBaton.set(actor, b); }
    else if (isPivotTarget(target)) {
      const bench = pickBench([...s.myActive, ...mySwitchIn.values()], myHp, t.myN, t.off, oppHp);
      if (bench != null) mySwitchIn.set(actor, bench);
      myPivotChip.set(actor, pivotFoeIdx(target));
    }
  }
  for (const [actor, target] of oppTargets) {
    if (isSwitchTarget(target)) oppSwitchIn.set(actor, switchBenchIdx(target));
    else if (isBatonTarget(target)) { const b = batonBenchIdx(target); oppSwitchIn.set(actor, b); oppBaton.set(actor, b); }
    else if (isPivotTarget(target)) {
      const bench = pickBench([...s.oppActive, ...oppSwitchIn.values()], oppHp, t.oppN, t.thr, myHp, s.oppSeen);
      if (bench != null) oppSwitchIn.set(actor, bench);
      oppPivotChip.set(actor, pivotFoeIdx(target));
    }
  }
  const myActiveNow = s.myActive.map(i => mySwitchIn.get(i) ?? i);
  const oppActiveNow = s.oppActive.map(i => oppSwitchIn.get(i) ?? i);
  // A hit aimed at a mon that switched out lands on its replacement instead.
  // Effective speed including the DYNAMIC Spe stage (Speed Boost / Dragon Dance)
  // AND a weather-speed ability (Chlorophyll/Swift Swim/… → ×2 in the matching
  // weather): scale the baked speed by the Spe-stage ratio, then the weather ×2.
  const nw = normWeather(s.weather);
  const myWeatherSpe = (i: number) => (t.mySpeedWeather[i] && t.mySpeedWeather[i] === nw ? 2 : 1);
  const oppWeatherSpe = (j: number) => (t.oppSpeedWeather[j] && t.oppSpeedWeather[j] === nw ? 2 : 1);
  const mySpe = (i: number) => t.mySpeed[i]! * (statStageMult(s.myBoost[i]?.spe) / statStageMult(t.myBaked[i]?.spe)) * myWeatherSpe(i) * (s.myUnburden[i] ? 2 : 1);
  const oppSpe = (j: number) => t.oppSpeed[j]! * (statStageMult(s.oppBoost[j]?.spe) / statStageMult(t.oppBaked[j]?.spe)) * oppWeatherSpe(j) * (s.oppUnburden[j] ? 2 : 1);
  // Dynamic paralysis (a status MOVE may have inflicted it mid-search).
  const myPar = (i: number) => s.myStatus[i] === 'par';
  const oppPar = (j: number) => s.oppStatus[j] === 'par';
  // Burn halves the ATTACKER's physical output: scale by live-vs-baked burn.
  const myBurnScale = (actor: number, physical: boolean) => burnMult(s.myStatus[actor]!, physical) / burnMult(t.myResidual[actor]!.status, physical);
  const oppBurnScale = (actor: number, physical: boolean) => burnMult(s.oppStatus[actor]!, physical) / burnMult(t.oppResidual[actor]!.status, physical);
  // Screen damage scale on the DEFENDER's side: live screen vs the one baked into
  // the cell. Reflect halves physical, Light Screen special. 1 when unchanged.
  const myScreenScale = (physical: boolean) =>           // I attack opp → opp's (their) side
    screenMult(physical ? s.theirReflect : s.theirLightScreen) / screenMult(physical ? !!t.field.theirReflect : !!t.field.theirLightScreen);
  const oppScreenScale = (physical: boolean) =>          // opp attacks me → my side
    screenMult(physical ? s.myReflect : s.myLightScreen) / screenMult(physical ? !!t.field.myReflect : !!t.field.myLightScreen);
  // Weather damage scale on the DEFENDER's side: live weather factor vs baked.
  const myWeatherScale = (type: string, physical: boolean, tgt: number) =>
    weatherDamageFactor(type, physical, t.oppRock[tgt]!, t.oppIce[tgt]!, s.weather) / weatherDamageFactor(type, physical, t.oppRock[tgt]!, t.oppIce[tgt]!, t.field.weather);
  const oppWeatherScale = (type: string, physical: boolean, tgt: number) =>
    weatherDamageFactor(type, physical, t.myRock[tgt]!, t.myIce[tgt]!, s.weather) / weatherDamageFactor(type, physical, t.myRock[tgt]!, t.myIce[tgt]!, t.field.weather);
  // Terrain damage scale: ×1.3 matching type for a grounded attacker, Grassy/Misty
  // reductions for a grounded defender — live terrain vs the baked one.
  const myTerrainScale = (type: string, gm: boolean, actor: number, tgt: number) =>
    terrainDamageFactor(type, gm, t.myGrounded[actor]!, t.oppGrounded[tgt]!, s.terrain) / terrainDamageFactor(type, gm, t.myGrounded[actor]!, t.oppGrounded[tgt]!, t.field.terrain);
  const oppTerrainScale = (type: string, gm: boolean, actor: number, tgt: number) =>
    terrainDamageFactor(type, gm, t.oppGrounded[actor]!, t.myGrounded[tgt]!, s.terrain) / terrainDamageFactor(type, gm, t.oppGrounded[actor]!, t.myGrounded[tgt]!, t.field.terrain);
  // Scale a precomputed roll by the live-vs-baked boost, screen, weather AND terrain
  // ratios (each 1 when unchanged → positions without dynamic effects are unaffected).
  // Resist-berry scale: once the berry is SPENT, a later hit of its (SE) type is no
  // longer halved → ×2 vs the baked cell. (1 until the berry is used.)
  const myResistScale = (tgt: number, type: string) => (s.oppResistBerryUsed[tgt] && type === t.oppResistBerryType[tgt]) ? 2 : 1;
  const oppResistScale = (tgt: number, type: string) => (s.myResistBerryUsed[tgt] && type === t.myResistBerryType[tgt]) ? 2 : 1;
  // Spend the resist berry the FIRST time a matching super-effective hit lands.
  const markResist = (used: boolean[], berryType: (string | null)[], tgt: number, moveType: string, defSpecies: string) => {
    if (used[tgt] || !moveType || berryType[tgt] !== moveType) return;
    const types = (getSpecies(defSpecies) as { types?: string[] } | undefined)?.types ?? [];
    if (effectiveness(moveType, types) > 1) used[tgt] = true;
  };
  // Helping Hand (+5, resolves before attacks): in doubles one partner is helped,
  // so a HELP_HAND action boosts the OTHER active on that side ×1.5 for the turn.
  // Folded into myDmg/oppDmg so it covers single-target, spread, priority and the
  // Fake Out chip uniformly. No live ally → no boost.
  const myHelped = new Set<number>();
  const oppHelped = new Set<number>();
  for (const [actor, target] of myTargets) {
    if (target !== HELP_HAND) continue;
    for (const ally of s.myActive) { if (ally === actor) continue; const occ = mySwitchIn.get(ally) ?? ally; if ((myHp[occ] ?? 0) > 0) myHelped.add(occ); }
  }
  for (const [actor, target] of oppTargets) {
    if (target !== HELP_HAND) continue;
    for (const ally of s.oppActive) { if (ally === actor) continue; const occ = oppSwitchIn.get(ally) ?? ally; if ((oppHp[occ] ?? 0) > 0) oppHelped.add(occ); }
  }
  const myDmg = (actor: number, tgt: number, raw: number, physical: boolean, type: string, gm: boolean) =>
    raw * boostDamageScale(s.myBoost[actor], t.myBaked[actor], s.oppBoost[tgt], t.oppBaked[tgt], physical, t.oppUnaware[tgt], t.myUnaware[actor]) * myScreenScale(physical) * myWeatherScale(type, physical, tgt) * myTerrainScale(type, gm, actor, tgt) * myBurnScale(actor, physical) * myResistScale(tgt, type) * (myHelped.has(actor) ? 1.5 : 1);
  const oppDmg = (actor: number, tgt: number, raw: number, physical: boolean, type: string, gm: boolean) =>
    raw * boostDamageScale(s.oppBoost[actor], t.oppBaked[actor], s.myBoost[tgt], t.myBaked[tgt], physical, t.myUnaware[tgt], t.oppUnaware[actor]) * oppScreenScale(physical) * oppWeatherScale(type, physical, tgt) * oppTerrainScale(type, gm, actor, tgt) * oppBurnScale(actor, physical) * oppResistScale(tgt, type) * (oppHelped.has(actor) ? 1.5 : 1);
  // Psychic Terrain makes priority moves FAIL against a grounded target.
  const psychicBlocked = (priority: number, defenderGrounded: boolean) => s.terrain === 'Psychic' && priority > 0 && defenderGrounded;

  // Asleep mons can't act (status 'slp' with turns left). Their joint action is the
  // SLEEP_SKIP no-op, but guard here too so a sleeping mon never executes a move (the
  // deeper-ply jointActions doesn't suppress them — this is the safety net).
  // "Can't act this turn": asleep (with turns left) OR frozen. Freeze thaws only
  // 20%/turn, so over the short search horizon we conservatively treat a frozen
  // mon as frozen throughout (it never gets a wake-decrement like sleep does).
  const myAsleep = (i: number) => (s.myStatus[i] === 'slp' && (s.mySleepTurns[i] ?? 0) > 0) || s.myStatus[i] === 'frz' || s.myRecharge[i] === true;
  const oppAsleep = (j: number) => (s.oppStatus[j] === 'slp' && (s.oppSleepTurns[j] ?? 0) > 0) || s.oppStatus[j] === 'frz' || s.oppRecharge[j] === true;

  // Build protected sets: a mon using PROTECT is immune to all damage this turn (an
  // asleep mon can't, even if a deep ply nominally offered it).
  const myProtected = new Set<number>();
  const oppProtected = new Set<number>();
  for (const [actor, target] of myTargets) { if (target === PROTECT && !myAsleep(actor)) myProtected.add(actor); }
  for (const [actor, target] of oppTargets) { if (target === PROTECT && !oppAsleep(actor)) oppProtected.add(actor); }
  // Wide Guard / Quick Guard are side-wide for the turn (a +3 protect that blocks the
  // FOES' spread / priority moves respectively). Active if any non-asleep mon used it.
  const sideUsed = (targets: Map<number, number>, code: number, asleep: (i: number) => boolean) => {
    for (const [a, tg] of targets) if (tg === code && !asleep(a)) return true;
    return false;
  };
  const myWideGuard = sideUsed(myTargets, WIDE_GUARD, myAsleep);
  const oppWideGuard = sideUsed(oppTargets, WIDE_GUARD, oppAsleep);
  const myQuickGuard = sideUsed(myTargets, QUICK_GUARD, myAsleep);
  const oppQuickGuard = sideUsed(oppTargets, QUICK_GUARD, oppAsleep);

  // Redirection (Follow Me / Rage Powder): a live user pulls the FOES' single-target
  // moves onto itself this turn. Rage Powder (a powder) is ignored by Grass-type /
  // Overcoat attackers. At most one redirector per side matters.
  const findRedirector = (targets: Map<number, number>, hp: number[]): number | null => {
    for (const [actor, tgt] of targets) if (tgt === REDIRECT && (hp[actor] ?? 0) > 0) return actor;
    return null;
  };
  const myRedirector = findRedirector(myTargets, myHp);
  const oppRedirector = findRedirector(oppTargets, oppHp);
  // Does an attacker on `side` get its single-target move pulled to the foe's redirector?
  const myRedirTarget = (oppActor: number): number | null => {
    if (myRedirector == null) return null;
    if (toId(t.myRedirectMove[myRedirector] ?? '') === 'ragepowder' && powderImmune(t.oppSpecies[oppActor]!, t.oppAbility[oppActor])) return null;
    return myRedirector;
  };
  const oppRedirTarget = (myActor: number): number | null => {
    if (oppRedirector == null) return null;
    if (toId(t.oppRedirectMove[oppRedirector] ?? '') === 'ragepowder' && powderImmune(t.mySpecies[myActor]!, t.myAbility[myActor])) return null;
    return oppRedirector;
  };

  // Apply `dmg` to hp[idx]; if it would be lethal FROM FULL HP and a survival
  // charge is available, clamp to 1 and consume it (Focus Sash / Sturdy). A
  // multi-hit move breaks through survival, so `breaks` skips the clamp.
  // Disguise (Mimikyu) / Ice Face (Eiscue): the first DAMAGING hit is absorbed by
  // the forme; Disguise then chips the holder 1/8 max HP, Ice Face 0. `dg`, when
  // present + intact, makes this hit deal only that chip and breaks the forme.
  // Defense context: a Substitute (absorbs the hit into its own HP) and/or a
  // Disguise/Ice Face (absorbs the first damaging hit, then breaks). Returns the
  // arrays so apply can mutate them. Sub is checked first (it stands in front).
  const myDg = (idx: number) => ({ arr: myDisguise, chip: toId(t.myAbility[idx] ?? '') === 'disguise' ? 100 / 8 : 0, sub: mySubHp });
  const oppDg = (idx: number) => ({ arr: oppDisguise, chip: toId(t.oppAbility[idx] ?? '') === 'disguise' ? 100 / 8 : 0, sub: oppSubHp });
  const apply = (hp: number[], idx: number, dmg: number, surv: boolean[], breaks: boolean, dg?: { arr: boolean[]; chip: number; sub: number[] }) => {
    if (dg && dmg > 0 && (dg.sub[idx] ?? 0) > 0) { dg.sub[idx] = Math.max(0, dg.sub[idx]! - dmg); return; } // sub absorbs the whole hit
    if (dg && dg.arr[idx] && dmg > 0) { dg.arr[idx] = false; hp[idx] = Math.max(0, hp[idx]! - dg.chip); return; }
    const before = hp[idx]!;
    const after = before - dmg;
    if (!breaks && after <= 0 && before >= 100 && surv[idx]) { surv[idx] = false; hp[idx] = 1; }
    else hp[idx] = Math.max(0, after);
  };

  // Switch / field / Leech / setup / screen / weather / terrain / status / recover / Baton: no direct damage.
  const nonAttack = (target: number) =>
    isSwitchTarget(target) || isBatonTarget(target) || isLeechTarget(target) || isStatusTarget(target) || isFieldTarget(target)
    || target === SET_BOOST || target === SET_SCREEN || target === SET_WEATHER || target === SET_TERRAIN || target === RECOVER || target === SET_HAZARD
    || target === REDIRECT || target === SLEEP_SKIP || target === HELP_HAND || target === WIDE_GUARD || target === QUICK_GUARD || target === SAP || target === CLEAR_HAZARD || target === SET_SUB || target === COUNTER || target === SET_ROOM || isPivotTarget(target) || isDebuffTarget(target)
    || isTauntTarget(target) || isEncoreTarget(target);
  // Fake Out flinches: a mon hit by Fake Out (resolved at +3 before it acts) skips
  // its action this turn.
  const myFlinched = new Set<number>();
  const oppFlinched = new Set<number>();
  const actings: Acting[] = [];
  for (const [actor, target] of myTargets) {
    if (nonAttack(target) || myAsleep(actor)) continue;
    const priority = target === SPREAD ? t.mySpread[actor]!.priority
      : target === PROTECT ? movePriority(t.myProtectMove[actor] ?? 'Protect')
      : isFakeOutTarget(target) ? 3
      : isPrioTarget(target) ? (t.myPrioCell[actor]?.[prioFoeIdx(target)]?.priority ?? 1)
      : t.off[actor]![target]!.priority;
    actings.push({ side: 'mine', actor, target, priority, speed: effSpeed(mySpe(actor), s.myTailwind, myPar(actor)) });
  }
  for (const [actor, target] of oppTargets) {
    if (nonAttack(target) || oppAsleep(actor)) continue;
    const priority = target === SPREAD ? t.oppSpread[actor]!.priority
      : target === PROTECT ? movePriority(t.oppProtectMove[actor] ?? 'Protect')
      : isFakeOutTarget(target) ? 3
      : isPrioTarget(target) ? (t.oppPrioCell[actor]?.[prioFoeIdx(target)]?.priority ?? 1)
      : t.thr[actor]![target]!.priority;
    actings.push({ side: 'opp', actor, target, priority, speed: effSpeed(oppSpe(actor), s.theirTailwind, oppPar(actor)) });
  }

  // Priority first (higher acts first), then speed (Trick Room inverts speed).
  actings.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return tr ? a.speed - b.speed : b.speed - a.speed;
  });

  // Pivot chips (U-turn/Volt Switch/Parting Shot): the pivot user (already switched
  // out via mySwitchIn) deals its move's damage + debuff to a foe as it leaves.
  // Applied before the main loop — the fast-pivot model (chip can KO before the foe acts).
  for (const [actor, foe0] of myPivotChip) {
    const f = redirect(foe0, oppSwitchIn);
    if ((oppHp[f] ?? 0) <= 0 || oppProtected.has(f)) continue;
    const pc = t.myPivotCell[actor]?.[f]; if (!pc) continue;
    if (pc.dmgMax > 0) apply(oppHp, f, myDmg(actor, f, myRoll(pc, r), pc.physical, pc.type, pc.groundMove), oppSurv, pc.multiHit, oppDg(f));
    if (t.myPivotDebuff[actor]) accDrop(myToFoeDrop, f, t.myPivotDebuff[actor]!);   // Parting Shot −1 Atk/SpA
  }
  for (const [actor, foe0] of oppPivotChip) {
    const f = redirect(foe0, mySwitchIn);
    if ((myHp[f] ?? 0) <= 0 || myProtected.has(f)) continue;
    const pc = t.oppPivotCell[actor]?.[f]; if (!pc) continue;
    if (pc.dmgMax > 0) apply(myHp, f, oppDmg(actor, f, oppRoll(pc, r), pc.physical, pc.type, pc.groundMove), mySurv, pc.multiHit, myDg(f));
    if (t.oppPivotDebuff[actor]) accDrop(oppToFoeDrop, f, t.oppPivotDebuff[actor]!);
  }

  // Sucker Punch / Thunderclap fail unless the target is using a damaging attack
  // this turn and hasn't already moved. `acted` accrues as we walk `actings` in
  // order, so "already moved" = the target appears earlier in the order.
  const acted = new Set<string>();
  const targetWillAttack = (side: 'mine' | 'opp', idx: number): boolean => {
    if (acted.has(`${side}:${idx}`)) return false;        // already moved → Sucker Punch fails
    const plan = side === 'mine' ? myTargets : oppTargets;
    if (!plan.has(idx)) return false;                     // freshly switched-in / no action
    const tgt = plan.get(idx)!;
    if (tgt === PROTECT || nonAttack(tgt)) return false;  // protect / switch / status / setup / pivot…
    if (side === 'mine' ? myAsleep(idx) : oppAsleep(idx)) return false; // can't move → no attack
    return true;                                          // single-target / spread / Fake Out = an attack
  };

  for (const act of actings) {
    acted.add(`${act.side}:${act.actor}`);
    if (act.side === 'mine') {
      if (myHp[act.actor]! <= 0) continue;          // KO'd before acting
      if (myFlinched.has(act.actor)) continue;        // flinched by Fake Out
      if (act.target === PROTECT) continue;           // mon uses Protect — no damage dealt
      if (isFakeOutTarget(act.target)) {              // Fake Out: chip + flinch the target
        if (oppQuickGuard) continue;                  // Quick Guard blocks Fake Out (+3 priority)
        const f = redirect(fakeOutFoeIdx(act.target), oppSwitchIn);
        if ((oppHp[f] ?? 0) > 0 && !oppProtected.has(f)) {
          const fc = t.myFakeOutCell[act.actor]?.[f];
          if (fc) apply(oppHp, f, myDmg(act.actor, f, myRoll(fc, r), fc.physical, fc.type, fc.groundMove), oppSurv, fc.multiHit, oppDg(f));
          if (!t.oppFlinchImmune[f]) oppFlinched.add(f);   // Inner Focus / Covert Cloak block the flinch
        }
        continue;
      }
      if (act.target === SPREAD) {
        if (oppWideGuard) continue;                  // Wide Guard blocks the spread for the whole foe side
        // Spread move — hit every live, unprotected foe ON THE FIELD AFTER switches
        // (oppActiveNow; a benched mon isn't in range of a spread move).
        const sp = t.mySpread[act.actor]!;
        const dmg = mySpreadRoll(sp, r);
        let spreadDealt = false;
        for (const foe of oppActiveNow) {
          if (oppHp[foe]! <= 0) continue;
          if (oppProtected.has(foe)) continue;       // opp protecting this turn
          const koBefore = oppHp[foe]!;
          apply(oppHp, foe, myDmg(act.actor, foe, dmg[foe] ?? 0, sp.physical, sp.type, sp.groundMove), oppSurv, false, oppDg(foe));
          if (oppHp[foe]! < koBefore) spreadDealt = true;
          if (sp.foeDrop && (sp.dmgMax[foe] ?? 0) > 0) accDrop(myToFoeDrop, foe, sp.foeDrop); // Icy Wind etc. (skip type-immune)
          if (koBefore > 0 && oppHp[foe]! <= 0 && t.myOnKo[act.actor]) myKoCount.set(act.actor, (myKoCount.get(act.actor) ?? 0) + 1);
          markResist(oppResistBerryUsed, t.oppResistBerryType, foe, sp.type, t.oppSpecies[foe]!);
          procWp('opp', foe, sp.type);
        }
        if (sp.selfDrop) mySelfDrop.set(act.actor, sp.selfDrop);
        if (t.myLifeOrb[act.actor] && spreadDealt) myHp[act.actor] = Math.max(0, myHp[act.actor]! - 10);
        if (isSelfdestruct(sp.move)) myHp[act.actor] = 0;   // Explosion / Self-Destruct: user faints
        continue;
      }
      // Priority-attack option (Sucker Punch/Aqua Jet/…) uses the prio cell; else
      // the max-damage off cell. Redirection (opp Rage Powder/Follow Me) overrides
      // targeting; else the switch-redirect (hit the replacement if it switched).
      const myPrio = isPrioTarget(act.target);
      const oTgt = oppRedirTarget(act.actor) ?? redirect(myPrio ? prioFoeIdx(act.target) : act.target, oppSwitchIn);
      const oc = myPrio ? t.myPrioCell[act.actor]?.[oTgt] : t.off[act.actor]![oTgt]!;
      if (oppProtected.has(oTgt)) {                  // target protecting → fizzle (+ King's Shield etc. punish)
        if (oc?.contact) applyProtectPunish(t.oppProtectMove[oTgt], 'mine', act.actor);
        continue;
      }
      if (oppHp[oTgt]! <= 0) continue;               // target already down → fizzle
      if (!oc) continue;                              // no priority move vs this foe
      if (psychicBlocked(oc.priority, t.oppGrounded[oTgt]!)) continue; // Psychic Terrain blocks priority
      if (oppQuickGuard && oc.priority > 0) continue;  // Quick Guard blocks priority moves
      if (isSuckerLike(oc.move) && !targetWillAttack('opp', oTgt)) continue; // Sucker Punch whiffs vs a non-attacker
      if (isFutureMove(oc.move)) {                    // Future Sight: schedule, no damage now
        if ((oppFutureTurns[oTgt] ?? 0) <= 0) { oppFutureTurns[oTgt] = 2; oppFutureDmg[oTgt] = myDmg(act.actor, oTgt, oc.dmgMid, oc.physical, oc.type, oc.groundMove); }
        continue;
      }
      const oBefore = oppHp[oTgt]!;
      apply(oppHp, oTgt, myDmg(act.actor, oTgt, myRoll(oc, r), oc.physical, oc.type, oc.groundMove), oppSurv, oc.multiHit, oppDg(oTgt));
      const oDealt = oBefore - oppHp[oTgt]!;
      trackHit(oppBigHit, oTgt, act.actor, oDealt, oc.physical);   // for the opp's Counter
      if (oc.setsHazard) oppHazards = addHazard(oppHazards, oc.setsHazard); // Stone Axe → SR, Ceaseless Edge → Spikes (on their side)
      if (oc.selfDrop) mySelfDrop.set(act.actor, oc.selfDrop);       // Draco Meteor −2 SpA etc.
      if (oc.foeDrop && oc.dmgMax > 0) accDrop(myToFoeDrop, oTgt, oc.foeDrop); // Low Sweep −1 Spe etc.
      if (oBefore > 0 && oppHp[oTgt]! <= 0 && t.myOnKo[act.actor]) myKoCount.set(act.actor, (myKoCount.get(act.actor) ?? 0) + 1); // Moxie/Beast Boost
      markResist(oppResistBerryUsed, t.oppResistBerryType, oTgt, oc.type, t.oppSpecies[oTgt]!);
      procWp('opp', oTgt, oc.type);
      // Drain heal + contact punish (Rocky Helmet / Rough Skin) on my attacker.
      if (oDealt > 0 && (myHp[act.actor] ?? 0) > 0) {
        if (oc.drain > 0) myHp[act.actor] = Math.min(100, myHp[act.actor]! + oc.drain * oDealt * (t.oppMaxHp[oTgt]! / (t.myMaxHp[act.actor] || 1)));
        if (oc.contact && t.oppContactChip[oTgt]! > 0 && !t.myResidual[act.actor]!.magicGuard) myHp[act.actor] = Math.max(0, myHp[act.actor]! - t.oppContactChip[oTgt]!);
        if (oc.recoil > 0 && !t.myResidual[act.actor]!.magicGuard && !t.myRockHead[act.actor]) myHp[act.actor] = Math.max(0, myHp[act.actor]! - oc.recoil * oDealt * (t.oppMaxHp[oTgt]! / (t.myMaxHp[act.actor] || 1)));
        if (t.myLifeOrb[act.actor]) myHp[act.actor] = Math.max(0, myHp[act.actor]! - 10); // Life Orb recoil (10% max HP)
      }
      if (isSelfdestruct(oc.move)) myHp[act.actor] = 0;   // Explosion / Self-Destruct: user faints
      if ((myHp[act.actor] ?? 0) > 0) {                   // recharge / lock apply only if the user survived
        if (isRechargeMove(oc.move)) myRecharge[act.actor] = true;
        else if (isLockedMove(oc.move) && myLocked[act.actor]! <= 0) myLocked[act.actor] = 2;
      }
    } else {
      if (oppHp[act.actor]! <= 0) continue;
      if (oppFlinched.has(act.actor)) continue;       // flinched by Fake Out
      if (act.target === PROTECT) continue;           // opp mon uses Protect
      if (isFakeOutTarget(act.target)) {              // opp Fake Out: chip + flinch my mon
        if (myQuickGuard) continue;                   // Quick Guard blocks Fake Out (+3 priority)
        const f = redirect(fakeOutFoeIdx(act.target), mySwitchIn);
        if ((myHp[f] ?? 0) > 0 && !myProtected.has(f)) {
          const fc = t.oppFakeOutCell[act.actor]?.[f];
          if (fc) apply(myHp, f, oppDmg(act.actor, f, oppRoll(fc, r), fc.physical, fc.type, fc.groundMove), mySurv, fc.multiHit, myDg(f));
          if (!t.myFlinchImmune[f]) myFlinched.add(f);
        }
        continue;
      }
      if (act.target === SPREAD) {
        if (myWideGuard) continue;                    // Wide Guard blocks the spread for my whole side
        // Opp spread move — hit every live, unprotected mon of mine ON THE FIELD
        // AFTER switches (myActiveNow; my bench isn't in range).
        const sp = t.oppSpread[act.actor]!;
        const dmg = oppSpreadRoll(sp, r);
        let spreadDealt = false;
        for (const me of myActiveNow) {
          if (myHp[me]! <= 0) continue;
          if (myProtected.has(me)) continue;          // my mon protecting this turn
          const koBefore = myHp[me]!;
          apply(myHp, me, oppDmg(act.actor, me, dmg[me] ?? 0, sp.physical, sp.type, sp.groundMove), mySurv, false, myDg(me));
          if (myHp[me]! < koBefore) spreadDealt = true;
          if (sp.foeDrop && (sp.dmgMax[me] ?? 0) > 0) accDrop(oppToFoeDrop, me, sp.foeDrop);
          if (koBefore > 0 && myHp[me]! <= 0 && t.oppOnKo[act.actor]) oppKoCount.set(act.actor, (oppKoCount.get(act.actor) ?? 0) + 1);
          markResist(myResistBerryUsed, t.myResistBerryType, me, sp.type, t.mySpecies[me]!);
          procWp('mine', me, sp.type);
        }
        if (sp.selfDrop) oppSelfDrop.set(act.actor, sp.selfDrop);
        if (t.oppLifeOrb[act.actor] && spreadDealt) oppHp[act.actor] = Math.max(0, oppHp[act.actor]! - 10);
        if (isSelfdestruct(sp.move)) oppHp[act.actor] = 0;   // Explosion / Self-Destruct: user faints
        continue;
      }
      // Priority-attack option uses the opp prio cell; else the max-damage thr cell.
      const oppPrio = isPrioTarget(act.target);
      const mTgt = myRedirTarget(act.actor) ?? redirect(oppPrio ? prioFoeIdx(act.target) : act.target, mySwitchIn);  // redirection, else switch-redirect
      const tc = oppPrio ? t.oppPrioCell[act.actor]?.[mTgt] : t.thr[act.actor]![mTgt]!;
      if (myProtected.has(mTgt)) {                    // my mon protecting → fizzle (+ King's Shield etc. punish)
        if (tc?.contact) applyProtectPunish(t.myProtectMove[mTgt], 'opp', act.actor);
        continue;
      }
      if (myHp[mTgt]! <= 0) continue;
      if (!tc) continue;                              // no priority move vs this foe
      if (psychicBlocked(tc.priority, t.myGrounded[mTgt]!)) continue; // Psychic Terrain blocks priority
      if (myQuickGuard && tc.priority > 0) continue;  // Quick Guard blocks priority moves
      if (isSuckerLike(tc.move) && !targetWillAttack('mine', mTgt)) continue; // Sucker Punch whiffs vs a non-attacker
      if (isFutureMove(tc.move)) {                    // opp Future Sight: schedule, no damage now
        if ((myFutureTurns[mTgt] ?? 0) <= 0) { myFutureTurns[mTgt] = 2; myFutureDmg[mTgt] = oppDmg(act.actor, mTgt, tc.dmgMid, tc.physical, tc.type, tc.groundMove); }
        continue;
      }
      const mBefore = myHp[mTgt]!;
      apply(myHp, mTgt, oppDmg(act.actor, mTgt, oppRoll(tc, r), tc.physical, tc.type, tc.groundMove), mySurv, tc.multiHit, myDg(mTgt));
      const mDealt = mBefore - myHp[mTgt]!;
      trackHit(myBigHit, mTgt, act.actor, mDealt, tc.physical);   // for my Counter
      if (tc.setsHazard) myHazards = addHazard(myHazards, tc.setsHazard); // their Stone Axe / Ceaseless Edge → hazard on my side
      if (tc.selfDrop) oppSelfDrop.set(act.actor, tc.selfDrop);
      if (tc.foeDrop && tc.dmgMax > 0) accDrop(oppToFoeDrop, mTgt, tc.foeDrop);
      if (mBefore > 0 && myHp[mTgt]! <= 0 && t.oppOnKo[act.actor]) oppKoCount.set(act.actor, (oppKoCount.get(act.actor) ?? 0) + 1);
      markResist(myResistBerryUsed, t.myResistBerryType, mTgt, tc.type, t.mySpecies[mTgt]!);
      procWp('mine', mTgt, tc.type);
      if (mDealt > 0 && (oppHp[act.actor] ?? 0) > 0) {
        if (tc.drain > 0) oppHp[act.actor] = Math.min(100, oppHp[act.actor]! + tc.drain * mDealt * (t.myMaxHp[mTgt]! / (t.oppMaxHp[act.actor] || 1)));
        if (tc.contact && t.myContactChip[mTgt]! > 0 && !t.oppResidual[act.actor]!.magicGuard) oppHp[act.actor] = Math.max(0, oppHp[act.actor]! - t.myContactChip[mTgt]!);
        if (tc.recoil > 0 && !t.oppResidual[act.actor]!.magicGuard && !t.oppRockHead[act.actor]) oppHp[act.actor] = Math.max(0, oppHp[act.actor]! - tc.recoil * mDealt * (t.myMaxHp[mTgt]! / (t.oppMaxHp[act.actor] || 1)));
        if (t.oppLifeOrb[act.actor]) oppHp[act.actor] = Math.max(0, oppHp[act.actor]! - 10);
      }
      if (isSelfdestruct(tc.move)) oppHp[act.actor] = 0;   // Explosion / Self-Destruct: user faints
      if ((oppHp[act.actor] ?? 0) > 0) {
        if (isRechargeMove(tc.move)) oppRecharge[act.actor] = true;
        else if (isLockedMove(tc.move) && oppLocked[act.actor]! <= 0) oppLocked[act.actor] = 2;
      }
    }
  }

  // Counter / Mirror Coat / Metal Burst resolve LAST (−5 priority): a chooser that
  // survived reflects `mult ×` the damage of the biggest matching-category hit it
  // took back at that attacker (scaled into the foe's HP bar). Sash/sub/disguise on
  // the foe still apply (apply()'s defense context). Single-target hits only.
  for (const [actor, target] of myTargets) {
    if (target !== COUNTER || (myHp[actor] ?? 0) <= 0) continue;
    const cm = t.myCounter[actor]; const big = myBigHit.get(actor);
    if (!cm || !big || (cm.cat !== 'any' && (cm.cat === 'phys') !== big.phys)) continue;
    if ((oppHp[big.atk] ?? 0) > 0) apply(oppHp, big.atk, cm.mult * big.dmg * (t.myMaxHp[actor]! / (t.oppMaxHp[big.atk] || 1)), oppSurv, false, oppDg(big.atk));
  }
  for (const [actor, target] of oppTargets) {
    if (target !== COUNTER || (oppHp[actor] ?? 0) <= 0) continue;
    const cm = t.oppCounter[actor]; const big = oppBigHit.get(actor);
    if (!cm || !big || (cm.cat !== 'any' && (cm.cat === 'phys') !== big.phys)) continue;
    if ((myHp[big.atk] ?? 0) > 0) apply(myHp, big.atk, cm.mult * big.dmg * (t.oppMaxHp[actor]! / (t.myMaxHp[big.atk] || 1)), mySurv, false, myDg(big.atk));
  }

  // Update consecutive protect streaks. Using Protect increments the streak
  // (disabling the option next turn); any other action resets it to 0.
  const myProtectStreak = s.myProtectStreak.slice();
  const oppProtectStreak = s.oppProtectStreak.slice();
  for (const [actor, target] of myTargets) {
    myProtectStreak[actor] = target === PROTECT ? (myProtectStreak[actor]! + 1) : 0;
  }
  for (const [actor, target] of oppTargets) {
    oppProtectStreak[actor] = target === PROTECT ? (oppProtectStreak[actor]! + 1) : 0;
  }

  // A phantom (unrevealed) opp mon that switched in is now revealed/brought —
  // flip its seen flag so it counts as material from here on.
  const oppSeen = s.oppSeen.slice();
  for (const inIdx of oppSwitchIn.values()) oppSeen[inIdx] = true;

  // Order field effects: first TICK DOWN conditions that were active at the start
  // of this turn (clearing at 0 — this is what lets the search stall an effect
  // out), THEN apply this turn's sets with a fresh full duration (no same-turn
  // tick). A known turn count expires the effect; an unknown count (undefined)
  // persists for the horizon. Tailwind sets the caster's flag (4 turns); Trick
  // Room toggles the shared flag (5 turns when turned on, so two TRs cancel).
  let [trickRoom, trickRoomTurns] = tick(s.trickRoom, s.trickRoomTurns);
  let [myTailwind, myTailwindTurns] = tick(s.myTailwind, s.myTailwindTurns);
  let [theirTailwind, theirTailwindTurns] = tick(s.theirTailwind, s.theirTailwindTurns);
  // Field rooms tick down so the search can stall a root-active one out. They are
  // NOT cast mid-search: Gravity (grounding), Wonder Room (Def/SpD swap) and Magic
  // Room (item suppression) are pure DAMAGE effects baked into the cells at root,
  // and recomputing them mid-search is the cell-recompute/GPU phase — so a room
  // CAST stays flagged by unmodeled.ts.
  let [gravity, gravityTurns] = tick(s.gravity, s.gravityTurns);
  let [wonderRoom, wonderRoomTurns] = tick(s.wonderRoom, s.wonderRoomTurns);
  let [magicRoom, magicRoomTurns] = tick(s.magicRoom, s.magicRoomTurns);
  // A SET_ROOM cast toggles its room (5 turns when turned on; re-casting the same
  // room turns it off, mirroring Trick Room). Damage effects stay baked at root.
  const castRoom = (move: RoomKind | null | undefined) => {
    if (move === 'gravity') { gravity = !gravity; gravityTurns = gravity ? 5 : undefined; }
    else if (move === 'wonderRoom') { wonderRoom = !wonderRoom; wonderRoomTurns = wonderRoom ? 5 : undefined; }
    else if (move === 'magicRoom') { magicRoom = !magicRoom; magicRoomTurns = magicRoom ? 5 : undefined; }
  };
  for (const [actor, target] of myTargets) if (target === SET_ROOM && (myHp[actor] ?? 0) > 0) castRoom(t.myRoomMove[actor]);
  for (const [actor, target] of oppTargets) if (target === SET_ROOM && (oppHp[actor] ?? 0) > 0) castRoom(t.oppRoomMove[actor]);
  for (const [, target] of myTargets) {
    if (target === SET_TAILWIND) { myTailwind = true; myTailwindTurns = 4; }
    else if (target === SET_TRICKROOM) { trickRoom = !trickRoom; trickRoomTurns = trickRoom ? 5 : undefined; }
  }
  for (const [, target] of oppTargets) {
    if (target === SET_TAILWIND) { theirTailwind = true; theirTailwindTurns = 4; }
    else if (target === SET_TRICKROOM) { trickRoom = !trickRoom; trickRoomTurns = trickRoom ? 5 : undefined; }
  }

  // Screens: tick down (so the search can stall one out), then apply this turn's
  // SET_SCREEN to the caster's SIDE with a fresh 5-turn count.
  let [myReflect, myReflectTurns] = tick(s.myReflect, s.myReflectTurns);
  let [myLightScreen, myLightScreenTurns] = tick(s.myLightScreen, s.myLightScreenTurns);
  let [theirReflect, theirReflectTurns] = tick(s.theirReflect, s.theirReflectTurns);
  let [theirLightScreen, theirLightScreenTurns] = tick(s.theirLightScreen, s.theirLightScreenTurns);
  for (const [actor, target] of myTargets) {
    if (target !== SET_SCREEN) continue;
    const sc = t.myScreen[actor]; if (!sc) continue;
    if (sc.reflect) { myReflect = true; myReflectTurns = 5; }
    if (sc.lightScreen) { myLightScreen = true; myLightScreenTurns = 5; }
  }
  for (const [actor, target] of oppTargets) {
    if (target !== SET_SCREEN) continue;
    const sc = t.oppScreen[actor]; if (!sc) continue;
    if (sc.reflect) { theirReflect = true; theirReflectTurns = 5; }
    if (sc.lightScreen) { theirLightScreen = true; theirLightScreenTurns = 5; }
  }

  // Weather: tick down (stall-out), then apply this turn's setters. A switch-in
  // weather ability (Drought etc.) fires when the mon enters; a SET_WEATHER move
  // sets it too. Both give 5 turns; later setters win.
  let weather = s.weather;
  let weatherTurns = s.weatherTurns;
  if (weather && weatherTurns != null) { weatherTurns -= 1; if (weatherTurns <= 0) { weather = null; weatherTurns = undefined; } }
  const setWeather = (w: Weather | null) => { if (w) { weather = w; weatherTurns = 5; } };
  for (const inB of mySwitchIn.values()) setWeather(t.myWeatherAbility[inB] ?? null);
  for (const inB of oppSwitchIn.values()) setWeather(t.oppWeatherAbility[inB] ?? null);
  for (const [actor, target] of myTargets) if (target === SET_WEATHER) setWeather(t.myWeatherMove[actor]?.weather ?? null);
  for (const [actor, target] of oppTargets) if (target === SET_WEATHER) setWeather(t.oppWeatherMove[actor]?.weather ?? null);

  // Terrain: same tick + set pattern (surge abilities on switch-in, terrain moves).
  let terrain = s.terrain;
  let terrainTurns = s.terrainTurns;
  if (terrain && terrainTurns != null) { terrainTurns -= 1; if (terrainTurns <= 0) { terrain = null; terrainTurns = undefined; } }
  const setTerrain = (ter: Terrain | null) => { if (ter) { terrain = ter; terrainTurns = 5; } };
  for (const inB of mySwitchIn.values()) setTerrain(t.myTerrainAbility[inB] ?? null);
  for (const inB of oppSwitchIn.values()) setTerrain(t.oppTerrainAbility[inB] ?? null);
  for (const [actor, target] of myTargets) if (target === SET_TERRAIN) setTerrain(t.myTerrainMove[actor]?.terrain ?? null);
  for (const [actor, target] of oppTargets) if (target === SET_TERRAIN) setTerrain(t.oppTerrainMove[actor]?.terrain ?? null);

  // Dedicated hazard-setting moves: Stealth Rock / Spikes / Toxic Spikes / Sticky
  // Web lay a layer on the OPPOSING side (my move → their side, and vice versa).
  // Magic Bounce on EITHER opposing active reflects a hazard move back onto the
  // setter's own side.
  const oppHasBounce = oppActiveNow.some(j => (oppHp[j] ?? 0) > 0 && toId(t.oppAbility[j] ?? '') === 'magicbounce');
  const myHasBounce = myActiveNow.some(i => (myHp[i] ?? 0) > 0 && toId(t.myAbility[i] ?? '') === 'magicbounce');
  for (const [actor, target] of myTargets) if (target === SET_HAZARD && t.myHazardMove[actor]) { const h = t.myHazardMove[actor]!.hazard; if (oppHasBounce) myHazards = addHazard(myHazards, h); else oppHazards = addHazard(oppHazards, h); }
  for (const [actor, target] of oppTargets) if (target === SET_HAZARD && t.oppHazardMove[actor]) { const h = t.oppHazardMove[actor]!.hazard; if (myHasBounce) oppHazards = addHazard(oppHazards, h); else myHazards = addHazard(myHazards, h); }
  // Hazard clearing (Rapid Spin clears own side; Defog/Tidy Up clear both; Court
  // Change swaps). Rapid Spin/Tidy Up also boost the user (routed via selfDrop →
  // applied at the boost step). Frees up switch lines the search otherwise taxes.
  for (const [actor, target] of myTargets) {
    if (target !== CLEAR_HAZARD) continue;
    const hc = t.myHazardClear[actor]; if (!hc || (myHp[actor] ?? 0) <= 0) continue;
    if (hc.kind === 'self') myHazards = {};
    else if (hc.kind === 'both') { myHazards = {}; oppHazards = {}; }
    else { const tmp = myHazards; myHazards = oppHazards; oppHazards = tmp; }
    if (hc.spe || hc.atk) mySelfDrop.set(actor, { ...(hc.spe ? { spe: hc.spe } : {}), ...(hc.atk ? { atk: hc.atk } : {}) });
  }
  for (const [actor, target] of oppTargets) {
    if (target !== CLEAR_HAZARD) continue;
    const hc = t.oppHazardClear[actor]; if (!hc || (oppHp[actor] ?? 0) <= 0) continue;
    if (hc.kind === 'self') oppHazards = {};
    else if (hc.kind === 'both') { myHazards = {}; oppHazards = {}; }
    else { const tmp = myHazards; myHazards = oppHazards; oppHazards = tmp; }
    if (hc.spe || hc.atk) oppSelfDrop.set(actor, { ...(hc.spe ? { spe: hc.spe } : {}), ...(hc.atk ? { atk: hc.atk } : {}) });
  }

  // Leech Seed. A seed is removed when the seeded mon leaves the field (switch);
  // a switched-in mon arrives unseeded. New seeds cast this turn land on the
  // (post-switch) target unless it's Grass / already seeded, and drain THIS turn.
  const mySeeded = s.mySeeded.slice();
  const oppSeeded = s.oppSeeded.slice();
  for (const out of mySwitchIn.keys()) mySeeded[out] = null;
  for (const inn of mySwitchIn.values()) mySeeded[inn] = null;
  for (const out of oppSwitchIn.keys()) oppSeeded[out] = null;
  for (const inn of oppSwitchIn.values()) oppSeeded[inn] = null;
  for (const [actor, target] of myTargets) {
    if (!isLeechTarget(target)) continue;
    const foe = redirect(leechFoeIdx(target), oppSwitchIn);
    if ((oppHp[foe] ?? 0) <= 0) continue;
    if (toId(t.oppAbility[foe] ?? '') === 'magicbounce') {        // bounced: seeds the caster instead
      if (mySeeded[actor] == null && !t.myGrass[actor]) mySeeded[actor] = foe;
      continue;
    }
    if (oppSeeded[foe] == null && !t.oppGrass[foe]) oppSeeded[foe] = actor;
  }
  for (const [actor, target] of oppTargets) {
    if (!isLeechTarget(target)) continue;
    const foe = redirect(leechFoeIdx(target), mySwitchIn);
    if ((myHp[foe] ?? 0) <= 0) continue;
    if (toId(t.myAbility[foe] ?? '') === 'magicbounce') {
      if (oppSeeded[actor] == null && !t.oppGrass[actor]) oppSeeded[actor] = foe;
      continue;
    }
    if (mySeeded[foe] == null && !t.myGrass[foe]) mySeeded[foe] = actor;
  }
  // End-of-turn drain (1/8 of the seeded mon's max) + heal the seeder (same
  // ABSOLUTE HP, re-expressed as the seeder's %). Only ACTIVE seeded mons drain.
  const LEECH_PCT = 100 / 8;
  for (const mi of myActiveNow) {
    if ((myHp[mi] ?? 0) <= 0 || mySeeded[mi] == null) continue;
    const drain = Math.min(LEECH_PCT, myHp[mi]!);
    myHp[mi]! -= drain;
    const seeder = mySeeded[mi]!;
    if (oppActiveNow.includes(seeder) && (oppHp[seeder] ?? 0) > 0) {
      oppHp[seeder] = Math.min(100, oppHp[seeder]! + drain * (t.myMaxHp[mi]! / (t.oppMaxHp[seeder] || 1)));
    }
  }
  for (const oj of oppActiveNow) {
    if ((oppHp[oj] ?? 0) <= 0 || oppSeeded[oj] == null) continue;
    const drain = Math.min(LEECH_PCT, oppHp[oj]!);
    oppHp[oj]! -= drain;
    const seeder = oppSeeded[oj]!;
    if (myActiveNow.includes(seeder) && (myHp[seeder] ?? 0) > 0) {
      myHp[seeder] = Math.min(100, myHp[seeder]! + drain * (t.oppMaxHp[oj]! / (t.myMaxHp[seeder] || 1)));
    }
  }

  // End-of-turn residuals on ACTIVE mons: status chip (burn 1/16, poison 1/8,
  // toxic n/16 escalating), Sandstorm chip, Grassy + Leftovers heal. Magic Guard
  // blocks the DAMAGE (not the heals). Uses the start-of-turn weather/terrain.
  const myToxicN = s.myToxicN.slice();
  const oppToxicN = s.oppToxicN.slice();
  const sand = normWeather(s.weather) === 'Sand';
  const grassy = s.terrain === 'Grassy';
  const residual = (hp: number[], idx: number, info: ResidualInfo, status: string, toxicN: number[], grounded: boolean) => {
    if ((hp[idx] ?? 0) <= 0) return;
    let delta = 0;
    if (!info.magicGuard) {
      if (status === 'brn') delta -= 100 / 16;
      else if (status === 'psn') delta -= 100 / 8;
      else if (status === 'tox') { const n = toxicN[idx] || 1; delta -= n * (100 / 16); toxicN[idx] = n + 1; }
      if (sand && !info.sandImmune) delta -= 100 / 16;
    }
    if (info.leftovers) delta += 100 / 16;             // heals ignore Magic Guard
    if (grassy && grounded) delta += 100 / 16;
    if (delta !== 0) hp[idx] = Math.max(0, Math.min(100, hp[idx]! + delta));
  };
  for (const mi of myActiveNow) residual(myHp, mi, t.myResidual[mi]!, s.myStatus[mi]!, myToxicN, t.myGrounded[mi]!);
  for (const oj of oppActiveNow) residual(oppHp, oj, t.oppResidual[oj]!, s.oppStatus[oj]!, oppToxicN, t.oppGrounded[oj]!);

  // Recovery moves: heal the caster (if it survived the turn) by the move's % of
  // its max, weather-scaled for Synthesis/Moonlight/Morning Sun / Shore Up. A
  // recover trades this turn's attack for HP — the search weighs that.
  for (const [actor, target] of myTargets) {
    if (target !== RECOVER || (myHp[actor] ?? 0) <= 0 || !t.myRecover[actor]) continue;
    if (t.myRecover[actor]!.kind === 'wish') { if (myWish[actor]! <= 0) myWish[actor] = 1; }  // delayed: lands end of next turn
    else myHp[actor] = Math.min(100, myHp[actor]! + recoverPct(t.myRecover[actor]!.kind, s.weather));
  }
  for (const [actor, target] of oppTargets) {
    if (target !== RECOVER || (oppHp[actor] ?? 0) <= 0 || !t.oppRecover[actor]) continue;
    if (t.oppRecover[actor]!.kind === 'wish') { if (oppWish[actor]! <= 0) oppWish[actor] = 1; }
    else oppHp[actor] = Math.min(100, oppHp[actor]! + recoverPct(t.oppRecover[actor]!.kind, s.weather));
  }
  // Wish lands at the END of the turn after it's cast: a wish present at the START
  // of THIS turn (s.*Wish>0) ticks to 0 and heals the slot's occupant 50%. A wish
  // cast THIS turn (s.*Wish was 0) is untouched here and lands next turn.
  for (const i of myActiveNow) if (s.myWish[i]! > 0) { myWish[i] = s.myWish[i]! - 1; if (myWish[i] === 0 && (myHp[i] ?? 0) > 0) myHp[i] = Math.min(100, myHp[i]! + 50); }
  for (const j of oppActiveNow) if (s.oppWish[j]! > 0) { oppWish[j] = s.oppWish[j]! - 1; if (oppWish[j] === 0 && (oppHp[j] ?? 0) > 0) oppHp[j] = Math.min(100, oppHp[j]! + 50); }
  // Future Sight / Doom Desire land 2 turns after cast (a pending hit at the START
  // of this turn ticks to 0 and strikes the targeted slot's current occupant).
  for (const j of oppActiveNow) if (s.oppFutureTurns[j]! > 0) { oppFutureTurns[j] = s.oppFutureTurns[j]! - 1; if (oppFutureTurns[j] === 0 && (oppHp[j] ?? 0) > 0) { oppHp[j] = Math.max(0, oppHp[j]! - (oppFutureDmg[j] ?? 0)); oppFutureDmg[j] = 0; } }
  for (const i of myActiveNow) if (s.myFutureTurns[i]! > 0) { myFutureTurns[i] = s.myFutureTurns[i]! - 1; if (myFutureTurns[i] === 0 && (myHp[i] ?? 0) > 0) { myHp[i] = Math.max(0, myHp[i]! - (myFutureDmg[i] ?? 0)); myFutureDmg[i] = 0; } }
  // Substitute: pay 25% max HP to put up a sub (requires >25% HP + no existing sub
  // + the user survived). Created at EOT → it shields from NEXT turn (conservative;
  // a sub already up at the root IS modelled by the apply-routing above).
  for (const [actor, target] of myTargets) if (target === SET_SUB && (myHp[actor] ?? 0) > 25 && (mySubHp[actor] ?? 0) <= 0) { myHp[actor]! -= 25; mySubHp[actor] = 25; }
  for (const [actor, target] of oppTargets) if (target === SET_SUB && (oppHp[actor] ?? 0) > 25 && (oppSubHp[actor] ?? 0) <= 0) { oppHp[actor]! -= 25; oppSubHp[actor] = 25; }
  // Strength Sap: heal the caster by the target's Attack STAT (as % of the caster's
  // max HP) and drop the target's Attack −1. Auto-targets the highest-Attack live
  // foe — the dominant sap (most heal + neuters the biggest physical threat).
  for (const [actor, target] of myTargets) {
    if (target !== SAP || (myHp[actor] ?? 0) <= 0) continue;
    let foe = -1, bestAtk = -1;
    for (const j of oppActiveNow) if ((oppHp[j] ?? 0) > 0 && t.oppAtkStat[j]! > bestAtk) { bestAtk = t.oppAtkStat[j]!; foe = j; }
    if (foe < 0) continue;
    myHp[actor] = Math.min(100, myHp[actor]! + Math.min(100, (bestAtk / (t.myMaxHp[actor] || 1)) * 100));
    accDrop(myToFoeDrop, foe, { atk: -1 });
  }
  for (const [actor, target] of oppTargets) {
    if (target !== SAP || (oppHp[actor] ?? 0) <= 0) continue;
    let foe = -1, bestAtk = -1;
    for (const i of myActiveNow) if ((myHp[i] ?? 0) > 0 && t.myAtkStat[i]! > bestAtk) { bestAtk = t.myAtkStat[i]!; foe = i; }
    if (foe < 0) continue;
    oppHp[actor] = Math.min(100, oppHp[actor]! + Math.min(100, (bestAtk / (t.oppMaxHp[actor] || 1)) * 100));
    accDrop(oppToFoeDrop, foe, { atk: -1 });
  }

  // Inflict status this turn (applies from NEXT ply, like other set-effects): a
  // status MOVE lands on its (post-switch) target unless the target is already
  // statused, immune by type/ability, or behind Misty Terrain.
  const myStatus = s.myStatus.slice();
  const oppStatus = s.oppStatus.slice();
  const mySleepTurns = s.mySleepTurns.slice();
  const oppSleepTurns = s.oppSleepTurns.slice();
  const myBerryUsed = s.myBerryUsed.slice();
  const oppBerryUsed = s.oppBerryUsed.slice();
  // Status persists on a mon that switches out; a switch-in arrives clean (awake).
  for (const inn of mySwitchIn.values()) { myStatus[inn] = ''; myToxicN[inn] = 0; mySleepTurns[inn] = 0; myDisguise[inn] = hasDisguise(t.myAbility[inn]); myRecharge[inn] = false; myLocked[inn] = 0; mySubHp[inn] = 0; myWish[inn] = 0; }
  for (const inn of oppSwitchIn.values()) { oppStatus[inn] = ''; oppToxicN[inn] = 0; oppSleepTurns[inn] = 0; oppDisguise[inn] = hasDisguise(t.oppAbility[inn]); oppRecharge[inn] = false; oppLocked[inn] = 0; oppSubHp[inn] = 0; oppWish[inn] = 0; }
  // Wake: a mon that started the turn asleep ticks its counter down (it couldn't act
  // this turn); it wakes when the counter hits 0. Runs BEFORE this turn's infliction
  // so a freshly-slept mon keeps its full count.
  for (const i of myActiveNow) if (myStatus[i] === 'slp') { mySleepTurns[i] = Math.max(0, (mySleepTurns[i] ?? 0) - 1); if (mySleepTurns[i] <= 0) myStatus[i] = ''; }
  for (const j of oppActiveNow) if (oppStatus[j] === 'slp') { oppSleepTurns[j] = Math.max(0, (oppSleepTurns[j] ?? 0) - 1); if (oppSleepTurns[j] <= 0) oppStatus[j] = ''; }
  // Locked multi-turn (Outrage): tick down a lock that was active at the START of
  // the turn. A fresh lock set this turn (s.*Locked was 0) keeps its full count.
  for (const i of myActiveNow) if (s.myLocked[i]! > 0) myLocked[i] = s.myLocked[i]! - 1;
  for (const j of oppActiveNow) if (s.oppLocked[j]! > 0) oppLocked[j] = s.oppLocked[j]! - 1;
  // Inflict a status — but a Lum/Cheri/… berry immediately cures it (and is eaten).
  const inflict = (foe: number, status: string, toxicN: number[], statusArr: string[], berryUsed: boolean[], item: (string | undefined)[]) => {
    statusArr[foe] = status; if (status === 'tox') toxicN[foe] = 1;
    if (!berryUsed[foe] && statusBerryFor(item[foe], status as any)) { statusArr[foe] = ''; toxicN[foe] = 0; berryUsed[foe] = true; }
  };
  for (const [actor, target] of myTargets) {
    if (!isStatusTarget(target)) continue;
    const sm = t.myStatusMove[actor]; if (!sm) continue;
    const foe = redirect(statusFoeIdx(target), oppSwitchIn);
    if ((oppHp[foe] ?? 0) <= 0) continue;
    // Magic Bounce reflects a status move back at the caster (respecting the
    // caster's own immunities). The foe is untouched.
    if (toId(t.oppAbility[foe] ?? '') === 'magicbounce') {
      if ((myHp[actor] ?? 0) > 0 && !myStatus[actor] && statusLands(sm.status, sm.move, t.mySpecies[actor]!, t.myAbility[actor], t.myGrounded[actor]!, s.terrain)) {
        inflict(actor, sm.status, myToxicN, myStatus, myBerryUsed, t.myItem);
        if (sm.status === 'slp' && myStatus[actor] === 'slp') mySleepTurns[actor] = 2;
      }
      continue;
    }
    if (!oppStatus[foe] && (oppSubHp[foe] ?? 0) <= 0 && statusLands(sm.status, sm.move, t.oppSpecies[foe]!, t.oppAbility[foe], t.oppGrounded[foe]!, s.terrain)) {
      inflict(foe, sm.status, oppToxicN, oppStatus, oppBerryUsed, t.oppItem);
      if (sm.status === 'slp' && oppStatus[foe] === 'slp') oppSleepTurns[foe] = 2;
    }
  }
  for (const [actor, target] of oppTargets) {
    if (!isStatusTarget(target)) continue;
    const sm = t.oppStatusMove[actor]; if (!sm) continue;
    const foe = redirect(statusFoeIdx(target), mySwitchIn);
    if ((myHp[foe] ?? 0) <= 0) continue;
    if (toId(t.myAbility[foe] ?? '') === 'magicbounce') {
      if ((oppHp[actor] ?? 0) > 0 && !oppStatus[actor] && statusLands(sm.status, sm.move, t.oppSpecies[actor]!, t.oppAbility[actor], t.oppGrounded[actor]!, s.terrain)) {
        inflict(actor, sm.status, oppToxicN, oppStatus, oppBerryUsed, t.oppItem);
        if (sm.status === 'slp' && oppStatus[actor] === 'slp') oppSleepTurns[actor] = 2;
      }
      continue;
    }
    if (!myStatus[foe] && (mySubHp[foe] ?? 0) <= 0 && statusLands(sm.status, sm.move, t.mySpecies[foe]!, t.myAbility[foe], t.myGrounded[foe]!, s.terrain)) {
      inflict(foe, sm.status, myToxicN, myStatus, myBerryUsed, t.myItem);
      if (sm.status === 'slp' && myStatus[foe] === 'slp') mySleepTurns[foe] = 2;
    }
  }
  // Protect-variant contact punish that inflicts status (Baneful Bunker poison /
  // Burning Bulwark burn) on the attacker — respects immunities like a status move.
  for (const [atk, st] of oppPunishStatus) {
    if ((oppHp[atk] ?? 0) > 0 && !oppStatus[atk] && statusLands(st, '', t.oppSpecies[atk]!, t.oppAbility[atk], t.oppGrounded[atk]!, s.terrain)) inflict(atk, st, oppToxicN, oppStatus, oppBerryUsed, t.oppItem);
  }
  for (const [atk, st] of myPunishStatus) {
    if ((myHp[atk] ?? 0) > 0 && !myStatus[atk] && statusLands(st, '', t.mySpecies[atk]!, t.myAbility[atk], t.myGrounded[atk]!, s.terrain)) inflict(atk, st, myToxicN, myStatus, myBerryUsed, t.myItem);
  }
  // Dedicated debuff moves (Charm/Scary Face/…): lower the (post-switch) foe's stats,
  // routed through the foe-drop accumulator below so Clear Body immunity + Defiant apply.
  for (const [actor, target] of myTargets) {
    if (!isDebuffTarget(target)) continue;
    const dm = t.myDebuffMove[actor]; if (!dm) continue;
    const foe = redirect(debuffFoeIdx(target), oppSwitchIn);
    if ((oppHp[foe] ?? 0) <= 0) continue;
    // Magic Bounce reflects the debuff back onto the caster (via the foe-drop-on-me
    // path so the caster's Defiant/immunity still resolve).
    if (toId(t.oppAbility[foe] ?? '') === 'magicbounce') accDrop(oppToFoeDrop, actor, dm.boosts);
    else accDrop(myToFoeDrop, foe, dm.boosts);
  }
  for (const [actor, target] of oppTargets) {
    if (!isDebuffTarget(target)) continue;
    const dm = t.oppDebuffMove[actor]; if (!dm) continue;
    const foe = redirect(debuffFoeIdx(target), mySwitchIn);
    if ((myHp[foe] ?? 0) <= 0) continue;
    if (toId(t.myAbility[foe] ?? '') === 'magicbounce') accDrop(myToFoeDrop, actor, dm.boosts);
    else accDrop(oppToFoeDrop, foe, dm.boosts);
  }

  // Taunt / Encore (option restriction). Tick down what was active at the start
  // (clearing at 0), reset on switch-in, then apply this turn's casts.
  const myTaunt = s.myTaunt.slice(); const oppTaunt = s.oppTaunt.slice();
  const myEncore = s.myEncore.slice(); const oppEncore = s.oppEncore.slice();
  const myEncoreAct = s.myEncoreAct.slice(); const oppEncoreAct = s.oppEncoreAct.slice();
  const tickRestrict = (i: number, taunt: number[], enc: number[], encAct: number[]) => {
    if (taunt[i]! > 0) taunt[i]!--;
    if (enc[i]! > 0) { enc[i]!--; if (enc[i] === 0) encAct[i] = NONE; }
  };
  for (const i of myActiveNow) tickRestrict(i, myTaunt, myEncore, myEncoreAct);
  for (const j of oppActiveNow) tickRestrict(j, oppTaunt, oppEncore, oppEncoreAct);
  for (const inn of mySwitchIn.values()) { myTaunt[inn] = 0; myEncore[inn] = 0; myEncoreAct[inn] = NONE; }
  for (const inn of oppSwitchIn.values()) { oppTaunt[inn] = 0; oppEncore[inn] = 0; oppEncoreAct[inn] = NONE; }
  // Inflict (lasts ~3 turns). Encore locks the foe into the move it used THIS turn
  // (any non-switch action), so it repeats it next ply.  // Magic Bounce reflects Taunt onto the caster; a bounced Encore simply fizzles.
  for (const [actor, target] of myTargets) {
    if (isTauntTarget(target) && t.myTauntMove[actor]) { const foe = redirect(tauntFoeIdx(target), oppSwitchIn); if ((oppHp[foe] ?? 0) > 0) { if (toId(t.oppAbility[foe] ?? '') === 'magicbounce') myTaunt[actor] = 3; else oppTaunt[foe] = 3; } }
    else if (isEncoreTarget(target) && t.myEncoreMove[actor]) { const foe = redirect(encoreFoeIdx(target), oppSwitchIn); const la = oppTargets.get(foe); if ((oppHp[foe] ?? 0) > 0 && toId(t.oppAbility[foe] ?? '') !== 'magicbounce' && lockable(la)) { oppEncore[foe] = 3; oppEncoreAct[foe] = la; } }
  }
  for (const [actor, target] of oppTargets) {
    if (isTauntTarget(target) && t.oppTauntMove[actor]) { const foe = redirect(tauntFoeIdx(target), mySwitchIn); if ((myHp[foe] ?? 0) > 0) { if (toId(t.myAbility[foe] ?? '') === 'magicbounce') oppTaunt[actor] = 3; else myTaunt[foe] = 3; } }
    else if (isEncoreTarget(target) && t.oppEncoreMove[actor]) { const foe = redirect(encoreFoeIdx(target), mySwitchIn); const la = myTargets.get(foe); if ((myHp[foe] ?? 0) > 0 && toId(t.myAbility[foe] ?? '') !== 'magicbounce' && lockable(la)) { myEncore[foe] = 3; myEncoreAct[foe] = la; } }
  }

  // Boost bookkeeping. A mon that LEAVES the field clears its stages; a switch-in
  // arrives fresh — EXCEPT Baton Pass, which passes the outgoing mon's current
  // stages to the incoming mon. Then setup moves apply their self-boost, and
  // Speed Boost adds +1 Spe at end of turn to active holders.
  const myBoost = s.myBoost.map(b => ({ ...b }));
  const oppBoost = s.oppBoost.map(b => ({ ...b }));
  for (const [outI, inB] of mySwitchIn) { const passed = myBaton.has(outI) ? { ...myBoost[outI] } : {}; myBoost[outI] = {}; myBoost[inB] = passed; }
  for (const [outJ, inB] of oppSwitchIn) { const passed = oppBaton.has(outJ) ? { ...oppBoost[outJ] } : {}; oppBoost[outJ] = {}; oppBoost[inB] = passed; }
  for (const [actor, target] of myTargets) if (target === SET_BOOST && t.mySetup[actor]) myBoost[actor] = addBoosts(myBoost[actor]!, t.mySetup[actor]!);
  for (const [actor, target] of oppTargets) if (target === SET_BOOST && t.oppSetup[actor]) oppBoost[actor] = addBoosts(oppBoost[actor]!, t.oppSetup[actor]!);
  // Self-stat-drops from this turn's moves (Draco Meteor −2 SpA …) hit the user's
  // own boosts; Contrary inverts them into a self-boost. Only if the user survived.
  for (const [actor, drop] of mySelfDrop) if ((myHp[actor] ?? 0) > 0) myBoost[actor] = addBoosts(myBoost[actor]!, hasContrary(t.myAbility[actor]) ? negateBoosts(drop) : drop);
  for (const [actor, drop] of oppSelfDrop) if ((oppHp[actor] ?? 0) > 0) oppBoost[actor] = addBoosts(oppBoost[actor]!, hasContrary(t.oppAbility[actor]) ? negateBoosts(drop) : drop);
  // On-KO ability boost (Moxie/Beast Boost/…): +stage × KOs scored, if the booster
  // survived the turn. Fuels snowball lines in the lookahead.
  for (const [actor, n] of myKoCount) if ((myHp[actor] ?? 0) > 0 && t.myOnKo[actor]) myBoost[actor] = addBoosts(myBoost[actor]!, scaleBoosts(t.myOnKo[actor]!, n));
  for (const [actor, n] of oppKoCount) if ((oppHp[actor] ?? 0) > 0 && t.oppOnKo[actor]) oppBoost[actor] = addBoosts(oppBoost[actor]!, scaleBoosts(t.oppOnKo[actor]!, n));
  // An OPPONENT-inflicted stat drop (Icy Wind / Snarl / Intimidate): blocked by
  // stat-drop immunity; Contrary inverts it into a boost (no Defiant); otherwise it
  // lands and a Defiant/Competitive holder reacts +2 Atk/SpA.
  const applyDrop = (boost: BoostMap[], idx: number, drop: BoostMap, immune: boolean, ability: string | null | undefined, reactStat: 'atk' | 'spa' | null) => {
    if (immune) return;
    if (hasContrary(ability)) { boost[idx] = addBoosts(boost[idx]!, negateBoosts(drop)); return; }
    boost[idx] = addBoosts(boost[idx]!, drop);
    if (reactStat) boost[idx] = addBoosts(boost[idx]!, { [reactStat]: 2 } as BoostMap);
  };
  for (const [j, drop] of myToFoeDrop) if ((oppHp[j] ?? 0) > 0) applyDrop(oppBoost, j, drop, t.oppStatDropImmune[j]!, t.oppAbility[j], t.oppDefiantStat[j]!);
  for (const [i, drop] of oppToFoeDrop) if ((myHp[i] ?? 0) > 0) applyDrop(myBoost, i, drop, t.myStatDropImmune[i]!, t.myAbility[i], t.myDefiantStat[i]!);
  for (const i of myActiveNow) if ((myHp[i] ?? 0) > 0 && t.mySpeedBoost[i]) myBoost[i] = addBoosts(myBoost[i]!, { spe: 1 });
  for (const j of oppActiveNow) if ((oppHp[j] ?? 0) > 0 && t.oppSpeedBoost[j]) oppBoost[j] = addBoosts(oppBoost[j]!, { spe: 1 });
  // Weakness Policy: +2 Atk/+2 SpA to a holder that survived a super-effective hit.
  for (const i of myWpProc) if ((myHp[i] ?? 0) > 0) myBoost[i] = addBoosts(myBoost[i]!, { atk: 2, spa: 2 });
  for (const j of oppWpProc) if ((oppHp[j] ?? 0) > 0) oppBoost[j] = addBoosts(oppBoost[j]!, { atk: 2, spa: 2 });
  // Intimidate: a mon that switched IN drops the OPPOSING actives' Atk by 1 (through
  // applyDrop, so Intimidate immunity, Contrary, and Defiant all resolve correctly).
  for (const inMon of mySwitchIn.values()) if (t.myIntimidate[inMon]) {
    for (const oj of oppActiveNow) if ((oppHp[oj] ?? 0) > 0) applyDrop(oppBoost, oj, { atk: -1 }, t.oppIntimImmune[oj]!, t.oppAbility[oj], t.oppDefiantStat[oj]!);
  }
  for (const inMon of oppSwitchIn.values()) if (t.oppIntimidate[inMon]) {
    for (const mi of myActiveNow) if ((myHp[mi] ?? 0) > 0) applyDrop(myBoost, mi, { atk: -1 }, t.myIntimImmune[mi]!, t.myAbility[mi], t.myDefiantStat[mi]!);
  }
  // White Herb: once the holder has any lowered stat, restore all negatives to 0 and
  // consume the item (marked in berryUsed → triggers Unburden via the check below).
  const whiteHerb = (boost: BoostMap[], wh: boolean[], used: boolean[], active: number[], hp: number[]) => {
    for (const i of active) {
      if (!wh[i] || used[i] || (hp[i] ?? 0) <= 0 || !hasNeg(boost[i]!)) continue;
      for (const k of ['atk', 'def', 'spa', 'spd', 'spe'] as const) if ((boost[i]![k] ?? 0) < 0) boost[i]![k] = 0;
      used[i] = true;
    }
  };
  whiteHerb(myBoost, t.myWhiteHerb, myBerryUsed, myActiveNow, myHp);
  whiteHerb(oppBoost, t.oppWhiteHerb, oppBerryUsed, oppActiveNow, oppHp);
  // Regenerator: a mon that switched OUT heals 1/3 of its max HP (it left before
  // this turn's hits, so its HP is its start-of-turn value). Makes pivoting heal.
  for (const outMon of mySwitchIn.keys()) if (t.myRegen[outMon] && (myHp[outMon] ?? 0) > 0) myHp[outMon] = Math.min(100, myHp[outMon]! + 100 / 3);
  for (const outMon of oppSwitchIn.keys()) if (t.oppRegen[outMon] && (oppHp[outMon] ?? 0) > 0) oppHp[outMon] = Math.min(100, oppHp[outMon]! + 100 / 3);

  // Entry hazards: a mon that SWITCHED IN this turn (incl. Baton Pass) takes its
  // side's hazard chip + Toxic Spikes status + Sticky Web −1 Spe. Applied before
  // the berry check so a Stealth-Rock drop can trigger Sitrus.
  const applyHazard = (inMon: number, hp: number[], eff: HazardEffect | undefined, statusArr: string[], toxicN: number[], boost: BoostMap[]) => {
    if (!eff || (hp[inMon] ?? 0) <= 0) return;
    if (eff.hpPctLoss) hp[inMon] = Math.max(0, hp[inMon]! - eff.hpPctLoss);
    if (eff.statusApplied && !statusArr[inMon]) { statusArr[inMon] = eff.statusApplied; if (eff.statusApplied === 'tox') toxicN[inMon] = 1; }
    if (eff.boostsApplied) boost[inMon] = addBoosts(boost[inMon]!, eff.boostsApplied);
  };
  // Deliberate switches happen at the START of the turn → they read the
  // start-of-turn hazards (s.my/oppHazards), before any layer set this turn.
  for (const inMon of mySwitchIn.values()) applyHazard(inMon, myHp, hazardEffectFor(s.myHazards, t.mySpecies[inMon]!, t.myAbility[inMon], t.myItem[inMon], s.gravity), myStatus, myToxicN, myBoost);
  for (const inMon of oppSwitchIn.values()) applyHazard(inMon, oppHp, hazardEffectFor(s.oppHazards, t.oppSpecies[inMon]!, t.oppAbility[inMon], t.oppItem[inMon], s.gravity), oppStatus, oppToxicN, oppBoost);

  // HP-trigger consumables (Sitrus heal 25% @ ≤50%, pinch berries +1 stat @ ≤25%)
  // fire on the FALLING edge across this turn (start HP → end HP), one-time. Heal
  // adds HP; a pinch boost feeds the dynamic boost map (which scales damage/speed).
  const berryHp = (prev: number[], cur: number[], boost: BoostMap[], berryUsed: boolean[], item: (string | undefined)[], active: number[]) => {
    for (const i of active) {
      if (berryUsed[i] || !isHpItemTriggerItem(item[i])) continue;
      const trig = hpItemTriggerFor(item[i], prev[i] ?? 100, cur[i]!);
      if (!trig) continue;
      berryUsed[i] = true;
      if (trig.healPercent) cur[i] = Math.min(100, cur[i]! + trig.healPercent);
      if (trig.boost) boost[i] = addBoosts(boost[i]!, { [trig.boost.stat]: trig.boost.amount } as BoostMap);
    }
  };
  berryHp(s.myHp, myHp, myBoost, myBerryUsed, t.myItem, myActiveNow);
  berryHp(s.oppHp, oppHp, oppBoost, oppBerryUsed, t.oppItem, oppActiveNow);
  // Unburden: any item consumed THIS turn (White Herb / berry; berryUsed went
  // false→true) on an Unburden holder doubles its Speed from next ply.
  for (const i of myActiveNow) if (t.myHasUnburden[i] && !s.myBerryUsed[i] && myBerryUsed[i]) myUnburden[i] = true;
  for (const j of oppActiveNow) if (t.oppHasUnburden[j] && !s.oppBerryUsed[j] && oppBerryUsed[j]) oppUnburden[j] = true;

  // Start from the post-switch slots, then refill from bench after KOs. The opp
  // only auto-refills with ALREADY-REVEALED mons — an unrevealed phantom enters
  // solely via a deliberate root switch (otherwise refill would silently reveal
  // more than the 4 brought).
  // Forced-switch items (Red Card / Eject Button / Eject Pack): a holder hit this
  // turn (single-target) swaps to its side's best live bench mon — Eject = the
  // HOLDER leaves; Red Card = the ATTACKER leaves. The incoming mon enters fresh
  // (cleared boosts) and eats hazards via the post-refill loops below. Bounded to
  // the single-target hits we tracked; the leaving mon survives on the bench.
  const myActiveForced = myActiveNow.slice();
  const oppActiveForced = oppActiveNow.slice();  const doForce = (outIdx: number, active: number[], hp: number[], n: number, off: Cell[][], foeHp: number[], boost: BoostMap[], eligible?: boolean[]) => {
    if ((hp[outIdx] ?? 0) <= 0) return;                     // fainted → refill handles it
    const pos = active.indexOf(outIdx); if (pos < 0) return; // not on the field
    const bench = pickBench(active, hp, n, off, foeHp, eligible);
    if (bench == null) return;
    active[pos] = bench; boost[outIdx] = {}; boost[bench] = {};
  };
  for (const [tgt, big] of myBigHit) {
    if (isEjectItem(t.myItem[tgt])) doForce(tgt, myActiveForced, myHp, t.myN, t.off, oppHp, myBoost);
    else if (isRedCardItem(t.myItem[tgt])) doForce(big.atk, oppActiveForced, oppHp, t.oppN, t.thr, myHp, oppBoost, oppSeen);
  }
  for (const [tgt, big] of oppBigHit) {
    if (isEjectItem(t.oppItem[tgt])) doForce(tgt, oppActiveForced, oppHp, t.oppN, t.thr, myHp, oppBoost, oppSeen);
    else if (isRedCardItem(t.oppItem[tgt])) doForce(big.atk, myActiveForced, myHp, t.myN, t.off, oppHp, myBoost);
  }
  const myActive = refill(myActiveForced, myHp, t.myN, t.off, oppHp);
  const oppActive = refill(oppActiveForced, oppHp, t.oppN, t.thr, myHp, oppSeen);
  // A replacement brought in after a faint enters at EOT and eats the hazards
  // present NOW (the post-set copies) — this is what makes a hazard set this turn
  // (incl. Stone Axe's SR) actually bite the opponent's next mon.
  for (const inMon of myActive) if (!myActiveNow.includes(inMon))
    applyHazard(inMon, myHp, hazardEffectFor(myHazards, t.mySpecies[inMon]!, t.myAbility[inMon], t.myItem[inMon], gravity), myStatus, myToxicN, myBoost);
  for (const inMon of oppActive) if (!oppActiveNow.includes(inMon))
    applyHazard(inMon, oppHp, hazardEffectFor(oppHazards, t.oppSpecies[inMon]!, t.oppAbility[inMon], t.oppItem[inMon], gravity), oppStatus, oppToxicN, oppBoost);
  // First-turn-out next ply: every mon that switched/refilled in this turn (gates
  // Fake Out's flinch).
  const myFirstTurn = s.myFirstTurn.map(() => false);
  const oppFirstTurn = s.oppFirstTurn.map(() => false);
  for (const inn of mySwitchIn.values()) myFirstTurn[inn] = true;
  for (const inn of oppSwitchIn.values()) oppFirstTurn[inn] = true;
  for (const inn of myActive) if (!myActiveNow.includes(inn)) myFirstTurn[inn] = true;
  for (const inn of oppActive) if (!oppActiveNow.includes(inn)) oppFirstTurn[inn] = true;
  return {
    myHp, oppHp, myActive, oppActive, myProtectStreak, oppProtectStreak, oppSeen,
    trickRoom, myTailwind, theirTailwind, trickRoomTurns, myTailwindTurns, theirTailwindTurns,
    mySeeded, oppSeeded, myBoost, oppBoost,
    myReflect, myLightScreen, theirReflect, theirLightScreen,
    myReflectTurns, myLightScreenTurns, theirReflectTurns, theirLightScreenTurns,
    weather, weatherTurns, terrain, terrainTurns, myToxicN, oppToxicN, myStatus, oppStatus,
    myBerryUsed, oppBerryUsed, myHazards, oppHazards, mySleepTurns, oppSleepTurns,
    myTaunt, oppTaunt, myEncore, oppEncore, myEncoreAct, oppEncoreAct,
    myUnburden, oppUnburden, myResistBerryUsed, oppResistBerryUsed, myFirstTurn, oppFirstTurn,
    myDisguise, oppDisguise, myRecharge, oppRecharge, myLocked, oppLocked, mySubHp, oppSubHp,
    myWish, oppWish, myFutureTurns, oppFutureTurns, myFutureDmg, oppFutureDmg,
    gravity, wonderRoom, magicRoom, gravityTurns, wonderRoomTurns, magicRoomTurns,
  };
}

// Keep up to MAX_ACTIVE live mons on the field. Drop fainted actives; bring in
// the live benched mon with the best total damage vs the current live foes.
// `eligible` (the opp's seen mask) restricts which bench mons can be auto-brought.
function refill(
  active: number[],
  hp: number[],
  n: number,
  dmgRows: Cell[][],     // dmgRows[mon][foe]
  foeHp: number[],
  eligible?: boolean[],
): number[] {
  const live = active.filter(i => hp[i]! > 0);
  if (live.length >= MAX_ACTIVE) return live.slice(0, MAX_ACTIVE);
  const onField = new Set(live);
  const liveFoes: number[] = foeHp.map((h, j) => (h > 0 ? j : -1)).filter(j => j >= 0);
  while (live.length < MAX_ACTIVE) {
    let best = -1;
    let bestDmg = -1;
    for (let i = 0; i < n; i++) {
      if (hp[i]! <= 0 || onField.has(i)) continue;
      if (eligible && !eligible[i]) continue;     // unrevealed phantom — not auto-brought
      const total = liveFoes.reduce((acc, j) => acc + (dmgRows[i]?.[j]?.dmgMid ?? 0), 0);
      if (total > bestDmg) { bestDmg = total; best = i; }
    }
    if (best < 0) break;       // no bench left
    live.push(best);
    onField.add(best);
  }
  return live;
}

// All joint target assignments for a side's live actives (cartesian product of
// each active's options). Each active's options are the foes ON THE FIELD
// (`foeActive`, filtered to live) for single-target moves, plus the SPREAD
// sentinel (for spread actors), the PROTECT sentinel, root switch/field moves.
// Single-target moves can only hit a mon IN AN ACTIVE SLOT — never a benched or
// unrevealed mon, even though those carry damage cells for switch-in modelling.
// Empty when there are no live foes on the field.
function jointActions(
  active: number[],
  foeActive: number[],
  foeHp: number[],
  spreadActors?: Set<number>,
  protectMoves?: (string | null)[],
  protectStreak?: number[],
  // Benched team-indices this side may switch into THIS ply (root only; empty
  // or undefined ⇒ no switch options, the deeper-ply behaviour).
  switchTargets?: number[],
  // Per-actor order-field-move capability (root only). A non-null entry means the
  // mon can set Tailwind / Trick Room this ply.
  fieldMoves?: { tailwind?: (string | null)[]; trickRoom?: (string | null)[] },
  // Leech Seed (root only): per-actor capability + the active foe indices that
  // can still be seeded (live, not Grass, not already seeded).
  leech?: { move: (string | null)[]; foes: number[] },
  // Setup move capability (root only): a non-null entry → the mon can set up.
  setupMove?: (string | null)[],
  // Baton Pass (root only): per-actor capability + benched team-indices to pass to.
  baton?: { move: (string | null)[]; targets: number[] },
  // Screen capability (root only): a true entry → the mon can usefully set a
  // screen (knows one + it's not already fully up on its side).
  screenSet?: boolean[],
  // Weather capability (root only): a true entry → the mon can usefully set
  // weather (knows a weather move + it'd change the current weather).
  weatherSet?: boolean[],
  // Terrain capability (root only): same idea as weather.
  terrainSet?: boolean[],
  // Status moves (root only): per-actor capability + the active foe indices that
  // can still be given a status (alive, not already statused).
  status?: { move: (StatusMove | null)[]; foes: number[] },
  // Recovery capability (root only): a true entry → the mon can usefully heal
  // (knows a recovery move + isn't at full HP).
  recoverSet?: boolean[],
  // Hazard-setting capability (root only): a true entry → the mon can usefully
  // lay a hazard on the foe's side (knows one + that layer isn't already maxed).
  hazardSet?: boolean[],
  // Asleep mask (all plies): an asleep mon's ONLY action is the SLEEP_SKIP no-op.
  asleep?: boolean[],
  // Redirection capability (all plies): a non-null entry → the mon knows Follow Me /
  // Rage Powder and can pull the foes' single-target moves onto itself.
  redirectMove?: (string | null)[],
  // Pivot capability (root only): per-actor pivot move + the foe indices it can hit
  // (empty when the side has no bench to switch into → no pivot offered).
  pivot?: { move: (string | null)[]; foes: number[] },
  // Dedicated debuff capability (root only): per-actor move + the foe indices to debuff.
  debuff?: { move: ({ move: string; boosts: BoostMap } | null)[]; foes: number[] },
  // Option-restriction state (all plies): a taunted (or Choice-locked) mon may only
  // attack/spread/switch; an encored mon may only repeat `encoreAct`. (Choice's true
  // single-move lock needs per-move cells — this is the tractable subset.)
  restrict?: { taunt: boolean[]; encore: boolean[]; encoreAct: number[]; choice?: boolean[]; locked?: boolean[] },
  // Taunt/Encore CAST capability (root only): per-actor move + foe indices.
  tauntEncore?: { taunt: (string | null)[]; encore: (string | null)[]; foes: number[] },
  // Fake Out (root only): offered when the mon knows it AND is on its first turn out.
  fakeOut?: { has: boolean[]; firstTurn: boolean[]; foes: number[] },
  // Priority attack (all plies): the prio cell per actor×foe. `koOnly` gates it to
  // KO-securing priority (used at depth to bound branching); at the root it's
  // offered for any damaging priority move. cell indexed [actor][foe].
  prio?: { cell: (Cell | null)[][]; foes: number[]; koOnly?: boolean },
  // Helping Hand (root only): a true entry → the mon knows it AND has a live ally to
  // boost. The live-partner gate is computed by the caller (jointActions only sees
  // the foe's HP).
  helpHand?: boolean[],
  // Wide Guard / Quick Guard (root only): per-actor knows-it. Team-protect that
  // blocks the foes' spread / priority moves for the turn.
  guard?: { wide: boolean[]; quick: boolean[] },
  // Strength Sap (root only): per-actor knows-it (heal + foe Atk −1).
  strengthSap?: boolean[],
  // Hazard clear (root only): a true entry → the mon knows Rapid Spin/Defog/etc.
  // AND its own side has hazards worth removing.
  hazardClear?: boolean[],
  // Substitute (root only): a true entry → the mon knows Substitute, is above 25%
  // HP, and has no sub up.
  subSet?: boolean[],
  // Counter (root only): a true entry → the mon knows Counter / Mirror Coat /
  // Metal Burst (reflect damage taken this turn).
  counterSet?: boolean[],
  // Room (root only): a true entry → the mon can set a not-yet-active field room.
  roomSet?: boolean[],
): Array<Map<number, number>> {
  const liveFoes = foeActive.filter(j => (foeHp[j] ?? 0) > 0);
  if (liveFoes.length === 0) return [];
  const switchCodes = (switchTargets ?? []).map(switchCode);
  // Bench index a switch/baton code resolves to (for the no-duplicate rule).
  const benchOf = (code: number) => isSwitchTarget(code) ? switchBenchIdx(code) : isBatonTarget(code) ? batonBenchIdx(code) : -999;
  let combos: Array<Map<number, number>> = [new Map()];
  for (const actor of active) {
    // Asleep → forced no-op; no other options this turn.
    if (asleep?.[actor]) {
      const next: Array<Map<number, number>> = [];
      for (const combo of combos) { const m = new Map(combo); m.set(actor, SLEEP_SKIP); next.push(m); }
      combos = next;
      continue;
    }
    // Encored → forced to repeat the locked move.
    if (restrict?.encore[actor]) {
      const next: Array<Map<number, number>> = [];
      for (const combo of combos) { const m = new Map(combo); m.set(actor, restrict.encoreAct[actor]!); next.push(m); }
      combos = next;
      continue;
    }
    const canRedirect = redirectMove?.[actor] != null;
    const canProtect = (protectMoves?.[actor] != null) && (protectStreak?.[actor] ?? 0) === 0;
    const canTailwind = fieldMoves?.tailwind?.[actor] != null;
    const canTrickRoom = fieldMoves?.trickRoom?.[actor] != null;
    const leechCodes = (leech && leech.move[actor] != null) ? leech.foes.map(leechCode) : [];
    const canSetup = setupMove?.[actor] != null;
    const canScreen = screenSet?.[actor] === true;
    const canWeather = weatherSet?.[actor] === true;
    const canTerrain = terrainSet?.[actor] === true;
    const canRecover = recoverSet?.[actor] === true;
    const canHazard = hazardSet?.[actor] === true;
    const statusCodes = (status && status.move[actor] != null) ? status.foes.map(statusCode) : [];
    const pivotCodes = (pivot && pivot.move[actor] != null) ? pivot.foes.map(pivotCode) : [];
    const debuffCodes = (debuff && debuff.move[actor] != null) ? debuff.foes.map(debuffCode) : [];
    const tauntCodes = (tauntEncore && tauntEncore.taunt[actor] != null) ? tauntEncore.foes.map(tauntCode) : [];
    const encoreCodes = (tauntEncore && tauntEncore.encore[actor] != null) ? tauntEncore.foes.map(encoreCode) : [];
    const fakeOutCodes = (fakeOut && fakeOut.has[actor] && fakeOut.firstTurn[actor]) ? fakeOut.foes.map(fakeOutCode) : [];
    // Priority attack. At the ROOT (koOnly false) it's offered for any damaging
    // priority move (the recommendation should see the chip-then-partner-KO line);
    // at DEPTH (koOnly true) it's gated to "can KO the foe at current HP" so the
    // lookahead branching stays sparse.
    const prioCodes = prio ? prio.foes.filter(j => {
      const pc = prio.cell[actor]?.[j];
      return !!pc && pc.dmgMax > 0 && (!prio.koOnly || pc.dmgMax >= (foeHp[j] ?? 0));
    }).map(prioCode) : [];
    const canHelp = helpHand?.[actor] === true;
    const canWideGuard = guard?.wide[actor] === true;
    const canQuickGuard = guard?.quick[actor] === true;
    const canSap = strengthSap?.[actor] === true;
    const canClearHazard = hazardClear?.[actor] === true;
    const canSub = subSet?.[actor] === true;
    const canCounter = counterSet?.[actor] === true;
    const canRoom = roomSet?.[actor] === true;
    const batonCodes = (baton && baton.move[actor] != null) ? baton.targets.map(batonCode) : [];
    // SPREAD first so a spread that ties a single-target line is kept. PROTECT /
    // field / setup / screen / weather / Leech / SWITCH / Baton last — only chosen
    // when they strictly beat attacking.
    const options = [
      ...(spreadActors?.has(actor) ? [SPREAD] : []),
      ...liveFoes,
      ...(canProtect ? [PROTECT] : []),
      ...(canTailwind ? [SET_TAILWIND] : []),
      ...(canTrickRoom ? [SET_TRICKROOM] : []),
      ...(canSetup ? [SET_BOOST] : []),
      ...(canScreen ? [SET_SCREEN] : []),
      ...(canWeather ? [SET_WEATHER] : []),
      ...(canTerrain ? [SET_TERRAIN] : []),
      ...(canRecover ? [RECOVER] : []),
      ...(canHazard ? [SET_HAZARD] : []),
      ...(canHelp ? [HELP_HAND] : []),
      ...(canWideGuard ? [WIDE_GUARD] : []),
      ...(canQuickGuard ? [QUICK_GUARD] : []),
      ...(canSap ? [SAP] : []),
      ...(canClearHazard ? [CLEAR_HAZARD] : []),
      ...(canSub ? [SET_SUB] : []),
      ...(canCounter ? [COUNTER] : []),
      ...(canRoom ? [SET_ROOM] : []),
      ...(canRedirect ? [REDIRECT] : []),
      ...leechCodes,
      ...statusCodes,
      ...pivotCodes,
      ...debuffCodes,
      ...tauntCodes,
      ...encoreCodes,
      ...fakeOutCodes,
      ...prioCodes,
      ...switchCodes,
      ...batonCodes,
    ];
    // Locked into a multi-turn move (Outrage) → ONLY attacking options (no switch).
    // Taunted / Choice-locked → attacking/spread/switch (no setup/status/protect).
    const usable = restrict?.locked?.[actor]
      ? options.filter(o => o >= 0 || o === SPREAD || isPrioTarget(o))
      : (restrict?.taunt[actor] || restrict?.choice?.[actor])
        ? options.filter(o => o >= 0 || o === SPREAD || isSwitchTarget(o) || isPrioTarget(o))
        : options;
    const next: Array<Map<number, number>> = [];
    for (const combo of combos) {
      for (const opt of usable) {
        // Doubles legality: two actives can't switch/Baton-Pass into the SAME mon.
        if (isSwitchTarget(opt) || isBatonTarget(opt)) {
          const bench = benchOf(opt);
          let dup = false;
          for (const v of combo.values()) if (benchOf(v) === bench) { dup = true; break; }
          if (dup) continue;
        }
        const m = new Map(combo);
        m.set(actor, opt);
        next.push(m);
      }
    }
    combos = next;
  }
  return combos;
}

// ---------------------------------------------------------------------------
// Evaluation + search
// ---------------------------------------------------------------------------

// Live-mon / total-HP counts. A `seen` mask (used for the opponent) excludes
// UNREVEALED phantom switch-ins — a known-but-not-yet-brought mon is a possible
// switch target, NOT standing material, so it must not count toward the opp's
// force until it's actually switched in (which flips its `seen` flag).
function liveCount(hp: number[], seen?: boolean[]): number {
  return hp.reduce((n, h, i) => n + (h > 0 && (!seen || seen[i]!) ? 1 : 0), 0);
}
function sumHp(hp: number[], seen?: boolean[]): number {
  return hp.reduce((s, h, i) => s + (!seen || seen[i]! ? Math.max(0, h) : 0), 0);
}

// Terminal value if a side is wiped, else null. `depth` (plies remaining) makes
// faster wins / slower losses preferable. The opp side counts only SEEN mons.
function terminal(s: State, depth: number): number | null {
  const myLive = liveCount(s.myHp);
  const oppLive = liveCount(s.oppHp, s.oppSeen);
  if (oppLive === 0 && myLive === 0) return 0;
  if (oppLive === 0) return WIN + depth;
  if (myLive === 0) return -(WIN + depth);
  return null;
}

function leafScore(s: State): number {
  return (liveCount(s.myHp) - liveCount(s.oppHp, s.oppSeen)) * MATERIAL
    + (sumHp(s.myHp) - sumHp(s.oppHp, s.oppSeen));
}

// Cheap immediate-damage heuristic for a joint action (sum of the baked cell
// dmgMid for its attacks; non-attacks score 0). Used ONLY to order evaluation —
// it never changes the maximin result, just how fast the worst<=best cutoff fires.
function jointDamageHeuristic(joint: Map<number, number>, off: Cell[][], spread: (SpreadOpt | null)[], prio: (Cell | null)[][]): number {
  let total = 0;
  for (const [actor, target] of joint) {
    if (target === SPREAD) { const sp = spread[actor]; if (sp) for (const d of sp.dmgMid) total += d ?? 0; }
    else if (isPrioTarget(target)) total += prio[actor]?.[prioFoeIdx(target)]?.dmgMid ?? 0;
    else if (isFakeOutTarget(target)) total += 5;   // small nudge so Fake Out sorts above pure status
    else if (target >= 0) total += off[actor]?.[target]?.dmgMid ?? 0;
  }
  return total;
}
// Order joints best-first by the heuristic (descending). Stable-ish; ties keep
// enumeration order. Returns a new array; inputs untouched.
function orderJoints(joints: Array<Map<number, number>>, off: Cell[][], spread: (SpreadOpt | null)[], prio: (Cell | null)[][]): Array<Map<number, number>> {
  if (joints.length <= 1) return joints;
  return joints
    .map((j, i) => ({ j, i, d: jointDamageHeuristic(j, off, spread, prio) }))
    .sort((a, b) => (b.d - a.d) || (a.i - b.i))
    .map(x => x.j);
}

// Complete transposition key for value(): every State field that can change the
// result, PLUS depth + maxDepth (switch availability is gated by plyFromRoot =
// maxDepth − depth) + the pass (regime + opp-survival vector flip the damage/KO
// model). Missing ANY value-affecting field would serve a stale value, so this is
// exhaustive over State. Built per node; a hit skips the whole subtree, so the
// build cost is amortised.
function ttKey(s: State, depth: number, maxDepth: number, pass: Pass): string {
  const nb = (a: number[]) => a.join('.');
  const bl = (a: boolean[]) => a.map(x => (x ? 1 : 0)).join('');
  const nn = (a: (number | null)[]) => a.map(x => (x == null ? 'n' : x)).join('.');
  const bk = (b: BoostMap) => `${b.atk ?? 0},${b.def ?? 0},${b.spa ?? 0},${b.spd ?? 0},${b.spe ?? 0}`;
  const bs = (a: BoostMap[]) => a.map(bk).join(';');
  return [
    depth, maxDepth, pass.regime, bl(pass.survOpp), bl(pass.survMy),
    nb(s.myHp), nb(s.oppHp), nb(s.myActive), nb(s.oppActive), bl(s.oppSeen),
    s.myStatus.join(''), s.oppStatus.join(''), nb(s.myToxicN), nb(s.oppToxicN), nb(s.mySleepTurns), nb(s.oppSleepTurns),
    bs(s.myBoost), bs(s.oppBoost), nn(s.mySeeded), nn(s.oppSeeded),
    nb(s.myProtectStreak), nb(s.oppProtectStreak),
    `${s.trickRoom ? 1 : 0}${s.myTailwind ? 1 : 0}${s.theirTailwind ? 1 : 0}`,
    `${s.trickRoomTurns ?? -1}.${s.myTailwindTurns ?? -1}.${s.theirTailwindTurns ?? -1}`,
    `${s.myReflect ? 1 : 0}${s.myLightScreen ? 1 : 0}${s.theirReflect ? 1 : 0}${s.theirLightScreen ? 1 : 0}`,
    `${s.myReflectTurns ?? -1}.${s.myLightScreenTurns ?? -1}.${s.theirReflectTurns ?? -1}.${s.theirLightScreenTurns ?? -1}`,
    `${s.weather}.${s.weatherTurns ?? -1}.${s.terrain}.${s.terrainTurns ?? -1}`,
    bl(s.myBerryUsed), bl(s.oppBerryUsed), bl(s.myResistBerryUsed), bl(s.oppResistBerryUsed),
    bl(s.myUnburden), bl(s.oppUnburden), bl(s.myFirstTurn), bl(s.oppFirstTurn), bl(s.myDisguise), bl(s.oppDisguise),
    bl(s.myRecharge), bl(s.oppRecharge), nb(s.myLocked), nb(s.oppLocked), nb(s.mySubHp), nb(s.oppSubHp),
    nb(s.myWish), nb(s.oppWish), nb(s.myFutureTurns), nb(s.oppFutureTurns), nb(s.myFutureDmg), nb(s.oppFutureDmg),
    nb(s.myTaunt), nb(s.oppTaunt), nb(s.myEncore), nb(s.oppEncore), nb(s.myEncoreAct), nb(s.oppEncoreAct),
    `${s.gravity ? 1 : 0}${s.wonderRoom ? 1 : 0}${s.magicRoom ? 1 : 0}`,
    `${s.gravityTurns ?? -1}.${s.wonderRoomTurns ?? -1}.${s.magicRoomTurns ?? -1}`,
    JSON.stringify(s.myHazards), JSON.stringify(s.oppHazards),
  ].join('|');
}

// Maximin value of a state to the given depth: I maximise, the opponent replies
// worst-case. `alpha`/`beta` are the inherited fail-soft window — the floor the
// caller already guarantees and the ceiling above which the caller (a MIN) stops
// caring. Returns the exact maximin within that window; fail-soft outside it.
function value(t: Tables, s: State, depth: number, alpha: number, beta: number, pass: Pass, maxDepth: number): number {
  const term = terminal(s, depth);
  if (term !== null) return term;
  if (depth === 0) return leafScore(s);

  // Transposition-table probe (~half of internal nodes recur — measured). A cached
  // bound serves the whole subtree: EXACT returns outright; a LOWER bound that
  // already clears beta is a fail-high; an UPPER bound at/below alpha is a fail-low.
  // Otherwise we search and overwrite. Keyed exhaustively (see ttKey) so a hit is
  // always for an identical state at this depth/ply/pass — no stale reuse.
  const tt = t.tt;
  const ttk = tt ? ttKey(s, depth, maxDepth, pass) : '';
  if (tt) {
    const e = tt.get(ttk);
    if (e) {
      if (e.flag === 0) return e.value;
      if (e.flag === 1 && e.value >= beta) return e.value;
      if (e.flag === 2 && e.value <= alpha) return e.value;
    }
  }

  // Deeper plies: no root-only actions (field/setup/…), but Taunt/Encore
  // RESTRICTIONS persist, so pass the restrict mask (param 22; the intervening
  // root-only params are undefined). Sleep is handled by the in-loop guard.
  // Priority attacks ARE offered at depth (param 25) — gated to "can KO the foe
  // at current HP" inside jointActions, so the lookahead value foresees a
  // priority revenge-KO (e.g. Sucker Punch punishing my setup) without exploding
  // branching. Damaging-move only, consistent with the rest of the deep model.
  const U = undefined;
  // Switches at the first SWITCH_PLY_LIMIT deeper plies (Step B). Affordable now
  // that each opp mon is a coarse K-spread profile (Step A) and the bench/phantom
  // damage cells are already built at the root — so this only enables enumeration.
  // Lets the lookahead see "I switch my wall in next turn" and "they pivot to their
  // answer (incl. an unrevealed mon)", while the deep tail stays switch-free.
  const plyFromRoot = maxDepth - depth;
  const switchesAllowed = plyFromRoot < (t.switchPlyLimit ?? SWITCH_PLY_LIMIT);
  const myBench = switchesAllowed ? benchSwitchTargets(s.myActive, s.myHp, t.myN) : U;
  const oppBench = switchesAllowed ? benchSwitchTargets(s.oppActive, s.oppHp, t.oppN) : U;
  const myRestrict = { taunt: s.myTaunt.map(x => x > 0), encore: s.myEncore.map(x => x > 0), encoreAct: s.myEncoreAct, choice: t.myChoice, locked: s.myLocked.map(x => x > 0) };
  const oppRestrict = { taunt: s.oppTaunt.map(x => x > 0), encore: s.oppEncore.map(x => x > 0), encoreAct: s.oppEncoreAct, choice: t.oppChoice, locked: s.oppLocked.map(x => x > 0) };
  const myPrio = { cell: t.myPrioCell, foes: s.oppActive.filter(j => (s.oppHp[j] ?? 0) > 0), koOnly: true };
  const oppPrio = { cell: t.oppPrioCell, foes: s.myActive.filter(i => (s.myHp[i] ?? 0) > 0), koOnly: true };
  // Support moves at depth too (Helping Hand / Wide Guard / Quick Guard): bounded
  // because only the few mons that know them add an option.
  const myHelp = t.myHelpingHand.map((kn, i) => kn && s.myActive.some(j => j !== i && (s.myHp[j] ?? 0) > 0));
  const oppHelp = t.oppHelpingHand.map((kn, j) => kn && s.oppActive.some(i => i !== j && (s.oppHp[i] ?? 0) > 0));
  const myGuard = { wide: t.myWideGuard, quick: t.myQuickGuard };
  const oppGuard = { wide: t.oppWideGuard, quick: t.oppQuickGuard };
  const myJoints = jointActions(s.myActive, s.oppActive, s.oppHp, t.mySpreadActors, t.myProtectMove, s.myProtectStreak, myBench, U, U, U, U, U, U, U, U, U, U, U, U, U, U, myRestrict, U, U, myPrio, myHelp, myGuard);
  const oppJoints = jointActions(s.oppActive, s.myActive, s.myHp, t.oppSpreadActors, t.oppProtectMove, s.oppProtectStreak, oppBench, U, U, U, U, U, U, U, U, U, U, U, U, U, U, oppRestrict, U, U, oppPrio, oppHelp, oppGuard);
  if (myJoints.length === 0) return leafScore(s);

  // Move ordering for sharper alpha-beta (no options dropped — exact same result,
  // fewer nodes): my highest-damage joint first so `best` climbs fast; the
  // opponent's most-threatening reply first so `worst` plunges fast — together the
  // worst<=best cutoff fires far sooner, collapsing the inner loop for losing lines.
  const myOrdered = orderJoints(myJoints, t.off, t.mySpread, t.myPrioCell);
  const oppOrdered = orderJoints(oppJoints, t.thr, t.oppSpread, t.oppPrioCell);
  // Fail-soft alpha-beta over the per-turn max(my)–min(opp) tree. `alpha` is the
  // floor the caller already guarantees; `beta` the ceiling above which the caller
  // (a MIN) stops caring. Threading BOTH down — not just the node-local `best` —
  // is what collapses the deep tree: a my-joint whose worst can't clear `floor`
  // is abandoned, and a node that climbs past `beta` is cut wholesale. The maximin
  // value is unchanged; only the node count drops (exact).
  let best = -Infinity;
  for (const my of myOrdered) {
    let worst = Infinity;
    const floor = Math.max(alpha, best);   // below this, this my-joint is moot
    const replies = oppOrdered.length ? oppOrdered : [new Map<number, number>()];
    for (const opp of replies) {
      const child = resolveTurn(t, s, my, opp, pass);
      // The child only matters if its value lands in (floor, worst); hand it that
      // window so it can fail-high/low without a full expansion.
      const v = value(t, child, depth - 1, floor, Math.min(beta, worst), pass, maxDepth);
      if (v < worst) worst = v;
      if (worst <= floor) break;   // this my-joint can't lift the node above floor — prune
    }
    if (worst > best) best = worst;
    if (best >= beta) break;       // fail-high: the parent MIN rejects this node — cut
  }
  // Store the fail-soft bound: below alpha ⇒ upper bound, at/above beta ⇒ lower
  // bound, strictly inside the window ⇒ exact maximin value.
  if (tt) tt.set(ttk, { value: best, flag: best <= alpha ? 2 : best >= beta ? 1 : 0 });
  return best;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Active-slot shape (team indices currently on the field, per side). */
export interface ActiveSlots {
  mine: [number | null, number | null];
  theirs: [number | null, number | null];
}

// Focus Sash / Sturdy survival for one of MY mons (items/abilities are known,
// so prob is 1 or undefined).
function mySurvival(set: PokemonSet): Survival | undefined {
  if (set.item && /focus\s*sash/i.test(set.item)) return { prob: 1, label: 'Focus Sash' };
  if (set.ability && toId(set.ability) === 'sturdy') return { prob: 1, label: 'Sturdy' };
  return undefined;
}
// Probabilistic survival for an opponent: a confirmed Sturdy/Sash → prob 1; a
// consumed/other known item → none; otherwise the Pikalytics usage rate of
// Focus Sash as a prior.
function oppSurvival(entry: OpponentEntry): Survival | undefined {
  if (entry.itemConsumed) return undefined;
  if (entry.ability && toId(entry.ability) === 'sturdy') return { prob: 1, label: 'Sturdy' };
  if (entry.item) return /focus\s*sash/i.test(entry.item) ? { prob: 1, label: 'Focus Sash' } : undefined;
  const sash = getPikalytics(entry.species)?.items?.find(i => /focus\s*sash/i.test(i.name));
  return sash && sash.pct > 0 ? { prob: Math.min(1, sash.pct / 100), label: 'Focus Sash' } : undefined;
}

/**
 * Build a SearchInput from the live Match + active slots. My side is the
 * brought 4 (live only); the opponent is the mons we've actually seen
 * (`opponentBrought`). My HP is stored raw (→ converted to %); the opponent's
 * is already a %. Benched-but-live mons are included so the search can model
 * replacements after a KO.
 */
export function searchInputFromMatch(match: Match, active: ActiveSlots): SearchInput {
  const myActive = new Set<number>(active.mine.filter((x): x is number => x != null));
  const oppActive = new Set<number>(active.theirs.filter((x): x is number => x != null));

  const mine: SearchMyMon[] = [];
  const myTeamIdx: number[] = [];               // search index → myTeam index
  for (const idx of match.bring) {
    const set = match.myTeam[idx];
    if (!set) continue;
    if (match.myFainted?.includes(idx)) continue;
    const raw = match.myCurrentHp?.[idx];
    const max = maxHpFor(set);
    const hpPercent = raw == null || max <= 0 ? 100 : Math.max(0, Math.min(100, (raw / max) * 100));
    mine.push({
      set, hpPercent, active: myActive.has(idx), megaActive: match.myMegaUsed?.includes(idx),
      boosts: match.myBoosts?.[idx], status: match.myStatus?.[idx], survival: mySurvival(set),
      // Fake Out / First Impression eligibility — true until the mon moves after entry.
      firstTurnOut: myActive.has(idx) && firstTurnOut(match, 'mine', idx),
    });
    myTeamIdx.push(idx);
  }

  const opp: SearchOppMon[] = [];
  const oppTeamIdx: number[] = [];              // search index → opponentTeam index
  for (const idx of match.opponentBrought ?? []) {
    const entry = match.opponentTeam[idx];
    if (!entry) continue;
    const hpPercent = entry.fainted ? 0 : (entry.currentHpPercent ?? 100);
    opp.push({
      entry, hpPercent, active: oppActive.has(idx), megaActive: entry.megaUsed,
      boosts: entry.currentBoosts, status: entry.status, survival: oppSurvival(entry),
      firstTurnOut: oppActive.has(idx) && firstTurnOut(match, 'theirs', idx),
    });
    oppTeamIdx.push(idx);
  }

  // Thread EXISTING Leech Seeds (from the live match) into the search. `seededBy`
  // is the seeder's SEARCH index on the other side; -1 = seeded but the seeder
  // isn't in the live search set (drain still applies, but no heal target).
  const oppSearchOf = (teamIdx: number) => { const i = oppTeamIdx.indexOf(teamIdx); return i >= 0 ? i : -1; };
  const mySearchOf = (teamIdx: number) => { const i = myTeamIdx.indexOf(teamIdx); return i >= 0 ? i : -1; };
  myTeamIdx.forEach((ti, si) => {
    const seed = match.myLeechSeeded?.[ti];
    if (seed) mine[si]!.seededBy = seed.seederSide === 'theirs' ? oppSearchOf(seed.seederIndex) : -1;
  });
  oppTeamIdx.forEach((ti, oi) => {
    const seed = match.opponentTeam[ti]?.leechSeeded;
    if (seed) opp[oi]!.seededBy = seed.seederSide === 'mine' ? mySearchOf(seed.seederIndex) : -1;
  });

  // Known opponents we haven't seen brought in yet — potential switch-ins.
  const broughtSet = new Set<number>(match.opponentBrought ?? []);
  const oppBench: OpponentEntry[] = [];
  match.opponentTeam.forEach((entry, idx) => {
    if (!broughtSet.has(idx) && entry && !entry.fainted) oppBench.push(entry);
  });

  return {
    mine, opp, field: match.field,
    myMegaSpent: (match.myMegaUsed?.length ?? 0) > 0,
    oppMegaSpent: match.opponentTeam.some(o => o.megaUsed),
    // VGC brings 4; until we've seen all 4 we can't claim a forced game win.
    allOppRevealed: (match.opponentBrought?.length ?? 0) >= 4,
    oppBench,
  };
}

// Root-ply joint actions INCLUDING voluntary switches (deeper plies stay
// switch-free, via plain jointActions). Switch targets are the side's benched
// live mons — for the opponent that's its revealed-but-retreated mons (the only
// opp entries the tables cover today); unrevealed-roster switch-ins are a
// separate, gated extension. Shared by rootSearch, the opp PV, and the breadth
// report so they all agree on the action space.
function rootMyJoints(t: Tables, s: State): Array<Map<number, number>> {
  // Foes I can still Leech Seed: on the field, alive, not Grass, not already seeded.
  const leechFoes = s.oppActive.filter(j => (s.oppHp[j] ?? 0) > 0 && !t.oppGrass[j] && s.oppSeeded[j] == null);
  const myBench = benchSwitchTargets(s.myActive, s.myHp, t.myN);
  // Screen is useful only if it'd add a screen not already up on my side.
  const myScreenCap = t.myScreen.map(sc => !!sc && ((sc.reflect && !s.myReflect) || (sc.lightScreen && !s.myLightScreen)));
  // Weather is useful only if it'd CHANGE the current weather.
  const myWeatherCap = t.myWeatherMove.map(wm => !!wm && normWeather(wm.weather) !== normWeather(s.weather));
  const myTerrainCap = t.myTerrainMove.map(tm => !!tm && tm.terrain !== s.terrain);
  // Foes I can still inflict a status on: active, alive, not already statused.
  const myStatusFoes = s.oppActive.filter(j => (s.oppHp[j] ?? 0) > 0 && !s.oppStatus[j]);
  // Hazard useful only if it'd add a layer not already maxed on the OPP's side.
  const myHazardCap = t.myHazardMove.map(hm => !!hm && hazardRoom(s.oppHazards, hm.hazard));
  return jointActions(s.myActive, s.oppActive, s.oppHp, t.mySpreadActors, t.myProtectMove, s.myProtectStreak,
    myBench,
    // Don't re-offer Tailwind when it's already up; Trick Room is always a
    // meaningful toggle.
    { tailwind: s.myTailwind ? undefined : t.myTailwindMove, trickRoom: t.myTrickRoomMove },
    { move: t.myLeechMove, foes: leechFoes },
    t.mySetupMove,
    { move: t.myBatonMove, targets: myBench },
    myScreenCap,
    myWeatherCap,
    myTerrainCap,
    { move: t.myStatusMove, foes: myStatusFoes },
    // Recover only when the mon knows one AND is below full HP (mon-indexed).
    t.myRecover.map((rec, i) => !!rec && (s.myHp[i] ?? 100) < 100),
    myHazardCap,
    s.myStatus.map((st, i) => (st === 'slp' && (s.mySleepTurns[i] ?? 0) > 0) || st === 'frz' || s.myRecharge[i] === true),
    t.myRedirectMove,
    { move: t.myPivotMove, foes: myBench.length > 0 ? s.oppActive.filter(j => (s.oppHp[j] ?? 0) > 0) : [] },
    { move: t.myDebuffMove, foes: s.oppActive.filter(j => (s.oppHp[j] ?? 0) > 0) },
    { taunt: s.myTaunt.map(x => x > 0), encore: s.myEncore.map(x => x > 0), encoreAct: s.myEncoreAct, choice: t.myChoice, locked: s.myLocked.map(x => x > 0) },
    { taunt: t.myTauntMove, encore: t.myEncoreMove, foes: s.oppActive.filter(j => (s.oppHp[j] ?? 0) > 0) },
    { has: t.myHasFakeOut, firstTurn: s.myFirstTurn, foes: s.oppActive.filter(j => (s.oppHp[j] ?? 0) > 0) },
    { cell: t.myPrioCell, foes: s.oppActive.filter(j => (s.oppHp[j] ?? 0) > 0) },
    // Helping Hand: only when a live ally is on the field to boost.
    t.myHelpingHand.map((kn, i) => kn && s.myActive.some(j => j !== i && (s.myHp[j] ?? 0) > 0)),
    { wide: t.myWideGuard, quick: t.myQuickGuard },
    t.myStrengthSap,
    t.myHazardClear.map(hc => !!hc && hasAnyHazard(s.myHazards)),
    t.myHasSubMove.map((kn, i) => kn && (s.myHp[i] ?? 0) > 25 && (s.mySubHp[i] ?? 0) <= 0),
    t.myCounter.map(c => !!c),
    t.myRoomMove.map(rm => !!rm && !s[rm]));
}
function rootOppJoints(t: Tables, s: State): Array<Map<number, number>> {
  const leechFoes = s.myActive.filter(j => (s.myHp[j] ?? 0) > 0 && !t.myGrass[j] && s.mySeeded[j] == null);
  const oppBench = benchSwitchTargets(s.oppActive, s.oppHp, t.oppN);
  const oppScreenCap = t.oppScreen.map(sc => !!sc && ((sc.reflect && !s.theirReflect) || (sc.lightScreen && !s.theirLightScreen)));
  const oppWeatherCap = t.oppWeatherMove.map(wm => !!wm && normWeather(wm.weather) !== normWeather(s.weather));
  const oppTerrainCap = t.oppTerrainMove.map(tm => !!tm && tm.terrain !== s.terrain);
  const oppStatusFoes = s.myActive.filter(j => (s.myHp[j] ?? 0) > 0 && !s.myStatus[j]);
  const oppHazardCap = t.oppHazardMove.map(hm => !!hm && hazardRoom(s.myHazards, hm.hazard));
  return jointActions(s.oppActive, s.myActive, s.myHp, t.oppSpreadActors, t.oppProtectMove, s.oppProtectStreak,
    oppBench,
    { tailwind: s.theirTailwind ? undefined : t.oppTailwindMove, trickRoom: t.oppTrickRoomMove },
    { move: t.oppLeechMove, foes: leechFoes },
    t.oppSetupMove,
    { move: t.oppBatonMove, targets: oppBench },
    oppScreenCap,
    oppWeatherCap,
    oppTerrainCap,
    { move: t.oppStatusMove, foes: oppStatusFoes },
    t.oppRecover.map((rec, j) => !!rec && (s.oppHp[j] ?? 100) < 100),
    oppHazardCap,
    s.oppStatus.map((st, j) => (st === 'slp' && (s.oppSleepTurns[j] ?? 0) > 0) || st === 'frz' || s.oppRecharge[j] === true),
    t.oppRedirectMove,
    { move: t.oppPivotMove, foes: oppBench.length > 0 ? s.myActive.filter(i => (s.myHp[i] ?? 0) > 0) : [] },
    { move: t.oppDebuffMove, foes: s.myActive.filter(i => (s.myHp[i] ?? 0) > 0) },
    { taunt: s.oppTaunt.map(x => x > 0), encore: s.oppEncore.map(x => x > 0), encoreAct: s.oppEncoreAct, choice: t.oppChoice, locked: s.oppLocked.map(x => x > 0) },
    { taunt: t.oppTauntMove, encore: t.oppEncoreMove, foes: s.myActive.filter(i => (s.myHp[i] ?? 0) > 0) },
    { has: t.oppHasFakeOut, firstTurn: s.oppFirstTurn, foes: s.myActive.filter(i => (s.myHp[i] ?? 0) > 0) },
    { cell: t.oppPrioCell, foes: s.myActive.filter(i => (s.myHp[i] ?? 0) > 0) },
    t.oppHelpingHand.map((kn, j) => kn && s.oppActive.some(i => i !== j && (s.oppHp[i] ?? 0) > 0)),
    { wide: t.oppWideGuard, quick: t.oppQuickGuard },
    t.oppStrengthSap,
    t.oppHazardClear.map(hc => !!hc && hasAnyHazard(s.oppHazards)),
    t.oppHasSubMove.map((kn, j) => kn && (s.oppHp[j] ?? 0) > 25 && (s.oppSubHp[j] ?? 0) <= 0),
    t.oppCounter.map(c => !!c),
    t.oppRoomMove.map(rm => !!rm && !s[rm]));
}

// Root maximin over a prebuilt table/state — shared by searchToDepth and the
// iterative driver so the (expensive) damage matrices are built only once per
// position, not once per depth.
// Maximin over a prebuilt table for one pass. Returns the best joint (for the
// principal variation) and its score. `plays` are filled by the caller only for
// the displayed pass.
function rootSearch(t: Tables, s0: State, depth: number, pass: Pass): { score: number; joint: Map<number, number> | null } {
  const myJoints = rootMyJoints(t, s0);
  let bestJoint: Map<number, number> | null = null;
  let bestScore = -Infinity;

  // Order ONLY the opponent's replies (most-threatening first) for the inner-loop
  // cutoff. My joints stay in enumeration order so the reported best play is stable
  // among equal-value ties (ordering them would only change tie-breaking, not the
  // score). value()'s internal ordering is fully safe since only the score propagates.
  const oppJoints = orderJoints(rootOppJoints(t, s0), t.thr, t.oppSpread, t.oppPrioCell);
  for (const my of myJoints) {
    let worst = Infinity;
    const replies = oppJoints.length ? oppJoints : [new Map<number, number>()];
    for (const opp of replies) {
      const child = resolveTurn(t, s0, my, opp, pass);
      // floor = bestScore (root has no inherited alpha); ceiling = the running min
      // for this my-joint, so a reply that can't drop below what we already have is
      // cut. A fail-low/high return is still enough to accept or reject the joint.
      const v = value(t, child, depth - 1, bestScore, worst, pass, depth - 1);
      if (v < worst) worst = v;
      if (worst <= bestScore) break;
    }
    if (worst > bestScore) { bestScore = worst; bestJoint = my; }
  }
  return { score: bestScore, joint: bestJoint };
}

function verdictOf(score: number): SearchResult['verdict'] {
  return score >= WIN ? 'winning' : score <= -WIN ? 'losing'
    : score > MATERIAL / 2 ? 'winning' : score < -MATERIAL / 2 ? 'losing' : 'even';
}

function playsFromJoint(t: Tables, joint: Map<number, number> | null): SearchPlay[] {
  const plays: SearchPlay[] = [];
  if (!joint) return plays;
  for (const [actor, target] of joint) {
    if (isFakeOutTarget(target)) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: 'Fake Out', targetSpecies: t.oppSpecies[fakeOutFoeIdx(target)]! });
    } else if (isPrioTarget(target)) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myPrioCell[actor]?.[prioFoeIdx(target)]?.move ?? 'priority', targetSpecies: t.oppSpecies[prioFoeIdx(target)]! });
    } else if (isTauntTarget(target)) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myTauntMove[actor] ?? 'Taunt', targetSpecies: t.oppSpecies[tauntFoeIdx(target)]! });
    } else if (isEncoreTarget(target)) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myEncoreMove[actor] ?? 'Encore', targetSpecies: t.oppSpecies[encoreFoeIdx(target)]! });
    } else if (isDebuffTarget(target)) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myDebuffMove[actor]?.move ?? 'Charm', targetSpecies: t.oppSpecies[debuffFoeIdx(target)]! });
    } else if (isPivotTarget(target)) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myPivotMove[actor] ?? 'U-turn', targetSpecies: t.oppSpecies[pivotFoeIdx(target)]!, switch: true });
    } else if (isStatusTarget(target)) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myStatusMove[actor]?.move ?? 'status', targetSpecies: t.oppSpecies[statusFoeIdx(target)]! });
    } else if (isBatonTarget(target)) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myBatonMove[actor] ?? 'Baton Pass', targetSpecies: t.mySpecies[batonBenchIdx(target)]!, switch: true });
    } else if (isLeechTarget(target)) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myLeechMove[actor] ?? 'Leech Seed', targetSpecies: t.oppSpecies[leechFoeIdx(target)]! });
    } else if (isSwitchTarget(target)) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: 'switch', targetSpecies: t.mySpecies[switchBenchIdx(target)]!, switch: true });
    } else if (target === SET_BOOST) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.mySetupMove[actor] ?? 'setup', targetSpecies: t.mySpecies[actor]!, self: true });
    } else if (target === SET_SCREEN) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myScreen[actor]?.move ?? 'Screen', targetSpecies: t.mySpecies[actor]!, self: true });
    } else if (target === SET_WEATHER) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myWeatherMove[actor]?.move ?? 'Weather', targetSpecies: t.mySpecies[actor]!, self: true });
    } else if (target === SET_TERRAIN) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myTerrainMove[actor]?.move ?? 'Terrain', targetSpecies: t.mySpecies[actor]!, self: true });
    } else if (target === RECOVER) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myRecover[actor]?.move ?? 'Recover', targetSpecies: t.mySpecies[actor]!, self: true });
    } else if (target === SET_HAZARD) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myHazardMove[actor]?.move ?? 'Stealth Rock', targetSpecies: 'their side' });
    } else if (target === REDIRECT) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myRedirectMove[actor] ?? 'Rage Powder', targetSpecies: t.mySpecies[actor]!, self: true });
    } else if (target === HELP_HAND) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: 'Helping Hand', targetSpecies: 'ally', self: true });
    } else if (target === WIDE_GUARD) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: 'Wide Guard', targetSpecies: 'my side', self: true });
    } else if (target === QUICK_GUARD) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: 'Quick Guard', targetSpecies: 'my side', self: true });
    } else if (target === SAP) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: 'Strength Sap', targetSpecies: 'foe', self: true });
    } else if (target === CLEAR_HAZARD) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myHazardClear[actor]?.move ?? 'Rapid Spin', targetSpecies: 'hazards', self: true });
    } else if (target === SET_SUB) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: 'Substitute', targetSpecies: t.mySpecies[actor]!, self: true });
    } else if (target === COUNTER) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: 'Counter', targetSpecies: 'foe', self: true });
    } else if (target === SET_ROOM) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myRoomMove[actor] === 'gravity' ? 'Gravity' : t.myRoomMove[actor] === 'wonderRoom' ? 'Wonder Room' : 'Magic Room', targetSpecies: 'field', self: true });
    } else if (target === SLEEP_SKIP) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: 'asleep', targetSpecies: t.mySpecies[actor]!, self: true });
    } else if (target === SET_TAILWIND) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myTailwindMove[actor] ?? 'Tailwind', targetSpecies: t.mySpecies[actor]!, self: true });
    } else if (target === SET_TRICKROOM) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myTrickRoomMove[actor] ?? 'Trick Room', targetSpecies: t.mySpecies[actor]!, self: true });
    } else if (target === SPREAD) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.mySpread[actor]!.move, targetSpecies: 'all foes', spread: true });
    } else if (target === PROTECT) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myProtectMove[actor] ?? 'Protect', targetSpecies: t.mySpecies[actor]!, self: true });
    } else {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.off[actor]![target]!.move, targetSpecies: t.oppSpecies[target]! });
    }
  }
  return plays;
}

// The OPPONENT's joint formatted as plays ("how they beat us"). Mirror of
// playsFromJoint over the thr/oppSpread tables: `mySpecies` carries the opp
// actor's species and `targetSpecies` my mon (SearchPlay is side-agnostic).
function oppPlaysFromJoint(t: Tables, joint: Map<number, number> | null): SearchPlay[] {
  const plays: SearchPlay[] = [];
  if (!joint) return plays;
  for (const [actor, target] of joint) {
    if (isFakeOutTarget(target)) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: 'Fake Out', targetSpecies: t.mySpecies[fakeOutFoeIdx(target)]! });
    } else if (isPrioTarget(target)) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppPrioCell[actor]?.[prioFoeIdx(target)]?.move ?? 'priority', targetSpecies: t.mySpecies[prioFoeIdx(target)]! });
    } else if (isTauntTarget(target)) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppTauntMove[actor] ?? 'Taunt', targetSpecies: t.mySpecies[tauntFoeIdx(target)]! });
    } else if (isEncoreTarget(target)) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppEncoreMove[actor] ?? 'Encore', targetSpecies: t.mySpecies[encoreFoeIdx(target)]! });
    } else if (isDebuffTarget(target)) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppDebuffMove[actor]?.move ?? 'Charm', targetSpecies: t.mySpecies[debuffFoeIdx(target)]! });
    } else if (isPivotTarget(target)) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppPivotMove[actor] ?? 'U-turn', targetSpecies: t.mySpecies[pivotFoeIdx(target)]!, switch: true });
    } else if (isStatusTarget(target)) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppStatusMove[actor]?.move ?? 'status', targetSpecies: t.mySpecies[statusFoeIdx(target)]! });
    } else if (isBatonTarget(target)) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppBatonMove[actor] ?? 'Baton Pass', targetSpecies: t.oppSpecies[batonBenchIdx(target)]!, switch: true });
    } else if (isLeechTarget(target)) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppLeechMove[actor] ?? 'Leech Seed', targetSpecies: t.mySpecies[leechFoeIdx(target)]! });
    } else if (isSwitchTarget(target)) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: 'switch', targetSpecies: t.oppSpecies[switchBenchIdx(target)]!, switch: true });
    } else if (target === SET_BOOST) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppSetupMove[actor] ?? 'setup', targetSpecies: t.oppSpecies[actor]!, self: true });
    } else if (target === SET_SCREEN) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppScreen[actor]?.move ?? 'Screen', targetSpecies: t.oppSpecies[actor]!, self: true });
    } else if (target === SET_WEATHER) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppWeatherMove[actor]?.move ?? 'Weather', targetSpecies: t.oppSpecies[actor]!, self: true });
    } else if (target === SET_TERRAIN) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppTerrainMove[actor]?.move ?? 'Terrain', targetSpecies: t.oppSpecies[actor]!, self: true });
    } else if (target === RECOVER) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppRecover[actor]?.move ?? 'Recover', targetSpecies: t.oppSpecies[actor]!, self: true });
    } else if (target === SET_HAZARD) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppHazardMove[actor]?.move ?? 'Stealth Rock', targetSpecies: 'my side' });
    } else if (target === REDIRECT) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppRedirectMove[actor] ?? 'Rage Powder', targetSpecies: t.oppSpecies[actor]!, self: true });
    } else if (target === HELP_HAND) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: 'Helping Hand', targetSpecies: 'ally', self: true });
    } else if (target === WIDE_GUARD) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: 'Wide Guard', targetSpecies: 'their side', self: true });
    } else if (target === QUICK_GUARD) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: 'Quick Guard', targetSpecies: 'their side', self: true });
    } else if (target === SAP) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: 'Strength Sap', targetSpecies: 'foe', self: true });
    } else if (target === CLEAR_HAZARD) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppHazardClear[actor]?.move ?? 'Rapid Spin', targetSpecies: 'hazards', self: true });
    } else if (target === SET_SUB) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: 'Substitute', targetSpecies: t.oppSpecies[actor]!, self: true });
    } else if (target === COUNTER) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: 'Counter', targetSpecies: 'foe', self: true });
    } else if (target === SET_ROOM) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppRoomMove[actor] === 'gravity' ? 'Gravity' : t.oppRoomMove[actor] === 'wonderRoom' ? 'Wonder Room' : 'Magic Room', targetSpecies: 'field', self: true });
    } else if (target === SLEEP_SKIP) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: 'asleep', targetSpecies: t.oppSpecies[actor]!, self: true });
    } else if (target === SET_TAILWIND) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppTailwindMove[actor] ?? 'Tailwind', targetSpecies: t.oppSpecies[actor]!, self: true });
    } else if (target === SET_TRICKROOM) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppTrickRoomMove[actor] ?? 'Trick Room', targetSpecies: t.oppSpecies[actor]!, self: true });
    } else if (target === SPREAD) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppSpread[actor]!.move, targetSpecies: 'all my mons', spread: true });
    } else if (target === PROTECT) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppProtectMove[actor] ?? 'Protect', targetSpecies: t.oppSpecies[actor]!, self: true });
    } else {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.thr[actor]![target]!.move, targetSpecies: t.mySpecies[target]! });
    }
  }
  return plays;
}

// The opponent's minimizing joint reply to my fixed `myJoint` (the argmin of the
// inner min). Used to describe "how they beat us". Pure; no alpha prune so the
// argmin is exact.
function oppBestReply(t: Tables, s0: State, myJoint: Map<number, number> | null, depth: number, pass: Pass): Map<number, number> | null {
  if (!myJoint) return null;
  const oppJoints = rootOppJoints(t, s0);
  const replies = oppJoints.length ? oppJoints : [new Map<number, number>()];
  let worst = Infinity;
  let arg: Map<number, number> | null = null;
  for (const opp of replies) {
    const child = resolveTurn(t, s0, myJoint, opp, pass);
    // Full (-Inf,+Inf) window: this is the explainability path ("how they beat us"),
    // so every reply's value must be exact to pick the true argmin — no pruning.
    const v = value(t, child, depth - 1, -Infinity, Infinity, pass, depth - 1);
    if (v < worst) { worst = v; arg = opp; }
  }
  return arg;
}

/** A reusable search over one position: builds the (expensive) damage matrices
 *  ONCE, then answers any-depth queries cheaply. The background driver builds
 *  this once per position change and deepens against it. */
export interface PositionSearch {
  toDepth(depth: number): SearchResult;
}
// "1D chess" — the opponent's FLAT, obvious greedy play per active, independent of
// my move (a heuristic intent read, NOT the maximin `oppLine`). Per opp active, in
// precedence order: a priority KO (free kill) → turn-1 Fake Out (deny my biggest
// threat) → Protect when it's guaranteed-KO'd this turn (stall) → the max-damage
// move (spread if it out-totals the best single-target). Opp-conservative: it only
// uses moves baked into the threat cells (seen / Pikalytics-expected).
function obviousOppPlay(t: Tables, s0: State): SearchPlay[] {
  const out: SearchPlay[] = [];
  const liveMy = s0.myActive.filter(mi => (s0.myHp[mi] ?? 0) > 0);
  if (!liveMy.length) return out;
  for (const oj of s0.oppActive) {
    if ((s0.oppHp[oj] ?? 0) <= 0) continue;
    const oppName = t.oppSpecies[oj] ?? 'foe';
    // a. Priority KO — a priority move that kills one of my actives at current HP.
    let done = false;
    for (const mi of liveMy) {
      const pc = t.oppPrioCell[oj]?.[mi];
      if (pc && pc.dmgMax >= (s0.myHp[mi] ?? 0) && pc.dmgMax > 0) {
        out.push({ mySpecies: oppName, move: pc.move, targetSpecies: t.mySpecies[mi]! });
        done = true; break;
      }
    }
    if (done) continue;
    // b. Fake Out on turn 1 — flinch my biggest threat to this opp.
    if (s0.oppFirstTurn[oj] && t.oppHasFakeOut[oj]) {
      let tgt = liveMy[0]!, best = -1;
      for (const mi of liveMy) { const d = t.off[mi]?.[oj]?.dmgMid ?? 0; if (d > best) { best = d; tgt = mi; } }
      out.push({ mySpecies: oppName, move: 'Fake Out', targetSpecies: t.mySpecies[tgt]! });
      continue;
    }
    // c. Protect when it's guaranteed-KO'd this turn (stall).
    const doomed = liveMy.some(mi => (t.off[mi]?.[oj]?.dmgMin ?? 0) >= (s0.oppHp[oj] ?? 0));
    if (doomed && t.oppProtectMove[oj]) {
      out.push({ mySpecies: oppName, move: t.oppProtectMove[oj]!, targetSpecies: oppName, self: true });
      continue;
    }
    // d. Max damage — best single-target vs the spread (whichever does more total).
    let bestMi = -1, bestDmg = -1;
    for (const mi of liveMy) { const c = t.thr[oj]?.[mi]; if (c && c.dmgMid > bestDmg) { bestDmg = c.dmgMid; bestMi = mi; } }
    const sp = t.oppSpread[oj];
    const spreadTotal = sp ? liveMy.reduce((a, mi) => a + (sp.dmgMid[mi] ?? 0), 0) : 0;
    if (sp && spreadTotal > bestDmg && spreadTotal > 0) {
      out.push({ mySpecies: oppName, move: sp.move, targetSpecies: 'both', spread: true });
    } else if (bestMi >= 0 && bestDmg > 0) {
      out.push({ mySpecies: oppName, move: t.thr[oj]![bestMi]!.move, targetSpecies: t.mySpecies[bestMi]! });
    }
  }
  return out;
}

// Representative spreads kept per opp mon for the lookahead (Step A). Fixed for
// now; Step C makes it confidence-adaptive (smaller as inference narrows).
const SEARCH_PROFILE_K = 3;
// Deeper plies (counting from the first lookahead ply = 0) that still enumerate
// bench / phantom switches (Step B). Switches only matter near the top of the tree
// ("next turn's switch"); the deep tail stays switch-free to bound branching.
// Step C makes this grow as the position narrows (deeper win-con hunt).
const SWITCH_PLY_LIMIT = 2;
function coarseSearchProfile(entry: OpponentEntry, k: number): OpponentEntry {
  const cands = entry.candidates;
  if (!cands || cands.length <= k) return entry;
  const idxs = representativeSpreadIndices(cands, entry.candidateLikelihoods, k);
  return {
    ...entry,
    candidates: idxs.map(i => cands[i]!),
    candidateLikelihoods: entry.candidateLikelihoods ? idxs.map(i => entry.candidateLikelihoods![i] ?? 0) : undefined,
  };
}

/** Breadth knobs for the widening driver (Step C). Omitted ⇒ full breadth (the
 *  defaults). A narrow pass searches deep+cheap; later passes widen toward full. */
export interface SearchBreadth {
  /** Opp candidate spreads kept per mon (Step A). 1 = the single most-likely
   *  spread (narrowest/fastest); default SEARCH_PROFILE_K. */
  spreadK?: number;
  /** Deeper plies that still enumerate switches (Step B). 0 = no switches past the
   *  root (narrowest); default SWITCH_PLY_LIMIT. */
  switchPlyLimit?: number;
}

export function createSearch(input: SearchInput, breadth?: SearchBreadth): PositionSearch {
  // Fold the opponent's KNOWN-but-unrevealed roster (`oppBench`) into the opp
  // list as phantom switch-ins, so the search can model "they switch to one of
  // their other 6". Gated on the bring not yet being complete (until 4 are
  // revealed) and capped so the total opp bodies never exceed the 4 VGC brings.
  // Phantoms carry damage cells (built like any opp) but DON'T count as material
  // until switched in (see `oppSeen`). benchRisk still uses input.oppBench.
  if (!input.allOppRevealed && input.oppBench?.length) {
    const room = Math.max(0, 4 - input.opp.length);
    const phantoms: SearchOppMon[] = input.oppBench.slice(0, room).map(entry => ({
      entry, hpPercent: 100, active: false, phantom: true, survival: oppSurvival(entry),
    }));
    if (phantoms.length) input = { ...input, opp: [...input.opp, ...phantoms] };
  }
  // Coarse search profile (Step A of the deep-switch plan): cap each opp mon to K
  // REPRESENTATIVE spreads so the per-mon search cost is bounded regardless of how
  // wide inference's candidate grid is (it can be up to ~360k for an off-meta mon).
  // The full set still lives on the match for the readout; the search consumes this
  // digest. This is the foundation that makes switches-at-depth affordable — and it
  // shrinks the @smogon/calc work per cell from |candidates| to K. K will become
  // confidence-adaptive in Step C (narrower as inference sharpens).
  const spreadK = breadth?.spreadK ?? SEARCH_PROFILE_K;
  input = { ...input, opp: input.opp.map(o => ({ ...o, entry: coarseSearchProfile(o.entry, spreadK) })) };
  const s0 = initialState(input);

  // Mega is a root decision per side. I pick whether (and which active) to mega
  // to MAXIMISE my worst case; the opponent picks whether to mega to MINIMISE
  // it (worst-case for me). Only currently-active, mega-capable mons are
  // candidates (mega is decided now, not for a future switch-in — a documented
  // v1 limit). Tables are built once per (myMega, oppMega) combo and reused
  // across depths.
  // Only offer a hypothetical mega when the side hasn't already used theirs
  // (mega is once per battle). An already-mega'd active's stats are baked into
  // the tables via megaActive, so no extra branch is needed for it.
  const myPlans: Array<number | null> = [null];
  if (!input.myMegaSpent) {
    s0.myActive.forEach(i => { if (myMegaForme(input.mine[i]!.set)) myPlans.push(i); });
  }
  const oppPlans: Array<number | null> = [null];
  if (!input.oppMegaSpent) {
    s0.oppActive.forEach(j => { if (oppCanMega(input.opp[j]!.entry)) oppPlans.push(j); });
  }

  const switchPlyLimit = breadth?.switchPlyLimit ?? SWITCH_PLY_LIMIT;
  // A pass is "full breadth" only when neither knob is restricted below the
  // defaults — i.e. it's a genuine worst-case search that may claim `forced`.
  const fullBreadth = spreadK >= SEARCH_PROFILE_K && switchPlyLimit >= SWITCH_PLY_LIMIT;
  const tables = new Map<string, Tables>();
  for (const myMega of myPlans) {
    for (const oppMega of oppPlans) {
      const tbl = buildTables(input, { myMega, oppMega });
      tbl.switchPlyLimit = switchPlyLimit;
      tables.set(`${myMega},${oppMega}`, tbl);
    }
  }

  const allOppRevealed = input.allOppRevealed ?? false;

  // Scariest KNOWN bench switch-in vs my current actives. We don't search
  // switches, but naming the biggest incoming threat makes the bench caveat
  // concrete (e.g. "Blastoise switch-in can KO Victreebel"). Computed once.
  let benchRisk: SearchRisk | null = null;
  if (input.oppBench?.length && s0.myActive.length) {
    let worst: { species: string; move: string; pct: number; myMon: string; myHp: number } | null = null;
    for (const b of input.oppBench) {
      for (const mi of s0.myActive) {
        const m = input.mine[mi]!;
        const thr = predictThreat({ opponent: b, defender: m.set, field: input.field });
        if (thr && (!worst || thr.maxPercent > worst.pct)) {
          worst = { species: b.species, move: thr.move, pct: thr.maxPercent, myMon: m.set.species, myHp: m.hpPercent };
        }
      }
    }
    if (worst && worst.pct >= 55) {
      benchRisk = {
        label: worst.pct >= worst.myHp
          ? `${worst.species} switch-in can KO ${worst.myMon}`
          : `${worst.species} switch-in hits ${worst.myMon} ~${Math.round(worst.pct)}%`,
        effect: 'can switch in',
        blocking: true,
      };
    }
  }

  // A pass's survival flags. My items are known (apply whenever present);
  // the opponent's are uncertain — assume present worst-case (pessimistic),
  // most-likely (expected, prob ≥ 0.5), or absent best-case (optimistic).
  // `forceOppSurv` overrides one opp index for sensitivity toggles.
  const buildPass = (regime: Regime, override?: { idx: number; survOpp: boolean }): Pass => ({
    regime,
    // My items are known → always applied. Opp survival: pessimistic assumes
    // it's present (worst case); expected/optimistic only apply CERTAIN ones
    // (prob ≥ 1) — uncertain Sash is surfaced as a risk, not baked into the
    // headline verdict.
    survMy: input.mine.map(m => (m.survival?.prob ?? 0) > 0),
    survOpp: input.opp.map((o, j) => {
      if (override && override.idx === j) return override.survOpp;
      const p = o.survival?.prob ?? 0;
      return regime === 'pessimistic' ? p > 0 : p >= 1;
    }),
  });

  // My-max / opp-min mega maximin for one pass; returns the principal line.
  interface Sel { score: number; joint: Map<number, number> | null; table: Tables; myMega: number | null }
  const evalPass = (pass: Pass, depth: number): Sel => {
    let bestVal = -Infinity;
    let best: Sel | null = null;
    for (const myMega of myPlans) {
      let worstVal = Infinity;
      let worst: Sel | null = null;
      for (const oppMega of oppPlans) {
        const table = tables.get(`${myMega},${oppMega}`)!;
        const { score, joint } = rootSearch(table, s0, depth, pass);
        if (score < worstVal) { worstVal = score; worst = { score, joint, table, myMega }; }
      }
      if (worstVal > bestVal) { bestVal = worstVal; best = worst; }
    }
    return best ?? { score: -Infinity, joint: null, table: tables.get('null,null')!, myMega: null };
  };

  const rank = (v: SearchResult['verdict']): number => (v === 'winning' ? 2 : v === 'even' ? 1 : 0);

  return {
    toDepth(depth: number): SearchResult {
      const expected = evalPass(buildPass('expected'), depth);
      const eV = verdictOf(expected.score);
      const pess = evalPass(buildPass('pessimistic'), depth); // my low rolls, opp high + survives
      const opt = evalPass(buildPass('optimistic'), depth);   // my high rolls, opp low, no survival

      const forcedWin = pess.score >= WIN && allOppRevealed;
      const forcedLoss = opt.score <= -WIN;
      const forced = forcedWin || forcedLoss;

      const risks: SearchRisk[] = [];
      // We only show a numeric win-chance when EVERY blocking risk is priced.
      // An unpriced blocking risk (the unmodelled bench, or roll dependence we
      // can't pin to one KO) means a confident % would lie — fall back to a
      // qualitative verdict instead.
      let unpriced = false;
      let winChance: number | undefined;

      // The opponent's known bench is now modelled as ROOT switch-ins (phantoms),
      // but switches at DEEPER plies aren't searched — so the bench is still a
      // real residual uncertainty. Name the scariest incoming threat regardless
      // of verdict; the unpriced flag (only when not already losing) reflects the
      // beyond-root switch we can't price into a clean win%.
      if (!allOppRevealed) {
        if (benchRisk) {
          risks.push(benchRisk);
          if (eV !== 'losing') unpriced = true;
        } else if (eV !== 'losing') {
          const realOpp = input.opp.filter(o => !o.phantom).length;
          const unseen = Math.max(1, 4 - realOpp);
          risks.push({ label: `${unseen} more foe${unseen === 1 ? '' : 's'} can switch in`, effect: 'beyond-root switch', blocking: true });
          unpriced = true;
        }
      }

      if (eV !== 'losing') {
        winChance = 1;
        const myMegaChosen = expected.myMega;
        // Scariest CONTINGENT way the opponent can KO my active `mi` this turn:
        // a hit it survives at the median roll but dies to at the top roll
        // (so the expected line assumed survival). Scans every opp mega plan and
        // both single-target + spread threats. Returns the highest KO chance,
        // with whether the threat outspeeds me and the (possibly mega) opp name.
        const scariestIncoming = (mi: number): { oppName: string; koProb: number; outspeeds: boolean } | null => {
          const myHp = s0.myHp[mi] ?? 0;
          if (myHp <= 0) return null;
          let worst: { oppName: string; koProb: number; outspeeds: boolean } | null = null;
          const consider = (dmgMin: number, dmgMid: number, dmgMax: number, koRolls: number[], oj: number, oppMega: number | null, tbl: Tables, priorityMove = false) => {
            if (dmgMax < myHp || dmgMid >= myHp) return; // can't KO, or already lethal at median (not contingent)
            const koProb = koRolls.length
              ? koRolls.filter(r => r >= myHp).length / koRolls.length
              : dmgMax <= dmgMin ? 0 : Math.max(0, Math.min(1, (dmgMax - myHp) / (dmgMax - dmgMin)));
            if (koProb <= 0 || koProb >= 1) return;
            const base = tbl.oppSpecies[oj] ?? 'foe';
            const oppName = oppMega === oj ? (oppMegaInfo(base)?.forme ?? base) : base;
            // A priority move strikes first regardless of Speed (Sucker Punch etc.).
            const outspeeds = priorityMove || oppOutspeeds(tbl, s0, oj, mi);
            if (!worst || koProb > worst.koProb) worst = { oppName, koProb, outspeeds };
          };
          for (const oppMega of oppPlans) {
            const tbl = tables.get(`${myMegaChosen},${oppMega}`);
            if (!tbl) continue;
            for (const oj of s0.oppActive) {
              if ((s0.oppHp[oj] ?? 0) <= 0) continue;
              const c = tbl.thr[oj]?.[mi];
              if (c) consider(c.dmgMin, c.dmgMid, c.dmgMax, c.koRolls, oj, oppMega, tbl);
              const sp = tbl.oppSpread[oj];
              if (sp) consider(sp.dmgMin[mi] ?? 0, sp.dmgMid[mi] ?? 0, sp.dmgMax[mi] ?? 0, [], oj, oppMega, tbl);
              // Priority KO (Sucker Punch / Aqua Jet / …): hidden from the max-damage
              // thr cell, but a contingent priority KO is a real reason a line fails.
              const pc = tbl.oppPrioCell[oj]?.[mi];
              if (pc) consider(pc.dmgMin, pc.dmgMid, pc.dmgMax, pc.koRolls, oj, oppMega, tbl, true);
            }
          }
          return worst;
        };
        // Opponent survival items — listed ONLY when they actually threaten this
        // line (forcing the item present flips the verdict). Avoids noise like a
        // Sash on a foe we only 2HKO anyway.
        for (const j of s0.oppActive) {
          const sv = input.opp[j]?.survival;
          const p = sv?.prob ?? 0;
          if (p <= 0 || p >= 1) continue; // certain items are baked into expected
          const tog = evalPass(buildPass('expected', { idx: j, survOpp: true }), depth);
          if (rank(verdictOf(tog.score)) >= rank(eV)) continue; // non-blocking → skip
          risks.push({ label: `${input.opp[j]!.entry.species} ${sv!.label}`, prob: p, effect: 'may survive', blocking: true });
          winChance *= 1 - p;
        }
        // Roll dependence: keep the expected survival assumptions, drop to worst rolls.
        const ePass = buildPass('expected');
        const rollSel = evalPass({ regime: 'pessimistic', survMy: ePass.survMy, survOpp: ePass.survOpp }, depth);
        if (rank(verdictOf(rollSel.score)) < rank(eV)) {
          // Bottleneck = the least-certain KO the line relies on this turn:
          // P(KO at the target's HP), across single-target AND spread KOs. Uses
          // the empirical roll distribution so it reflects the opponent's
          // possible bulkier spreads, not just roll variance.
          let bottleneck = 1;
          let bottleneckLabel = '';
          let bottleneckEffect = 'rolls + spread';
          const consider = (c: Cell, h: number, who: string) => {
            if (h <= 0 || c.dmgMid < h) return;
            const p = rollKoProb(c, h);
            if (p < bottleneck) { bottleneck = p; bottleneckLabel = `KO on ${who} not guaranteed`; bottleneckEffect = 'rolls + spread'; }
          };
          for (const [actor, target] of (expected.joint ?? [])) {
            if (target === SPREAD) {
              const sp = expected.table.mySpread[actor]!;
              for (const foe of s0.oppActive) {
                consider({ dmgMin: sp.dmgMin[foe] ?? 0, dmgMid: sp.dmgMid[foe] ?? 0, dmgMax: sp.dmgMax[foe] ?? 0, move: '', priority: 0, multiHit: false, koRolls: [], candidates: 0, physical: false, type: '', groundMove: false, drain: 0, contact: false, recoil: 0, setsHazard: null, selfDrop: null, foeDrop: null }, s0.oppHp[foe] ?? 0, expected.table.oppSpecies[foe] ?? 'foe');
              }
            } else if (isPrioTarget(target)) {
              const fo = prioFoeIdx(target);
              const c = expected.table.myPrioCell[actor]?.[fo];
              if (c) consider(c, s0.oppHp[fo] ?? 0, expected.table.oppSpecies[fo] ?? 'foe');
            } else if (target >= 0) {       // skip PROTECT / SWITCH (no attack)
              consider(expected.table.off[actor]![target]!, s0.oppHp[target] ?? 0, expected.table.oppSpecies[target] ?? 'foe');
            }
          }
          // Incoming side: a contingent KO on one of MY actives is just as much a
          // reason the line isn't guaranteed. Treat my-mon SURVIVAL (1 − koProb)
          // as a candidate bottleneck so "Aerodactyl-Mega can KO Delphox" surfaces
          // by name instead of the old catch-all "damage rolls".
          for (const mi of s0.myActive) {
            const inc = scariestIncoming(mi);
            if (!inc) continue;
            const pSurvive = 1 - inc.koProb;
            if (pSurvive < bottleneck) {
              bottleneck = pSurvive;
              const myName = expected.table.mySpecies[mi] ?? 'my mon';
              bottleneckLabel = `${inc.oppName} can KO ${myName}`;
              bottleneckEffect = inc.outspeeds ? 'outspeeds + high roll' : 'high roll';
            }
          }
          const label = bottleneckLabel || 'damage rolls';
          if (bottleneck < 1) { risks.push({ label, prob: 1 - bottleneck, effect: bottleneckEffect, blocking: true }); winChance *= bottleneck; }
          else { risks.push({ label, effect: bottleneckEffect, blocking: true }); unpriced = true; }
        }

        // Flinch: an outspeeding opp move with a flinch secondary (Rock Slide /
        // Iron Head / Fake Out …) can deny one of my acting mons its turn — a
        // real swing the roll analysis doesn't capture (it's not a damage roll).
        // Surface per acting mon, priced like a survival item. Only my mons that
        // actually ACT this turn care (a protecting mon loses nothing to flinch).
        for (const [actor, target] of (expected.joint ?? [])) {
          if (target === PROTECT || isSwitchTarget(target) || isBatonTarget(target)) continue; // not acting → can't be flinched
          let chance = 0;
          for (const oppMega of oppPlans) {
            const tbl = tables.get(`${myMegaChosen},${oppMega}`);
            if (!tbl) continue;
            for (const oj of s0.oppActive) {
              if ((s0.oppHp[oj] ?? 0) <= 0 || !oppOutspeeds(tbl, s0, oj, actor)) continue;
              const c = tbl.thr[oj]?.[actor];
              const sp = tbl.oppSpread[oj];
              chance = Math.max(chance, moveFlinchChance(c?.move ?? ''), moveFlinchChance(sp?.move ?? ''));
            }
          }
          if (chance > 0) {
            const myName = expected.table.mySpecies[actor] ?? 'my mon';
            // Informational, NOT priced into winChance: flinch isn't in the
            // maximin, so whether a flinch actually costs the game is unproven —
            // only that it can happen. Surfacing the label satisfies the "warn
            // me" need without multiplying the headline win% by an effect we
            // can't establish (and which would compound across both my actives).
            risks.push({ label: `${myName} can be flinched`, prob: chance, effect: 'loses its turn', blocking: false });
          }
        }

        winChance = unpriced ? undefined : Math.max(0, Math.min(1, winChance));
      }

      // Hail Mary: when losing but not a FORCED loss, name the dice that could
      // still save the game. We assemble candidate LINES — each a plan plus the
      // lucky event(s) it relies on — and surface the single most-likely one as
      // "your best shot". This is the mirror of the winning-side sensitivity
      // analysis above. Two out types:
      //  A) my favourable ROLLS land the KO(s) the optimistic line needs;
      //  C) the opp FAILS the kill it's relying on — it misses, or hits but
      //     rolls too low to KO. P(fail) = (1−acc) + acc·P(roll doesn't KO),
      //     which unifies the accuracy and roll components into one honest out.
      let hailMary: HailMary | undefined;
      if (eV === 'losing' && !forcedLoss) {
        const myMegaChosen = expected.myMega;
        type HMLine = { plays: SearchPlay[]; outs: HailMaryOut[]; prob: number };
        const lines: HMLine[] = [];

        // ---- Line A: my favourable rolls close it (optimistic regime wins) ----
        if (opt.score >= WIN) {
          const outsA: HailMaryOut[] = [];
          let comboA = 1;
          for (const [actor, target] of (opt.joint ?? [])) {
            if (target === SPREAD) {
              const sp = opt.table.mySpread[actor];
              if (!sp) continue;
              for (const foe of s0.oppActive) {
                const h = s0.oppHp[foe] ?? 0;
                if (h <= 0) continue;
                const dMid = sp.dmgMid[foe] ?? 0;
                const dMax = sp.dmgMax[foe] ?? 0;
                if (dMax < h || dMid >= h) continue; // can't KO or already guaranteed
                const p = dMax > dMid ? (dMax - h) / (dMax - dMid) : 0;
                if (p <= 0) continue;
                outsA.push({ label: `${opt.table.oppSpecies[foe] ?? 'foe'} KO needs top roll`, prob: p });
                comboA *= p;
              }
            } else if (target >= 0 || isPrioTarget(target)) {        // direct or priority attack (skip PROTECT / SWITCH)
              const foe = isPrioTarget(target) ? prioFoeIdx(target) : target;
              const c = isPrioTarget(target) ? opt.table.myPrioCell[actor]?.[foe] : opt.table.off[actor]?.[foe];
              if (!c) continue;
              const h = s0.oppHp[foe] ?? 0;
              if (h <= 0 || c.dmgMax < h || c.dmgMid >= h) continue;
              const p = rollKoProb(c, h);
              if (p <= 0 || p >= 1) continue;
              outsA.push({ label: `${opt.table.oppSpecies[foe] ?? 'foe'} KO needs top roll`, prob: p });
              comboA *= p;
            }
          }
          if (outsA.length) lines.push({ plays: playsFromJoint(opt.table, opt.joint), outs: outsA, prob: comboA });
        }

        // ---- Line C: the opp FAILS the kill it's relying on (miss / low roll) ----
        // For each of my live actives the opp can KO this turn, find the opp's
        // single most RELIABLE kill attempt across mega plans / moves — pKO =
        // (acc/100)·P(roll KOs). If that's a coin-flip (< 1), surviving it is a
        // real out; label it by the dominant failure mode (a sub-100% move can
        // miss OR roll low; a 100%-accurate one only rolls low).
        {
          let best: HailMaryOut | null = null;
          for (const mi of s0.myActive) {
            const myHp = s0.myHp[mi] ?? 0;
            if (myHp <= 0) continue;
            let bestPKo = 0; let bestMove = ''; let bestAcc = 100;
            const consider = (mv: string | undefined, rollKo: number) => {
              if (!mv || rollKo <= 0) return;
              const acc = moveAccuracyPct(mv);
              const pKo = (acc / 100) * rollKo;
              if (pKo > bestPKo) { bestPKo = pKo; bestMove = mv; bestAcc = acc; }
            };
            for (const oppMega of oppPlans) {
              const tbl = tables.get(`${myMegaChosen},${oppMega}`);
              if (!tbl) continue;
              for (const oj of s0.oppActive) {
                if ((s0.oppHp[oj] ?? 0) <= 0) continue;
                const c = tbl.thr[oj]?.[mi]; if (c && c.dmgMax >= myHp) consider(c.move, rollKoProb(c, myHp));
                const sp = tbl.oppSpread[oj]; if (sp) consider(sp.move, spreadKoProb(sp.dmgMin[mi] ?? 0, sp.dmgMid[mi] ?? 0, sp.dmgMax[mi] ?? 0, myHp));
                const pc = tbl.oppPrioCell[oj]?.[mi]; if (pc && pc.dmgMax >= myHp) consider(pc.move, rollKoProb(pc, myHp));
              }
            }
            if (bestPKo <= 0 || bestPKo >= 1) continue; // no kill, or a guaranteed one (not an out)
            const survive = 1 - bestPKo;
            const myName = expected.table.mySpecies[mi] ?? 'my mon';
            const mode = bestAcc < 100 ? `${bestMove} misses or rolls low` : `${bestMove} rolls low`;
            const out: HailMaryOut = { label: `opp's ${mode} on ${myName}`, prob: survive };
            if (!best || survive > best.prob) best = out;
          }
          if (best) lines.push({ plays: playsFromJoint(expected.table, expected.joint), outs: [best], prob: best.prob });
        }

        // Surface the most-likely line as the headline Hail Mary.
        if (lines.length) {
          const win = lines.reduce((a, b) => (b.prob > a.prob ? b : a));
          const combined = Math.max(0, Math.min(1, win.prob));
          hailMary = { plays: win.plays, outs: win.outs, combined, noRealisticOut: combined < 0.005 };
        } else if (opt.score >= WIN) {
          // A win exists under best-case rolls, but no single dice event pins it
          // (it rides later plies / the opp rolling low). Generic last-resort.
          hailMary = { plays: playsFromJoint(opt.table, opt.joint), outs: [{ label: 'opp rolls low', prob: 0.5 }], combined: 0.5, noRealisticOut: false };
        } else {
          // No winning path even under best-case conditions.
          hailMary = { plays: [], outs: [], combined: 0, noRealisticOut: true };
        }
      }

      // ---- Phase 1/2: explainability, assumptions, break-points, breadth ----

      // "How they beat us": the opponent's minimizing reply to my recommended
      // joint. Cheap (one root inner-min) and informative; rendered when losing.
      const oppReply = oppBestReply(expected.table, s0, expected.joint, depth, buildPass('expected'));
      const oppLine = oppPlaysFromJoint(expected.table, oppReply);

      // Pivotal SPEED assumptions: an opp attacker that outspeeds (non-TR) — or
      // moves first under Trick Room — ONLY if it invested the relevant Speed.
      // Gated on it actually threatening a KO, so we don't list speed facts that
      // don't matter. Honest: no fabricated probability (speed isn't uniform
      // over the range; per feedback_nature_confidence we don't guess).
      const assumptions: SearchAssumption[] = [];
      {
        const tr = !!input.field.trickRoom;
        for (const oj of s0.oppActive) {
          if (assumptions.length >= 3) break;
          const oe = input.opp[oj];
          if (!oe || (s0.oppHp[oj] ?? 0) <= 0) continue;
          const range = effectiveSpeedRange(oe.entry);
          if (!range) continue;
          const oppBoost = speStageMult(oe.boosts?.spe);
          const oppPar = oe.status === 'par';
          const oppEff = (raw: number) => effSpeed(raw * oppBoost, !!input.field.theirTailwind, oppPar);
          const effMin = oppEff(range.min);
          const effMax = oppEff(range.max);
          for (const mi of s0.myActive) {
            if (assumptions.length >= 3) break;
            const myHp = s0.myHp[mi] ?? 0;
            if (myHp <= 0) continue;
            const c = expected.table.thr[oj]?.[mi];
            if (!c || c.dmgMax < myHp) continue;          // can't KO → speed not pivotal
            const myEff = effSpeed(expected.table.mySpeed[mi]!, !!input.field.myTailwind, expected.table.myPar[mi]!);
            const movesFirst = (s: number) => (tr ? s < myEff : s > myEff);
            const myName = expected.table.mySpecies[mi]!;
            if (movesFirst(effMin) !== movesFirst(effMax)) {
              assumptions.push({ text: tr
                ? `${oe.entry.species} moves before ${myName} under Trick Room only if it ran low Speed`
                : `${oe.entry.species} outspeeds ${myName} only if it invested Speed` });
            }
          }
        }
      }

      // ---- Break-points: damage cutpoints that flip the verdict this turn ----
      const breakpoints: SearchBreakpoint[] = [];
      {
        // KO direction: a KO my recommended line relies on that isn't guaranteed
        // — name the foe + how likely, so the user knows a bulkier spread saves it.
        for (const [actor, target] of (expected.joint ?? [])) {
          if (breakpoints.length >= 3) break;
          if (target < 0) continue;                      // skip SPREAD / PROTECT / SWITCH
          const c = expected.table.off[actor]?.[target];
          if (!c) continue;
          const h = s0.oppHp[target] ?? 0;
          if (h <= 0 || c.dmgMax < h) continue;          // can't KO at all
          const p = rollKoProb(c, h);
          if (p <= 0 || p >= 1) continue;                // guaranteed or impossible → not a break-point
          const foe = expected.table.oppSpecies[target]!;
          breakpoints.push({
            subject: foe, move: c.move, direction: 'ko', thresholdHp: h,
            thenNote: `we OHKO ${foe}`,
            spreadNote: c.candidates > 1 ? `bulkier of ${c.candidates} spreads survive` : undefined,
            prob: p,
          });
        }
        // Survive direction (the user's Rock Slide example): a contingent KO on
        // one of MY actives — if their hit stays under our current HP we live,
        // and (one ply out) we KO the threat back.
        for (const mi of s0.myActive) {
          if (breakpoints.length >= 3) break;
          const myHp = s0.myHp[mi] ?? 0;
          if (myHp <= 0) continue;
          let worst: { oppName: string; move: string; koProb: number; oppIdx: number } | null = null;
          for (const oppMega of oppPlans) {
            const tbl = tables.get(`${expected.myMega},${oppMega}`);
            if (!tbl) continue;
            for (const oj of s0.oppActive) {
              if ((s0.oppHp[oj] ?? 0) <= 0) continue;
              const c = tbl.thr[oj]?.[mi];
              if (!c || c.dmgMax < myHp || c.dmgMid >= myHp) continue;  // not a contingent KO
              const koProb = rollKoProb(c, myHp);
              if (koProb <= 0 || koProb >= 1) continue;
              if (!worst || koProb > worst.koProb) {
                const base = tbl.oppSpecies[oj] ?? 'foe';
                worst = { oppName: oppMega === oj ? (oppMegaInfo(base)?.forme ?? base) : base, move: c.move, koProb, oppIdx: oj };
              }
            }
          }
          if (!worst) continue;
          let koBack = false;
          for (const ma of s0.myActive) {
            const oc = expected.table.off[ma]?.[worst.oppIdx];
            if (oc && oc.dmgMid >= (s0.oppHp[worst.oppIdx] ?? 0)) { koBack = true; break; }
          }
          breakpoints.push({
            subject: expected.table.mySpecies[mi]!, move: worst.move, direction: 'survive', thresholdHp: myHp,
            thenNote: koBack ? `we survive & KO ${worst.oppName} back` : 'we survive',
            prob: 1 - worst.koProb,
          });
        }
      }

      // ---- Honest breadth report (scope-derived) ----
      // Root joints INCLUDE the switch options actually offered this ply.
      const myRootJoints = rootMyJoints(expected.table, s0);
      const oppRootJoints = rootOppJoints(expected.table, s0);
      let maxSpreads = 0;
      for (const row of expected.table.thr) for (const cell of row) if (cell.candidates > maxSpreads) maxSpreads = cell.candidates;
      // Action kinds REALLY in the tree — drives breadth wording so it never
      // overclaims (e.g. only says "switch" when a switch is genuinely offered).
      const actionClasses = ['attack'];
      if (expected.table.mySpreadActors.size || expected.table.oppSpreadActors.size) actionClasses.push('spread');
      if (expected.table.myProtectMove.some(p => p) || expected.table.oppProtectMove.some(p => p)) actionClasses.push('protect');
      const switchesOffered = benchSwitchTargets(s0.myActive, s0.myHp, expected.table.myN).length > 0
        || benchSwitchTargets(s0.oppActive, s0.oppHp, expected.table.oppN).length > 0;
      if (switchesOffered) actionClasses.push('switch');
      // Field-move classes only when a mon that's actually on the field can set it.
      const canSet = (moves: (string | null)[], active: number[]) => active.some(i => moves[i] != null);
      if ((!s0.myTailwind && canSet(expected.table.myTailwindMove, s0.myActive)) || (!s0.theirTailwind && canSet(expected.table.oppTailwindMove, s0.oppActive))) actionClasses.push('tailwind');
      if (canSet(expected.table.myTrickRoomMove, s0.myActive) || canSet(expected.table.oppTrickRoomMove, s0.oppActive)) actionClasses.push('trickroom');
      // Leech Seed offered when a mon on the field knows it and a non-Grass,
      // not-yet-seeded foe is in range.
      const canLeech = (moves: (string | null)[], active: number[], foeActive: number[], foeGrass: boolean[], foeSeeded: (number | null)[]) =>
        active.some(i => moves[i] != null) && foeActive.some(j => !foeGrass[j] && foeSeeded[j] == null);
      if (canLeech(expected.table.myLeechMove, s0.myActive, s0.oppActive, expected.table.oppGrass, s0.oppSeeded)
        || canLeech(expected.table.oppLeechMove, s0.oppActive, s0.myActive, expected.table.myGrass, s0.mySeeded)) actionClasses.push('leech');
      if (canSet(expected.table.mySetupMove, s0.myActive) || canSet(expected.table.oppSetupMove, s0.oppActive)) actionClasses.push('setup');
      const myBenchNow = benchSwitchTargets(s0.myActive, s0.myHp, expected.table.myN).length > 0;
      const oppBenchNow = benchSwitchTargets(s0.oppActive, s0.oppHp, expected.table.oppN).length > 0;
      if ((myBenchNow && canSet(expected.table.myBatonMove, s0.myActive)) || (oppBenchNow && canSet(expected.table.oppBatonMove, s0.oppActive))) actionClasses.push('batonpass');
      if (s0.myActive.some(i => expected.table.mySpeedBoost[i]) || s0.oppActive.some(j => expected.table.oppSpeedBoost[j])) actionClasses.push('speedboost');
      const screenable = (screens: (ScreenSet | null)[], active: number[], refUp: boolean, lsUp: boolean) =>
        active.some(i => { const sc = screens[i]; return !!sc && ((sc.reflect && !refUp) || (sc.lightScreen && !lsUp)); });
      if (screenable(expected.table.myScreen, s0.myActive, s0.myReflect, s0.myLightScreen)
        || screenable(expected.table.oppScreen, s0.oppActive, s0.theirReflect, s0.theirLightScreen)) actionClasses.push('screen');
      const weatherable = (moves: ({ weather: Weather } | null)[], active: number[]) =>
        active.some(i => { const wm = moves[i]; return !!wm && normWeather(wm.weather) !== normWeather(s0.weather); });
      if (weatherable(expected.table.myWeatherMove, s0.myActive) || weatherable(expected.table.oppWeatherMove, s0.oppActive)) actionClasses.push('weather');
      const terrainable = (moves: ({ terrain: Terrain } | null)[], active: number[]) =>
        active.some(i => { const tm = moves[i]; return !!tm && tm.terrain !== s0.terrain; });
      if (terrainable(expected.table.myTerrainMove, s0.myActive) || terrainable(expected.table.oppTerrainMove, s0.oppActive)) actionClasses.push('terrain');
      const statusable = (moves: (StatusMove | null)[], active: number[], foeActive: number[], foeStatus: string[]) =>
        active.some(i => moves[i] != null) && foeActive.some(j => !foeStatus[j]);
      if (statusable(expected.table.myStatusMove, s0.myActive, s0.oppActive, s0.oppStatus)
        || statusable(expected.table.oppStatusMove, s0.oppActive, s0.myActive, s0.myStatus)) actionClasses.push('status');
      const recoverable = (recs: (RecoverMove | null)[], hp: number[], active: number[]) =>
        active.some(i => !!recs[i] && (hp[i] ?? 100) < 100);
      if (recoverable(expected.table.myRecover, s0.myHp, s0.myActive) || recoverable(expected.table.oppRecover, s0.oppHp, s0.oppActive)) actionClasses.push('recover');
      // Hazard class when a mon on the field knows a hazard-setting move AND that
      // layer isn't already maxed on the side it'd land on.
      const hazardable = (moves: ({ hazard: HazardKind } | null)[], active: number[], foeHazards: HazardState) =>
        active.some(i => { const hm = moves[i]; return !!hm && hazardRoom(foeHazards, hm.hazard); });
      if (hazardable(expected.table.myHazardMove, s0.myActive, s0.oppHazards) || hazardable(expected.table.oppHazardMove, s0.oppActive, s0.myHazards)) actionClasses.push('hazard');
      const canRedirect = (moves: (string | null)[], active: number[]) => active.some(i => moves[i] != null);
      if (canRedirect(expected.table.myRedirectMove, s0.myActive) || canRedirect(expected.table.oppRedirectMove, s0.oppActive)) actionClasses.push('redirect');
      // Pivot offered when a mon on the field knows one AND its side has a live bench.
      const myBenchNow2 = benchSwitchTargets(s0.myActive, s0.myHp, expected.table.myN).length > 0;
      const oppBenchNow2 = benchSwitchTargets(s0.oppActive, s0.oppHp, expected.table.oppN).length > 0;
      if ((myBenchNow2 && canRedirect(expected.table.myPivotMove, s0.myActive)) || (oppBenchNow2 && canRedirect(expected.table.oppPivotMove, s0.oppActive))) actionClasses.push('pivot');
      const canDebuff = (moves: ({ move: string } | null)[], active: number[]) => active.some(i => moves[i] != null);
      if (canDebuff(expected.table.myDebuffMove, s0.myActive) || canDebuff(expected.table.oppDebuffMove, s0.oppActive)) actionClasses.push('debuff');
      if (canRedirect(expected.table.myTauntMove, s0.myActive) || canRedirect(expected.table.oppTauntMove, s0.oppActive)) actionClasses.push('taunt');
      if (canRedirect(expected.table.myEncoreMove, s0.myActive) || canRedirect(expected.table.oppEncoreMove, s0.oppActive)) actionClasses.push('encore');
      // Priority attack is offered only when it can KO a live foe at current HP
      // (same gate as jointActions) — match that so the class reflects the tree.
      const prioKO = (cells: (Cell | null)[][], attackers: number[], foes: number[], foeHp: number[]): boolean =>
        attackers.some(a => foes.some(j => { const pc = cells[a]?.[j]; return !!pc && pc.dmgMax > 0 && (foeHp[j] ?? 0) > 0 && pc.dmgMax >= (foeHp[j] ?? 0); }));
      if (prioKO(expected.table.myPrioCell, s0.myActive, s0.oppActive, s0.oppHp)
        || prioKO(expected.table.oppPrioCell, s0.oppActive, s0.myActive, s0.myHp)) actionClasses.push('priority');
      // Helping Hand: offered when a knower has a live ally on the field.
      const helpOffered = (knows: boolean[], actives: number[], hp: number[]): boolean =>
        actives.some(i => knows[i] && actives.some(j => j !== i && (hp[j] ?? 0) > 0));
      if (helpOffered(expected.table.myHelpingHand, s0.myActive, s0.myHp)
        || helpOffered(expected.table.oppHelpingHand, s0.oppActive, s0.oppHp)) actionClasses.push('helpinghand');
      const guardOffered = (knows: boolean[], actives: number[]): boolean => actives.some(i => knows[i]);
      if (guardOffered(expected.table.myWideGuard, s0.myActive) || guardOffered(expected.table.oppWideGuard, s0.oppActive)) actionClasses.push('wideguard');
      if (guardOffered(expected.table.myQuickGuard, s0.myActive) || guardOffered(expected.table.oppQuickGuard, s0.oppActive)) actionClasses.push('quickguard');
      if (guardOffered(expected.table.myStrengthSap, s0.myActive) || guardOffered(expected.table.oppStrengthSap, s0.oppActive)) actionClasses.push('strengthsap');
      const clearOffered = (clears: (ReturnType<typeof findHazardClear>)[], actives: number[], haz: HazardState): boolean =>
        hasAnyHazard(haz) && actives.some(i => !!clears[i]);
      if (clearOffered(expected.table.myHazardClear, s0.myActive, s0.myHazards) || clearOffered(expected.table.oppHazardClear, s0.oppActive, s0.oppHazards)) actionClasses.push('hazardclear');
      const explored: SearchExplored = {
        depth,
        myActions: myRootJoints.length,
        oppActions: oppRootJoints.length,
        spreads: maxSpreads,
        megaBranches: myPlans.length * oppPlans.length,
        regimes: 3,
        actionClasses,
      };

      // True only when inference has actually learned something from observed
      // damage / turn order (not merely seeded candidates).
      const adapted = input.opp.some(o =>
        (o.entry.candidateLikelihoods?.length ?? 0) > 0 ||
        o.entry.speedFloor != null || o.entry.speedCeiling != null || !!o.entry.scarfSuspected);

      // Mechanics in this position the fast search only approximates → the user
      // can weigh the verdict / opt into the exact engine.
      const unmodeled = unmodeledMechanics(input);

      return {
        depth,
        score: expected.score,
        plays: playsFromJoint(expected.table, expected.joint),
        verdict: eV,
        megaMon: expected.myMega != null ? input.mine[expected.myMega]!.set.species : undefined,
        // A restricted (narrow) pass can't prove a worst-case outcome — it may
        // have pruned my saving option or the opp's refuting spread/switch — so it
        // never claims `forced`, only a tentative verdict.
        forced: forced && fullBreadth,
        winChance,
        allOppRevealed,
        risks,
        oppLine: oppLine.length ? oppLine : undefined,
        obviousOppPlay: (() => { const p = obviousOppPlay(expected.table, s0); return p.length ? p : undefined; })(),
        assumptions: assumptions.length ? assumptions : undefined,
        breakpoints: breakpoints.length ? breakpoints : undefined,
        explored,
        breadth: { spreadK, switchPlyLimit, full: fullBreadth },
        adapted,
        hailMary,
        unmodeled: unmodeled.length ? unmodeled : undefined,
      };
    },
  };
}

/** Search the position to a fixed depth (plies) and return the best joint play. */
export function searchToDepth(input: SearchInput, depth: number): SearchResult {
  return createSearch(input).toDepth(depth);
}

/**
 * Iterative deepening: search depth 1, 2, … up to `maxDepth`, invoking
 * `onDepth` after each completes (so a background driver can publish improving
 * results). Returns the deepest result. Tables are built once. Pure aside from
 * the optional callback.
 */
export function searchIterative(
  input: SearchInput,
  maxDepth: number,
  onDepth?: (r: SearchResult) => void,
): SearchResult {
  const search = createSearch(input);
  let last: SearchResult = { depth: 0, score: 0, plays: [], verdict: 'even', forced: false, allOppRevealed: input.allOppRevealed ?? false, risks: [] };
  for (let d = 1; d <= maxDepth; d++) {
    last = search.toDepth(d);
    onDepth?.(last);
  }
  return last;
}

/** One pass of the "work outwards" schedule: a breadth, a depth cap, a per-tier
 *  wall-clock budget, and a short label for the confidence chip. */
export interface WideningTier { breadth: SearchBreadth; maxDepth: number; budgetMs: number; label: string }

/**
 * Step C widening schedule — the "fast read, then deep probe, then work outwards" plan.
 *
 * Driven by how WIDE the position is (live mons both sides):
 *  - Small (endgame, ≤5 live): full breadth is already cheap AND deep (the cost
 *    plateaus because games terminate), so skip the probes and run one deep, fully
 *    trustworthy pass. This is the case where depth pays off the most.
 *  - Wide (a fresh 4v4): full-breadth depth is stuck at ~2-3 plies. Run that fast
 *    authoritative pass FIRST (it alone may claim `forced`), then spend the rest of
 *    the budget on a NARROW+DEEP probe (most-likely opp spread, no deep switches)
 *    for a TENTATIVE read several plies further out. The probe never claims forced;
 *    the UI shows it as a separate "deep probe" read alongside the verified verdict.
 *
 * The driver runs these in order, deepening within each under its budget, and
 * advances to the next when a tier hits its depth cap or can't afford another ply.
 */
export function wideningSchedule(liveTotal: number): WideningTier[] {
  if (liveTotal <= 5) {
    return [{ breadth: {}, maxDepth: 10, budgetMs: 4000, label: 'full · deep' }];
  }
  return [
    { breadth: {}, maxDepth: 3, budgetMs: 1500, label: 'full' },
    // Bigger budget so the probe can actually clear one ply past the full read on a
    // wide board (production narrow depth-3 ≈ 7s). Only runs when the full pass was
    // 'even' (driver gate), so this cost is paid only on genuinely contested turns.
    { breadth: { spreadK: 1, switchPlyLimit: 0 }, maxDepth: 6, budgetMs: 9000, label: 'probe · narrow+deep' },
  ];
}

// ---------------------------------------------------------------------------
// Public one-turn resolution (for the @pkmn/sim diff-harness)
// ---------------------------------------------------------------------------

/** One action our fast search can represent for an active mon. `target` is the
 *  opponent's team-index (the foe to hit). */
export type TurnAction =
  | { kind: 'attack'; target: number }
  | { kind: 'spread' }
  | { kind: 'protect' }
  | { kind: 'status'; target: number }   // inflict a status move on the foe at `target`
  | { kind: 'redirect' }                  // Follow Me / Rage Powder
  | { kind: 'pivot'; target: number }     // U-turn/Volt Switch/Parting Shot at `target`, then switch out
  | { kind: 'debuff'; target: number }    // Charm/Scary Face/… on the foe at `target`
  | { kind: 'taunt'; target: number }     // Taunt the foe at `target`
  | { kind: 'encore'; target: number }    // Encore the foe at `target`
  | { kind: 'fakeout'; target: number }   // Fake Out the foe at `target`
  | { kind: 'prio'; target: number }      // best priority move (Sucker Punch/Aqua Jet/…) at `target`
  | { kind: 'helpinghand' }               // Helping Hand — boost the ally ×1.5 this turn
  | { kind: 'wideguard' }                 // Wide Guard — block the foes' spread moves this turn
  | { kind: 'quickguard' }                // Quick Guard — block the foes' priority moves this turn
  | { kind: 'strengthsap' }               // Strength Sap — heal by the foe's Atk + drop its Atk −1
  | { kind: 'clearhazard' }               // Rapid Spin / Defog / … — remove entry hazards
  | { kind: 'recover' }                   // Recover / Roost / Wish (delayed) — self-heal
  | { kind: 'substitute' }                // Substitute — pay 25% HP for a sub
  | { kind: 'counter' }                   // Counter / Mirror Coat / Metal Burst — reflect
  | { kind: 'room' };                     // Gravity / Wonder Room / Magic Room — set a field room

/** Post-turn structural state of one mon (by team-index). HP is our coarse
 *  representative value — the harness compares the DISCRETE fields (fainted /
 *  status / boosts / field) where a difference means a real modelling gap, not a
 *  damage roll. `moveUsed` is the concrete move our cell picked, so the sim can be
 *  told to use the SAME move for a fair comparison. */
export interface ResolvedSlot {
  species: string;
  hpPct: number;
  fainted: boolean;
  status: string;
  boosts: Partial<Record<'atk' | 'def' | 'spa' | 'spd' | 'spe', number>>;
  moveUsed?: string;
  /** Taunt / Encore turns remaining after the turn (for diff-harness / tests). */
  taunt?: number;
  encore?: number;
  /** Unburden active (item consumed → ×2 Spe). */
  unburden?: boolean;
  /** Long-tail mechanic state after the turn (for diff-harness / tests). */
  recharge?: boolean;
  locked?: number;
  disguise?: boolean;
  subHp?: number;
  wish?: number;
}
export interface ResolvedTurn {
  mine: ResolvedSlot[];
  opp: ResolvedSlot[];
  weather: string;
  terrain: string;
}

/**
 * Resolve a SINGLE turn through the fast search's own turn engine, given each
 * side's chosen actions (keyed by active team-index). Returns the post-turn
 * structural state of every mon plus the concrete move each attacker used. Pure;
 * no mega branch (the harness drives base formes). This is the fast-search side of
 * the sim diff-harness — see `project_sim_engine_strategy`.
 */
export function resolveOneTurn(
  input: SearchInput,
  myActions: Map<number, TurnAction>,
  oppActions: Map<number, TurnAction>,
): ResolvedTurn {
  const t = buildTables(input, { myMega: null, oppMega: null });
  const s0 = initialState(input);
  const myTargets = new Map<number, number>();
  const oppTargets = new Map<number, number>();
  const myMove = new Map<number, string>();
  const oppMove = new Map<number, string>();
  for (const [actor, a] of myActions) {
    if (a.kind === 'attack') { myTargets.set(actor, a.target); myMove.set(actor, t.off[actor]?.[a.target]?.move ?? ''); }
    else if (a.kind === 'spread') { myTargets.set(actor, SPREAD); myMove.set(actor, t.mySpread[actor]?.move ?? ''); }
    else if (a.kind === 'status') { myTargets.set(actor, statusCode(a.target)); myMove.set(actor, t.myStatusMove[actor]?.move ?? ''); }
    else if (a.kind === 'redirect') { myTargets.set(actor, REDIRECT); myMove.set(actor, t.myRedirectMove[actor] ?? ''); }
    else if (a.kind === 'pivot') { myTargets.set(actor, pivotCode(a.target)); myMove.set(actor, t.myPivotMove[actor] ?? ''); }
    else if (a.kind === 'debuff') { myTargets.set(actor, debuffCode(a.target)); myMove.set(actor, t.myDebuffMove[actor]?.move ?? ''); }
    else if (a.kind === 'taunt') { myTargets.set(actor, tauntCode(a.target)); myMove.set(actor, t.myTauntMove[actor] ?? ''); }
    else if (a.kind === 'encore') { myTargets.set(actor, encoreCode(a.target)); myMove.set(actor, t.myEncoreMove[actor] ?? ''); }
    else if (a.kind === 'fakeout') { myTargets.set(actor, fakeOutCode(a.target)); myMove.set(actor, 'Fake Out'); }
    else if (a.kind === 'prio') { myTargets.set(actor, prioCode(a.target)); myMove.set(actor, t.myPrioCell[actor]?.[a.target]?.move ?? ''); }
    else if (a.kind === 'helpinghand') { myTargets.set(actor, HELP_HAND); myMove.set(actor, 'Helping Hand'); }
    else if (a.kind === 'wideguard') { myTargets.set(actor, WIDE_GUARD); myMove.set(actor, 'Wide Guard'); }
    else if (a.kind === 'quickguard') { myTargets.set(actor, QUICK_GUARD); myMove.set(actor, 'Quick Guard'); }
    else if (a.kind === 'strengthsap') { myTargets.set(actor, SAP); myMove.set(actor, 'Strength Sap'); }
    else if (a.kind === 'clearhazard') { myTargets.set(actor, CLEAR_HAZARD); myMove.set(actor, t.myHazardClear[actor]?.move ?? 'Rapid Spin'); }
    else if (a.kind === 'recover') { myTargets.set(actor, RECOVER); myMove.set(actor, t.myRecover[actor]?.move ?? 'Recover'); }
    else if (a.kind === 'substitute') { myTargets.set(actor, SET_SUB); myMove.set(actor, 'Substitute'); }
    else if (a.kind === 'counter') { myTargets.set(actor, COUNTER); myMove.set(actor, t.myCounter[actor] ? 'Counter' : ''); }
    else if (a.kind === 'room') { myTargets.set(actor, SET_ROOM); myMove.set(actor, t.myRoomMove[actor] ?? ''); }
    else { myTargets.set(actor, PROTECT); }
  }
  for (const [actor, a] of oppActions) {
    if (a.kind === 'attack') { oppTargets.set(actor, a.target); oppMove.set(actor, t.thr[actor]?.[a.target]?.move ?? ''); }
    else if (a.kind === 'spread') { oppTargets.set(actor, SPREAD); oppMove.set(actor, t.oppSpread[actor]?.move ?? ''); }
    else if (a.kind === 'status') { oppTargets.set(actor, statusCode(a.target)); oppMove.set(actor, t.oppStatusMove[actor]?.move ?? ''); }
    else if (a.kind === 'redirect') { oppTargets.set(actor, REDIRECT); oppMove.set(actor, t.oppRedirectMove[actor] ?? ''); }
    else if (a.kind === 'pivot') { oppTargets.set(actor, pivotCode(a.target)); oppMove.set(actor, t.oppPivotMove[actor] ?? ''); }
    else if (a.kind === 'debuff') { oppTargets.set(actor, debuffCode(a.target)); oppMove.set(actor, t.oppDebuffMove[actor]?.move ?? ''); }
    else if (a.kind === 'taunt') { oppTargets.set(actor, tauntCode(a.target)); oppMove.set(actor, t.oppTauntMove[actor] ?? ''); }
    else if (a.kind === 'encore') { oppTargets.set(actor, encoreCode(a.target)); oppMove.set(actor, t.oppEncoreMove[actor] ?? ''); }
    else if (a.kind === 'fakeout') { oppTargets.set(actor, fakeOutCode(a.target)); oppMove.set(actor, 'Fake Out'); }
    else if (a.kind === 'prio') { oppTargets.set(actor, prioCode(a.target)); oppMove.set(actor, t.oppPrioCell[actor]?.[a.target]?.move ?? ''); }
    else if (a.kind === 'helpinghand') { oppTargets.set(actor, HELP_HAND); oppMove.set(actor, 'Helping Hand'); }
    else if (a.kind === 'wideguard') { oppTargets.set(actor, WIDE_GUARD); oppMove.set(actor, 'Wide Guard'); }
    else if (a.kind === 'quickguard') { oppTargets.set(actor, QUICK_GUARD); oppMove.set(actor, 'Quick Guard'); }
    else if (a.kind === 'strengthsap') { oppTargets.set(actor, SAP); oppMove.set(actor, 'Strength Sap'); }
    else if (a.kind === 'clearhazard') { oppTargets.set(actor, CLEAR_HAZARD); oppMove.set(actor, t.oppHazardClear[actor]?.move ?? 'Rapid Spin'); }
    else if (a.kind === 'recover') { oppTargets.set(actor, RECOVER); oppMove.set(actor, t.oppRecover[actor]?.move ?? 'Recover'); }
    else if (a.kind === 'substitute') { oppTargets.set(actor, SET_SUB); oppMove.set(actor, 'Substitute'); }
    else if (a.kind === 'counter') { oppTargets.set(actor, COUNTER); oppMove.set(actor, t.oppCounter[actor] ? 'Counter' : ''); }
    else if (a.kind === 'room') { oppTargets.set(actor, SET_ROOM); oppMove.set(actor, t.oppRoomMove[actor] ?? ''); }
    else { oppTargets.set(actor, PROTECT); }
  }
  const pass: Pass = {
    regime: 'expected',
    survMy: input.mine.map(m => !!m.survival),
    survOpp: input.opp.map(o => !!o.survival),
  };
  const s = resolveTurn(t, s0, myTargets, oppTargets, pass);
  const slot = (i: number, hp: number[], status: string[], boost: BoostMap[], species: string[], move?: string): ResolvedSlot => ({
    species: species[i]!, hpPct: Math.max(0, hp[i] ?? 0), fainted: (hp[i] ?? 0) <= 0,
    status: status[i] ?? '', boosts: { ...boost[i] }, moveUsed: move,
  });
  return {
    mine: input.mine.map((_, i) => ({ ...slot(i, s.myHp, s.myStatus, s.myBoost, t.mySpecies, myMove.get(i)), taunt: s.myTaunt[i], encore: s.myEncore[i], unburden: s.myUnburden[i], recharge: s.myRecharge[i], locked: s.myLocked[i], disguise: s.myDisguise[i], subHp: s.mySubHp[i], wish: s.myWish[i] })),
    opp: input.opp.map((_, j) => ({ ...slot(j, s.oppHp, s.oppStatus, s.oppBoost, t.oppSpecies, oppMove.get(j)), taunt: s.oppTaunt[j], encore: s.oppEncore[j], unburden: s.oppUnburden[j], recharge: s.oppRecharge[j], locked: s.oppLocked[j], disguise: s.oppDisguise[j], subHp: s.oppSubHp[j], wish: s.oppWish[j] })),
    weather: s.weather ?? '',
    terrain: s.terrain ?? '',
  };
}
