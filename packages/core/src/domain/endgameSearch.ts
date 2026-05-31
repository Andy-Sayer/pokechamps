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
import { getMove, toId, isSpreadMove, moveFlinchChance } from './data.js';
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
// Sentinel target meaning "spread move — hit every live foe" (vs a foe index).
const SPREAD = -1;
// Sentinel target meaning "use Protect/Detect/etc. on self" (vs a foe index).
const PROTECT = -2;

// ---------------------------------------------------------------------------
// Internal flat model (indices into precomputed arrays)
// ---------------------------------------------------------------------------

// Damage as % of target max, at three roll points so the tree can be evaluated
// under different regimes without rebuilding the (expensive) matrix. Roll risk
// is derived from the dmgMin..dmgMax envelope vs the target's HP at use time.
interface Cell { dmgMin: number; dmgMid: number; dmgMax: number; move: string; priority: number; multiHit: boolean; koRolls: number[] }

/** A spread move option for one of my mons: the move plus its (already
 *  spread-reduced) damage vs each opp index, at min/mid/max rolls. */
interface SpreadOpt { move: string; priority: number; dmgMin: number[]; dmgMid: number[]; dmgMax: number[] }

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
  field: FieldState;
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
      move: mv, priority: movePriority(mv),
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
      move: mv, priority: movePriority(mv),
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
  if (!c) return { dmgMin: 0, dmgMid: 0, dmgMax: 0, move: '', priority: 0, multiHit: false, koRolls: [] };
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
function speStageMult(stage: number | undefined): number {
  const n = stage ?? 0;
  if (n === 0) return 1;
  return n > 0 ? (2 + n) / 2 : 2 / (2 - n);
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
function oppOutspeeds(t: Tables, oj: number, mi: number): boolean {
  const myS = effSpeed(t.mySpeed[mi]!, !!t.field.myTailwind, t.myPar[mi]!);
  const oppS = effSpeed(t.oppSpeed[oj]!, !!t.field.theirTailwind, t.oppPar[oj]!);
  return t.field.trickRoom ? oppS < myS : oppS > myS;
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
  const tr = !!t.field.trickRoom;
  const r = pass.regime;
  // Survival charges available this turn (Focus Sash / Sturdy), consumed on
  // first use. Only meaningful from full HP — enforced at apply time.
  const oppSurv = pass.survOpp.slice();
  const mySurv = pass.survMy.slice();

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

  const actings: Acting[] = [];
  for (const [actor, target] of myTargets) {
    const priority = target === SPREAD ? t.mySpread[actor]!.priority
      : target === PROTECT ? movePriority(t.myProtectMove[actor] ?? 'Protect')
      : t.off[actor]![target]!.priority;
    actings.push({ side: 'mine', actor, target, priority, speed: effSpeed(t.mySpeed[actor]!, !!t.field.myTailwind, t.myPar[actor]!) });
  }
  for (const [actor, target] of oppTargets) {
    const priority = target === SPREAD ? t.oppSpread[actor]!.priority
      : target === PROTECT ? movePriority(t.oppProtectMove[actor] ?? 'Protect')
      : t.thr[actor]![target]!.priority;
    actings.push({ side: 'opp', actor, target, priority, speed: effSpeed(t.oppSpeed[actor]!, !!t.field.theirTailwind, t.oppPar[actor]!) });
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
        // Spread move — hit every live, unprotected foe.
        const sp = t.mySpread[act.actor]!;
        const dmg = mySpreadRoll(sp, r);
        for (let foe = 0; foe < oppHp.length; foe++) {
          if (oppHp[foe]! <= 0) continue;
          if (oppProtected.has(foe)) continue;       // opp protecting this turn
          apply(oppHp, foe, dmg[foe] ?? 0, oppSurv, false); // spread moves aren't multi-hit
        }
        continue;
      }
      if (oppProtected.has(act.target)) continue;    // target protecting → fizzle
      if (oppHp[act.target]! <= 0) continue;        // target already down → fizzle
      const oc = t.off[act.actor]![act.target]!;
      apply(oppHp, act.target, myRoll(oc, r), oppSurv, oc.multiHit);
    } else {
      if (oppHp[act.actor]! <= 0) continue;
      if (act.target === PROTECT) continue;           // opp mon uses Protect
      if (act.target === SPREAD) {
        // Opp spread move — hit every live, unprotected mon of mine.
        const sp = t.oppSpread[act.actor]!;
        const dmg = oppSpreadRoll(sp, r);
        for (let me = 0; me < myHp.length; me++) {
          if (myHp[me]! <= 0) continue;
          if (myProtected.has(me)) continue;          // my mon protecting this turn
          apply(myHp, me, dmg[me] ?? 0, mySurv, false); // spread moves aren't multi-hit
        }
        continue;
      }
      if (myProtected.has(act.target)) continue;     // my mon protecting → fizzle
      if (myHp[act.target]! <= 0) continue;
      const tc = t.thr[act.actor]![act.target]!;
      apply(myHp, act.target, oppRoll(tc, r), mySurv, tc.multiHit);
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

  // Refill active slots from the bench after KOs (heuristic replacement).
  const myActive = refill(s.myActive, myHp, t.myN, t.off, oppHp, 'mine');
  const oppActive = refill(s.oppActive, oppHp, t.oppN, t.thr, myHp, 'opp');
  return { myHp, oppHp, myActive, oppActive, myProtectStreak, oppProtectStreak };
}

// Keep up to MAX_ACTIVE live mons on the field. Drop fainted actives; bring in
// the live benched mon with the best total damage vs the current live foes.
function refill(
  active: number[],
  hp: number[],
  n: number,
  dmgRows: Cell[][],     // dmgRows[mon][foe]
  foeHp: number[],
  _side: 'mine' | 'opp',
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
// each active's options). Each active's options are the live foes (single-
// target) plus, for actors in `spreadActors`, the SPREAD sentinel (hit all
// foes), plus, when eligible, the PROTECT sentinel.  Protect is eligible only
// when `protectMoves[actor]` is non-null (the mon has the move) and
// `protectStreak[actor] === 0` (not used last turn — consecutive protect fails).
// Empty when there are no live foes.
function jointActions(
  active: number[],
  foeHp: number[],
  spreadActors?: Set<number>,
  protectMoves?: (string | null)[],
  protectStreak?: number[],
): Array<Map<number, number>> {
  const liveFoes = foeHp.map((h, j) => (h > 0 ? j : -1)).filter(j => j >= 0);
  if (liveFoes.length === 0) return [];
  let combos: Array<Map<number, number>> = [new Map()];
  for (const actor of active) {
    const canProtect = (protectMoves?.[actor] != null) && (protectStreak?.[actor] ?? 0) === 0;
    // SPREAD first so that when hitting all foes ties a single-target line, the
    // maximin keeps the spread option (it makes the chip on the off-target
    // foe visible, and never deals less than the single-target framing).
    // PROTECT last — only chosen when it strictly beats attacking.
    const options = [
      ...(spreadActors?.has(actor) ? [SPREAD] : []),
      ...liveFoes,
      ...(canProtect ? [PROTECT] : []),
    ];
    const next: Array<Map<number, number>> = [];
    for (const combo of combos) {
      for (const opt of options) {
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

function liveCount(hp: number[]): number {
  return hp.reduce((n, h) => n + (h > 0 ? 1 : 0), 0);
}
function sumHp(hp: number[]): number {
  return hp.reduce((s, h) => s + Math.max(0, h), 0);
}

// Terminal value if a side is wiped, else null. `depth` (plies remaining) makes
// faster wins / slower losses preferable.
function terminal(s: State, depth: number): number | null {
  const myLive = liveCount(s.myHp);
  const oppLive = liveCount(s.oppHp);
  if (oppLive === 0 && myLive === 0) return 0;
  if (oppLive === 0) return WIN + depth;
  if (myLive === 0) return -(WIN + depth);
  return null;
}

function leafScore(s: State): number {
  return (liveCount(s.myHp) - liveCount(s.oppHp)) * MATERIAL + (sumHp(s.myHp) - sumHp(s.oppHp));
}

// Maximin value of a state to the given depth. I maximise; opp replies worst-
// case. `alpha` is the best value found so far at this level for the inner
// prune.
function value(t: Tables, s: State, depth: number, alpha: number, pass: Pass): number {
  const term = terminal(s, depth);
  if (term !== null) return term;
  if (depth === 0) return leafScore(s);

  const myJoints = jointActions(s.myActive, s.oppHp, t.mySpreadActors, t.myProtectMove, s.myProtectStreak);
  const oppJoints = jointActions(s.oppActive, s.myHp, t.oppSpreadActors, t.oppProtectMove, s.oppProtectStreak);
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
  }

  const opp: SearchOppMon[] = [];
  for (const idx of match.opponentBrought ?? []) {
    const entry = match.opponentTeam[idx];
    if (!entry) continue;
    const hpPercent = entry.fainted ? 0 : (entry.currentHpPercent ?? 100);
    opp.push({
      entry, hpPercent, active: oppActive.has(idx), megaActive: entry.megaUsed,
      boosts: entry.currentBoosts, status: entry.status, survival: oppSurvival(entry),
    });
  }

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

// Root maximin over a prebuilt table/state — shared by searchToDepth and the
// iterative driver so the (expensive) damage matrices are built only once per
// position, not once per depth.
// Maximin over a prebuilt table for one pass. Returns the best joint (for the
// principal variation) and its score. `plays` are filled by the caller only for
// the displayed pass.
function rootSearch(t: Tables, s0: State, depth: number, pass: Pass): { score: number; joint: Map<number, number> | null } {
  const myJoints = jointActions(s0.myActive, s0.oppHp, t.mySpreadActors, t.myProtectMove, s0.myProtectStreak);
  let bestJoint: Map<number, number> | null = null;
  let bestScore = -Infinity;

  const oppJoints = jointActions(s0.oppActive, s0.myHp, t.oppSpreadActors, t.oppProtectMove, s0.oppProtectStreak);
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
    if (target === SPREAD) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.mySpread[actor]!.move, targetSpecies: 'all foes', spread: true });
    } else if (target === PROTECT) {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.myProtectMove[actor] ?? 'Protect', targetSpecies: t.mySpecies[actor]!, self: true });
    } else {
      plays.push({ mySpecies: t.mySpecies[actor]!, move: t.off[actor]![target]!.move, targetSpecies: t.oppSpecies[target]! });
    }
  }
  return plays;
}

/** A reusable search over one position: builds the (expensive) damage matrices
 *  ONCE, then answers any-depth queries cheaply. The background driver builds
 *  this once per position change and deepens against it. */
export interface PositionSearch {
  toDepth(depth: number): SearchResult;
}
export function createSearch(input: SearchInput): PositionSearch {
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
    s0.oppActive.forEach(j => { if (oppMegaInfo(input.opp[j]!.entry.species)) oppPlans.push(j); });
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
        effect: 'bench not modelled',
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

      // The opponent's bench can still switch in — the search models neither
      // switches nor the unbrought mons, so this is a real, unpriceable factor.
      if (!allOppRevealed && eV !== 'losing') {
        if (benchRisk) {
          risks.push(benchRisk);
        } else {
          const unseen = Math.max(1, 4 - input.opp.length);
          risks.push({ label: `${unseen} more foe${unseen === 1 ? '' : 's'} can switch in`, effect: 'bench not modelled', blocking: true });
        }
        unpriced = true;
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
            if (!worst || koProb > worst.koProb) worst = { oppName, koProb, outspeeds: oppOutspeeds(tbl, oj, mi) };
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
              for (let foe = 0; foe < s0.oppHp.length; foe++) {
                consider({ dmgMin: sp.dmgMin[foe] ?? 0, dmgMid: sp.dmgMid[foe] ?? 0, dmgMax: sp.dmgMax[foe] ?? 0, move: '', priority: 0, multiHit: false, koRolls: [] }, s0.oppHp[foe] ?? 0, expected.table.oppSpecies[foe] ?? 'foe');
              }
            } else if (target !== PROTECT) {
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
          if (target === PROTECT) continue;
          let chance = 0;
          for (const oppMega of oppPlans) {
            const tbl = tables.get(`${myMegaChosen},${oppMega}`);
            if (!tbl) continue;
            for (const oj of s0.oppActive) {
              if ((s0.oppHp[oj] ?? 0) <= 0 || !oppOutspeeds(tbl, oj, actor)) continue;
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
              for (let foe = 0; foe < s0.oppHp.length; foe++) {
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
            } else {
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
