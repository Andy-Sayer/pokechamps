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
import type { PokemonSet, OpponentEntry, FieldState, Match } from './types.js';
import { ZERO_EVS, MAX_IVS } from './types.js';
import { predictOffense, predictThreat, pikalyticsMoves } from './predictions.js';
import { actualSpeed, effectiveSpeedRange } from './speed.js';
import { getMove, getSpecies, toId, isSpreadMove, moveFlinchChance } from './data.js';
import { getMegaOptions } from './gimmicks/mega.js';
import { defaultOpponentSet } from './bring.js';
import { maxHpFor } from './damage.js';
import { getPikalytics } from './pikalytics.js';

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
   *  'switch' | 'tailwind' | 'trickroom'. Drives the breadth wording. */
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
  /** Pivotal assumptions behind the verdict (contingent speed, etc.). */
  assumptions?: SearchAssumption[];
  /** Concrete damage cutpoints that flip the verdict this turn. */
  breakpoints?: SearchBreakpoint[];
  /** Honest breadth-of-search report for the confidence chip. */
  explored?: SearchExplored;
  /** True when the opponent's spread/item has been refined from observed damage
   *  (inference produced candidates) — surfaced so the user knows the read is
   *  data-driven, not a prior. */
  adapted?: boolean;
  /** Dice-roll outs analysis — only present when verdict === 'losing' && !forced
   *  and the optimistic regime finds a winning path. */
  hailMary?: HailMary;
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
// Ranged sentinel blocks that each carry an index, kept disjoint so a code is
// unambiguous. Switches: [-19,-10] → bench idx. Leech Seed: [-29,-20] → foe idx.
// Baton Pass: ≤ -30 → bench idx (switch that passes boosts). All ROOT-ply only.
const SWITCH_BASE = -10;  // switch → bench idx `SWITCH_BASE - target`
const LEECH_BASE = -20;   // Leech Seed → foe idx `LEECH_BASE - target`
const BATON_BASE = -30;   // Baton Pass → bench idx `BATON_BASE - target`
function isSwitchTarget(t: number): boolean { return t <= SWITCH_BASE && t > LEECH_BASE; }
function switchBenchIdx(t: number): number { return SWITCH_BASE - t; }
function switchCode(benchIdx: number): number { return SWITCH_BASE - benchIdx; }
function isLeechTarget(t: number): boolean { return t <= LEECH_BASE && t > BATON_BASE; }
function leechFoeIdx(t: number): number { return LEECH_BASE - t; }
function leechCode(foeIdx: number): number { return LEECH_BASE - foeIdx; }
function isBatonTarget(t: number): boolean { return t <= BATON_BASE; }
function batonBenchIdx(t: number): number { return BATON_BASE - t; }
function batonCode(benchIdx: number): number { return BATON_BASE - benchIdx; }
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
interface Cell { dmgMin: number; dmgMid: number; dmgMax: number; move: string; priority: number; multiHit: boolean; koRolls: number[]; candidates: number; physical: boolean }

/** A spread move option for one of my mons: the move plus its (already
 *  spread-reduced) damage vs each opp index, at min/mid/max rolls. */
interface SpreadOpt { move: string; priority: number; dmgMin: number[]; dmgMid: number[]; dmgMax: number[]; physical: boolean }

/** Live stat-stage boosts (−6..+6) per stat. */
type BoostMap = Partial<Record<'atk' | 'def' | 'spa' | 'spd' | 'spe', number>>;

// True for a physical move (uses Atk/Def); false = special (SpA/SpD). Status
// moves are physical=false but never deal damage so it's moot.
function isPhysicalMove(move: string): boolean {
  return ((getMove(move) as { category?: string } | undefined)?.category) === 'Physical';
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

interface Tables {
  myN: number;
  oppN: number;
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
  // Screen-move capability: what a SET_SCREEN action puts up for the caster's
  // side, + the move name; null = the mon knows no screen move.
  myScreen: (ScreenSet | null)[];
  oppScreen: (ScreenSet | null)[];
  field: FieldState;
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

// True for a Grass-type species (immune to Leech Seed).
function isGrassType(species: string): boolean {
  const sp = getSpecies(species) as { types?: string[] } | undefined;
  return (sp?.types ?? []).includes('Grass');
}

// Single-user protection moves (user fully blocks incoming damage for one turn).
// Wide Guard / Quick Guard / Mat Block protect the TEAM and are not modelled here.
const PROTECT_MOVE_IDS = new Set(['protect', 'detect', 'kingsshield', 'banefulbunker', 'spikyshield', 'obstruct', 'silktrap']);
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
      move: mv, priority: movePriority(mv), physical: isPhysicalMove(mv),
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
      move: mv, priority: movePriority(mv), physical: isPhysicalMove(mv),
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
}

// Doubles screen damage reduction (2732/4096 ≈ 0.667), matching @smogon/calc's
// gameType:'Doubles' modifier. A screen on the DEFENDER's side reduces incoming
// damage of the matching category.
const SCREEN_MULT = 2732 / 4096;
function screenMult(up: boolean): number { return up ? SCREEN_MULT : 1; }

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
  if (!c) return { dmgMin: 0, dmgMid: 0, dmgMax: 0, move: '', priority: 0, multiHit: false, koRolls: [], candidates: 0, physical: false };
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
): number {
  const off = physical ? 'atk' : 'spa';
  const def = physical ? 'def' : 'spd';
  const offScale = statStageMult(attacker?.[off]) / statStageMult(attackerBaked?.[off]);
  const defScale = statStageMult(defenderBaked?.[def]) / statStageMult(defender?.[def]);
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
  const off: Cell[][] = mine.map((m, mi) => oppEntries.map((oe, oj) =>
    cellFromOffense(m.set, oe, input.field, {
      attackerGimmickActive: myMega(mi),
      defenderGimmickActive: oppHypoMega(oj),
      attackerBoosts: m.boosts, attackerStatus: m.status,
      defenderBoosts: opp[oj]!.boosts, defenderStatus: opp[oj]!.status,
    })));
  const thr: Cell[][] = oppEntries.map((oe, oj) => mine.map((m, mi) =>
    cellFromThreat(oe, m.set, input.field, {
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
  return {
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
    myScreen: mine.map(m => findScreenMove(m.set.moves ?? [])),
    oppScreen: opp.map(o => findScreenMove(o.entry.knownMoves)),
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
  };
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
  for (const [actor, target] of myTargets) {
    if (isSwitchTarget(target)) mySwitchIn.set(actor, switchBenchIdx(target));
    else if (isBatonTarget(target)) { const b = batonBenchIdx(target); mySwitchIn.set(actor, b); myBaton.set(actor, b); }
  }
  for (const [actor, target] of oppTargets) {
    if (isSwitchTarget(target)) oppSwitchIn.set(actor, switchBenchIdx(target));
    else if (isBatonTarget(target)) { const b = batonBenchIdx(target); oppSwitchIn.set(actor, b); oppBaton.set(actor, b); }
  }
  const myActiveNow = s.myActive.map(i => mySwitchIn.get(i) ?? i);
  const oppActiveNow = s.oppActive.map(i => oppSwitchIn.get(i) ?? i);
  // A hit aimed at a mon that switched out lands on its replacement instead.
  const redirect = (target: number, defSwitch: Map<number, number>) => defSwitch.get(target) ?? target;

  // Effective speed including the DYNAMIC Spe stage (Speed Boost / Dragon Dance):
  // scale the baked speed by the ratio of current vs baked Spe-stage multiplier.
  const mySpe = (i: number) => t.mySpeed[i]! * (statStageMult(s.myBoost[i]?.spe) / statStageMult(t.myBaked[i]?.spe));
  const oppSpe = (j: number) => t.oppSpeed[j]! * (statStageMult(s.oppBoost[j]?.spe) / statStageMult(t.oppBaked[j]?.spe));
  // Screen damage scale on the DEFENDER's side: live screen vs the one baked into
  // the cell. Reflect halves physical, Light Screen special. 1 when unchanged.
  const myScreenScale = (physical: boolean) =>           // I attack opp → opp's (their) side
    screenMult(physical ? s.theirReflect : s.theirLightScreen) / screenMult(physical ? !!t.field.theirReflect : !!t.field.theirLightScreen);
  const oppScreenScale = (physical: boolean) =>          // opp attacks me → my side
    screenMult(physical ? s.myReflect : s.myLightScreen) / screenMult(physical ? !!t.field.myReflect : !!t.field.myLightScreen);
  // Scale a precomputed roll by the live-vs-baked boost AND screen ratios (each 1
  // when unchanged, so positions without dynamic boosts/screens are unaffected).
  const myDmg = (actor: number, tgt: number, raw: number, physical: boolean) =>
    raw * boostDamageScale(s.myBoost[actor], t.myBaked[actor], s.oppBoost[tgt], t.oppBaked[tgt], physical) * myScreenScale(physical);
  const oppDmg = (actor: number, tgt: number, raw: number, physical: boolean) =>
    raw * boostDamageScale(s.oppBoost[actor], t.oppBaked[actor], s.myBoost[tgt], t.myBaked[tgt], physical) * oppScreenScale(physical);

  // Build protected sets: a mon using PROTECT is immune to all damage this turn.
  const myProtected = new Set<number>();
  const oppProtected = new Set<number>();
  for (const [actor, target] of myTargets) { if (target === PROTECT) myProtected.add(actor); }
  for (const [actor, target] of oppTargets) { if (target === PROTECT) oppProtected.add(actor); }

  // Apply `dmg` to hp[idx]; if it would be lethal FROM FULL HP and a survival
  // charge is available, clamp to 1 and consume it (Focus Sash / Sturdy). A
  // multi-hit move breaks through survival, so `breaks` skips the clamp.
  const apply = (hp: number[], idx: number, dmg: number, surv: boolean[], breaks: boolean) => {
    const before = hp[idx]!;
    const after = before - dmg;
    if (!breaks && after <= 0 && before >= 100 && surv[idx]) { surv[idx] = false; hp[idx] = 1; }
    else hp[idx] = Math.max(0, after);
  };

  // Switch / field / Leech Seed / setup / screen / Baton Pass deal no DIRECT damage.
  const nonAttack = (target: number) =>
    isSwitchTarget(target) || isBatonTarget(target) || isLeechTarget(target) || isFieldTarget(target) || target === SET_BOOST || target === SET_SCREEN;
  const actings: Acting[] = [];
  for (const [actor, target] of myTargets) {
    if (nonAttack(target)) continue;
    const priority = target === SPREAD ? t.mySpread[actor]!.priority
      : target === PROTECT ? movePriority(t.myProtectMove[actor] ?? 'Protect')
      : t.off[actor]![target]!.priority;
    actings.push({ side: 'mine', actor, target, priority, speed: effSpeed(mySpe(actor), s.myTailwind, t.myPar[actor]!) });
  }
  for (const [actor, target] of oppTargets) {
    if (nonAttack(target)) continue;
    const priority = target === SPREAD ? t.oppSpread[actor]!.priority
      : target === PROTECT ? movePriority(t.oppProtectMove[actor] ?? 'Protect')
      : t.thr[actor]![target]!.priority;
    actings.push({ side: 'opp', actor, target, priority, speed: effSpeed(oppSpe(actor), s.theirTailwind, t.oppPar[actor]!) });
  }

  // Priority first (higher acts first), then speed (Trick Room inverts speed).
  actings.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return tr ? a.speed - b.speed : b.speed - a.speed;
  });

  for (const act of actings) {
    if (act.side === 'mine') {
      if (myHp[act.actor]! <= 0) continue;          // KO'd before acting
      if (act.target === PROTECT) continue;           // mon uses Protect — no damage dealt
      if (act.target === SPREAD) {
        // Spread move — hit every live, unprotected foe ON THE FIELD AFTER switches
        // (oppActiveNow; a benched mon isn't in range of a spread move).
        const sp = t.mySpread[act.actor]!;
        const dmg = mySpreadRoll(sp, r);
        for (const foe of oppActiveNow) {
          if (oppHp[foe]! <= 0) continue;
          if (oppProtected.has(foe)) continue;       // opp protecting this turn
          apply(oppHp, foe, myDmg(act.actor, foe, dmg[foe] ?? 0, sp.physical), oppSurv, false);
        }
        continue;
      }
      const oTgt = redirect(act.target, oppSwitchIn); // hit the replacement if the target switched
      if (oppProtected.has(oTgt)) continue;          // target protecting → fizzle
      if (oppHp[oTgt]! <= 0) continue;               // target already down → fizzle
      const oc = t.off[act.actor]![oTgt]!;
      apply(oppHp, oTgt, myDmg(act.actor, oTgt, myRoll(oc, r), oc.physical), oppSurv, oc.multiHit);
    } else {
      if (oppHp[act.actor]! <= 0) continue;
      if (act.target === PROTECT) continue;           // opp mon uses Protect
      if (act.target === SPREAD) {
        // Opp spread move — hit every live, unprotected mon of mine ON THE FIELD
        // AFTER switches (myActiveNow; my bench isn't in range).
        const sp = t.oppSpread[act.actor]!;
        const dmg = oppSpreadRoll(sp, r);
        for (const me of myActiveNow) {
          if (myHp[me]! <= 0) continue;
          if (myProtected.has(me)) continue;          // my mon protecting this turn
          apply(myHp, me, oppDmg(act.actor, me, dmg[me] ?? 0, sp.physical), mySurv, false);
        }
        continue;
      }
      const mTgt = redirect(act.target, mySwitchIn);  // hit the replacement if my target switched
      if (myProtected.has(mTgt)) continue;            // my mon protecting → fizzle
      if (myHp[mTgt]! <= 0) continue;
      const tc = t.thr[act.actor]![mTgt]!;
      apply(myHp, mTgt, oppDmg(act.actor, mTgt, oppRoll(tc, r), tc.physical), mySurv, tc.multiHit);
    }
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
  const tick = (active: boolean, turns: number | undefined): [boolean, number | undefined] => {
    if (active && turns != null) { const t = turns - 1; return t <= 0 ? [false, undefined] : [true, t]; }
    return [active, turns];
  };
  let [trickRoom, trickRoomTurns] = tick(s.trickRoom, s.trickRoomTurns);
  let [myTailwind, myTailwindTurns] = tick(s.myTailwind, s.myTailwindTurns);
  let [theirTailwind, theirTailwindTurns] = tick(s.theirTailwind, s.theirTailwindTurns);
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
    if ((oppHp[foe] ?? 0) > 0 && oppSeeded[foe] == null && !t.oppGrass[foe]) oppSeeded[foe] = actor;
  }
  for (const [actor, target] of oppTargets) {
    if (!isLeechTarget(target)) continue;
    const foe = redirect(leechFoeIdx(target), mySwitchIn);
    if ((myHp[foe] ?? 0) > 0 && mySeeded[foe] == null && !t.myGrass[foe]) mySeeded[foe] = actor;
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
  for (const i of myActiveNow) if ((myHp[i] ?? 0) > 0 && t.mySpeedBoost[i]) myBoost[i] = addBoosts(myBoost[i]!, { spe: 1 });
  for (const j of oppActiveNow) if ((oppHp[j] ?? 0) > 0 && t.oppSpeedBoost[j]) oppBoost[j] = addBoosts(oppBoost[j]!, { spe: 1 });

  // Start from the post-switch slots, then refill from bench after KOs. The opp
  // only auto-refills with ALREADY-REVEALED mons — an unrevealed phantom enters
  // solely via a deliberate root switch (otherwise refill would silently reveal
  // more than the 4 brought).
  const myActive = refill(myActiveNow, myHp, t.myN, t.off, oppHp);
  const oppActive = refill(oppActiveNow, oppHp, t.oppN, t.thr, myHp, oppSeen);
  return {
    myHp, oppHp, myActive, oppActive, myProtectStreak, oppProtectStreak, oppSeen,
    trickRoom, myTailwind, theirTailwind, trickRoomTurns, myTailwindTurns, theirTailwindTurns,
    mySeeded, oppSeeded, myBoost, oppBoost,
    myReflect, myLightScreen, theirReflect, theirLightScreen,
    myReflectTurns, myLightScreenTurns, theirReflectTurns, theirLightScreenTurns,
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
): Array<Map<number, number>> {
  const liveFoes = foeActive.filter(j => (foeHp[j] ?? 0) > 0);
  if (liveFoes.length === 0) return [];
  const switchCodes = (switchTargets ?? []).map(switchCode);
  // Bench index a switch/baton code resolves to (for the no-duplicate rule).
  const benchOf = (code: number) => isSwitchTarget(code) ? switchBenchIdx(code) : isBatonTarget(code) ? batonBenchIdx(code) : -999;
  let combos: Array<Map<number, number>> = [new Map()];
  for (const actor of active) {
    const canProtect = (protectMoves?.[actor] != null) && (protectStreak?.[actor] ?? 0) === 0;
    const canTailwind = fieldMoves?.tailwind?.[actor] != null;
    const canTrickRoom = fieldMoves?.trickRoom?.[actor] != null;
    const leechCodes = (leech && leech.move[actor] != null) ? leech.foes.map(leechCode) : [];
    const canSetup = setupMove?.[actor] != null;
    const canScreen = screenSet?.[actor] === true;
    const batonCodes = (baton && baton.move[actor] != null) ? baton.targets.map(batonCode) : [];
    // SPREAD first so a spread that ties a single-target line is kept. PROTECT /
    // field / setup / screen / Leech / SWITCH / Baton last — only chosen when they
    // strictly beat attacking.
    const options = [
      ...(spreadActors?.has(actor) ? [SPREAD] : []),
      ...liveFoes,
      ...(canProtect ? [PROTECT] : []),
      ...(canTailwind ? [SET_TAILWIND] : []),
      ...(canTrickRoom ? [SET_TRICKROOM] : []),
      ...(canSetup ? [SET_BOOST] : []),
      ...(canScreen ? [SET_SCREEN] : []),
      ...leechCodes,
      ...switchCodes,
      ...batonCodes,
    ];
    const next: Array<Map<number, number>> = [];
    for (const combo of combos) {
      for (const opt of options) {
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

// Maximin value of a state to the given depth. I maximise; opp replies worst-
// case. `alpha` is the best value found so far at this level for the inner
// prune.
function value(t: Tables, s: State, depth: number, alpha: number, pass: Pass): number {
  const term = terminal(s, depth);
  if (term !== null) return term;
  if (depth === 0) return leafScore(s);

  const myJoints = jointActions(s.myActive, s.oppActive, s.oppHp, t.mySpreadActors, t.myProtectMove, s.myProtectStreak);
  const oppJoints = jointActions(s.oppActive, s.myActive, s.myHp, t.oppSpreadActors, t.oppProtectMove, s.oppProtectStreak);
  if (myJoints.length === 0) return leafScore(s);

  let best = -Infinity;
  for (const my of myJoints) {
    let worst = Infinity;
    const replies = oppJoints.length ? oppJoints : [new Map<number, number>()];
    for (const opp of replies) {
      const child = resolveTurn(t, s, my, opp, pass);
      const v = value(t, child, depth - 1, best, pass);
      if (v < worst) worst = v;
      if (worst <= best) break;   // this my-action can't beat best — prune
    }
    if (worst > best) best = worst;
  }
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
  return jointActions(s.myActive, s.oppActive, s.oppHp, t.mySpreadActors, t.myProtectMove, s.myProtectStreak,
    myBench,
    // Don't re-offer Tailwind when it's already up; Trick Room is always a
    // meaningful toggle.
    { tailwind: s.myTailwind ? undefined : t.myTailwindMove, trickRoom: t.myTrickRoomMove },
    { move: t.myLeechMove, foes: leechFoes },
    t.mySetupMove,
    { move: t.myBatonMove, targets: myBench },
    myScreenCap);
}
function rootOppJoints(t: Tables, s: State): Array<Map<number, number>> {
  const leechFoes = s.myActive.filter(j => (s.myHp[j] ?? 0) > 0 && !t.myGrass[j] && s.mySeeded[j] == null);
  const oppBench = benchSwitchTargets(s.oppActive, s.oppHp, t.oppN);
  const oppScreenCap = t.oppScreen.map(sc => !!sc && ((sc.reflect && !s.theirReflect) || (sc.lightScreen && !s.theirLightScreen)));
  return jointActions(s.oppActive, s.myActive, s.myHp, t.oppSpreadActors, t.oppProtectMove, s.oppProtectStreak,
    oppBench,
    { tailwind: s.theirTailwind ? undefined : t.oppTailwindMove, trickRoom: t.oppTrickRoomMove },
    { move: t.oppLeechMove, foes: leechFoes },
    t.oppSetupMove,
    { move: t.oppBatonMove, targets: oppBench },
    oppScreenCap);
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

  const oppJoints = rootOppJoints(t, s0);
  for (const my of myJoints) {
    let worst = Infinity;
    const replies = oppJoints.length ? oppJoints : [new Map<number, number>()];
    for (const opp of replies) {
      const child = resolveTurn(t, s0, my, opp, pass);
      const v = value(t, child, depth - 1, bestScore, pass);
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
    if (isBatonTarget(target)) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myBatonMove[actor] ?? 'Baton Pass', targetSpecies: t.mySpecies[batonBenchIdx(target)]!, switch: true });
    } else if (isLeechTarget(target)) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myLeechMove[actor] ?? 'Leech Seed', targetSpecies: t.oppSpecies[leechFoeIdx(target)]! });
    } else if (isSwitchTarget(target)) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: 'switch', targetSpecies: t.mySpecies[switchBenchIdx(target)]!, switch: true });
    } else if (target === SET_BOOST) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.mySetupMove[actor] ?? 'setup', targetSpecies: t.mySpecies[actor]!, self: true });
    } else if (target === SET_SCREEN) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myScreen[actor]?.move ?? 'Screen', targetSpecies: t.mySpecies[actor]!, self: true });
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
    if (isBatonTarget(target)) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppBatonMove[actor] ?? 'Baton Pass', targetSpecies: t.oppSpecies[batonBenchIdx(target)]!, switch: true });
    } else if (isLeechTarget(target)) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppLeechMove[actor] ?? 'Leech Seed', targetSpecies: t.mySpecies[leechFoeIdx(target)]! });
    } else if (isSwitchTarget(target)) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: 'switch', targetSpecies: t.oppSpecies[switchBenchIdx(target)]!, switch: true });
    } else if (target === SET_BOOST) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppSetupMove[actor] ?? 'setup', targetSpecies: t.oppSpecies[actor]!, self: true });
    } else if (target === SET_SCREEN) {
      plays.push({ mySpecies: t.oppSpecies[actor]!, move: t.oppScreen[actor]?.move ?? 'Screen', targetSpecies: t.oppSpecies[actor]!, self: true });
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
    const v = value(t, child, depth - 1, -Infinity, pass);
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
export function createSearch(input: SearchInput): PositionSearch {
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

  const tables = new Map<string, Tables>();
  for (const myMega of myPlans) {
    for (const oppMega of oppPlans) {
      tables.set(`${myMega},${oppMega}`, buildTables(input, { myMega, oppMega }));
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
          const consider = (dmgMin: number, dmgMid: number, dmgMax: number, koRolls: number[], oj: number, oppMega: number | null, tbl: Tables) => {
            if (dmgMax < myHp || dmgMid >= myHp) return; // can't KO, or already lethal at median (not contingent)
            const koProb = koRolls.length
              ? koRolls.filter(r => r >= myHp).length / koRolls.length
              : dmgMax <= dmgMin ? 0 : Math.max(0, Math.min(1, (dmgMax - myHp) / (dmgMax - dmgMin)));
            if (koProb <= 0 || koProb >= 1) return;
            const base = tbl.oppSpecies[oj] ?? 'foe';
            const oppName = oppMega === oj ? (oppMegaInfo(base)?.forme ?? base) : base;
            if (!worst || koProb > worst.koProb) worst = { oppName, koProb, outspeeds: oppOutspeeds(tbl, s0, oj, mi) };
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
                consider({ dmgMin: sp.dmgMin[foe] ?? 0, dmgMid: sp.dmgMid[foe] ?? 0, dmgMax: sp.dmgMax[foe] ?? 0, move: '', priority: 0, multiHit: false, koRolls: [], candidates: 0, physical: false }, s0.oppHp[foe] ?? 0, expected.table.oppSpecies[foe] ?? 'foe');
              }
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

      // Hail Mary: when losing but the optimistic regime finds a winning path,
      // surface the specific dice rolls needed. This is the mirror of the
      // winning-side sensitivity analysis above.
      let hailMary: HailMary | undefined;
      if (eV === 'losing' && !forcedLoss) {
        if (opt.score >= WIN) {
          // There IS a winning path under best-case conditions. Find which
          // root-turn KOs in the opt play require a high roll to land.
          const hmOuts: HailMaryOut[] = [];
          let hmCombined = 1;
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
                // Uniform envelope estimate (no koRolls for spread moves).
                const p = dMax > dMid ? (dMax - h) / (dMax - dMid) : 0;
                if (p <= 0) continue;
                hmOuts.push({ label: `${opt.table.oppSpecies[foe] ?? 'foe'} KO needs top roll`, prob: p });
                hmCombined *= p;
              }
            } else if (target >= 0) {        // skip PROTECT / SWITCH (no KO this turn)
              const c = opt.table.off[actor]?.[target];
              if (!c) continue;
              const h = s0.oppHp[target] ?? 0;
              if (h <= 0 || c.dmgMax < h || c.dmgMid >= h) continue;
              const p = rollKoProb(c, h);
              if (p <= 0 || p >= 1) continue;
              hmOuts.push({ label: `${opt.table.oppSpecies[target] ?? 'foe'} KO needs top roll`, prob: p });
              hmCombined *= p;
            }
          }
          // If no roll-based outs at the root turn, the win comes from later
          // plies or from opp rolling low — add a generic unpriced caveat.
          if (!hmOuts.length) {
            hmOuts.push({ label: 'opp needs to roll low', prob: 0.5 });
            hmCombined = 0.5;
          }
          const combined = Math.max(0, Math.min(1, hmCombined));
          hailMary = {
            plays: playsFromJoint(opt.table, opt.joint),
            outs: hmOuts,
            combined,
            noRealisticOut: combined < 0.005,
          };
        } else {
          // Even optimistic conditions don't find a win — no realistic path.
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

      return {
        depth,
        score: expected.score,
        plays: playsFromJoint(expected.table, expected.joint),
        verdict: eV,
        megaMon: expected.myMega != null ? input.mine[expected.myMega]!.set.species : undefined,
        forced,
        winChance,
        allOppRevealed,
        risks,
        oppLine: oppLine.length ? oppLine : undefined,
        assumptions: assumptions.length ? assumptions : undefined,
        breakpoints: breakpoints.length ? breakpoints : undefined,
        explored,
        adapted,
        hailMary,
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
