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
import type { PokemonSet, OpponentEntry, FieldState } from './types.js';
import { predictOffense, predictThreat } from './predictions.js';
import { actualSpeed, effectiveSpeedRange } from './speed.js';
import { getMove } from './data.js';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface SearchMyMon {
  set: PokemonSet;
  /** Remaining HP, 0–100% of max. */
  hpPercent: number;
  /** True if this mon is currently on the field. Up to 2 of mine are active. */
  active: boolean;
}
export interface SearchOppMon {
  entry: OpponentEntry;
  hpPercent: number;
  active: boolean;
}
export interface SearchInput {
  mine: SearchMyMon[];
  opp: SearchOppMon[];
  field: FieldState;
}

export interface SearchPlay {
  mySpecies: string;
  move: string;
  targetSpecies: string;
}
export interface SearchResult {
  /** How many plies deep this result was computed to. */
  depth: number;
  /** Maximin value of the position (higher = better for me). */
  score: number;
  /** Recommended move for each of my live actives this turn (best joint action). */
  plays: SearchPlay[];
  verdict: 'winning' | 'even' | 'losing';
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const WIN = 100_000;          // terminal magnitude; faster wins score higher
const MATERIAL = 1_000;       // per-mon material weight (dominates HP)
const MAX_ACTIVE = 2;

// ---------------------------------------------------------------------------
// Internal flat model (indices into precomputed arrays)
// ---------------------------------------------------------------------------

interface Cell { dmg: number; move: string; priority: number } // dmg as % of target max

interface Tables {
  myN: number;
  oppN: number;
  mySpecies: string[];
  oppSpecies: string[];
  mySpeed: number[];           // effective base speed (pre-field)
  oppSpeed: number[];
  off: Cell[][];               // off[mi][oj] — my mi attacking opp oj
  thr: Cell[][];               // thr[oj][mi] — opp oj attacking my mi
  field: FieldState;
}

interface State {
  myHp: number[];
  oppHp: number[];
  myActive: number[];          // indices currently on the field (≤2)
  oppActive: number[];
}

function cellFromOffense(attacker: PokemonSet, defender: OpponentEntry, field: FieldState): Cell {
  const c = predictOffense({ attacker, opponent: defender, field });
  if (!c) return { dmg: 0, move: '', priority: 0 };
  const lo = c.likelyMinPercent ?? c.minPercent;
  const hi = c.likelyMaxPercent ?? c.maxPercent;
  return { dmg: (lo + hi) / 2, move: c.move, priority: movePriority(c.move) };
}
function cellFromThreat(attacker: OpponentEntry, defender: PokemonSet, field: FieldState): Cell {
  const c = predictThreat({ opponent: attacker, defender, field });
  if (!c) return { dmg: 0, move: '', priority: 0 };
  const lo = c.likelyMinPercent ?? c.minPercent;
  const hi = c.likelyMaxPercent ?? c.maxPercent;
  return { dmg: (lo + hi) / 2, move: c.move, priority: movePriority(c.move) };
}

function movePriority(move: string): number {
  if (!move) return 0;
  const m = getMove(move) as { priority?: number } | undefined;
  return m?.priority ?? 0;
}

function oppSpeedOf(entry: OpponentEntry): number {
  const r = effectiveSpeedRange(entry);
  if (r) return (r.min + r.max) / 2;
  // Fallback: a candidate set's actual speed, else a neutral guess.
  const c = entry.candidates?.[0];
  return c ? actualSpeed(c) : 100;
}

function buildTables(input: SearchInput): Tables {
  const mine = input.mine;
  const opp = input.opp;
  const off: Cell[][] = mine.map(m => opp.map(o => cellFromOffense(m.set, o.entry, input.field)));
  const thr: Cell[][] = opp.map(o => mine.map(m => cellFromThreat(o.entry, m.set, input.field)));
  return {
    myN: mine.length,
    oppN: opp.length,
    mySpecies: mine.map(m => m.set.species),
    oppSpecies: opp.map(o => o.entry.species),
    mySpeed: mine.map(m => actualSpeed(m.set)),
    oppSpeed: opp.map(o => oppSpeedOf(o.entry)),
    off, thr,
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
  };
}

// ---------------------------------------------------------------------------
// Turn resolution
// ---------------------------------------------------------------------------

// Effective speed with field modifiers. Tailwind doubles; Trick Room is handled
// at sort time (we invert the comparison), not here.
function effSpeed(base: number, tailwind: boolean): number {
  return base * (tailwind ? 2 : 1);
}

interface Acting { side: 'mine' | 'opp'; actor: number; target: number; priority: number; speed: number }

// Resolve one turn given each side's target assignment (active index → enemy
// index). Returns a NEW state; inputs are not mutated.
function resolveTurn(
  t: Tables,
  s: State,
  myTargets: Map<number, number>,
  oppTargets: Map<number, number>,
): State {
  const myHp = s.myHp.slice();
  const oppHp = s.oppHp.slice();
  const tr = !!t.field.trickRoom;

  const actings: Acting[] = [];
  for (const [actor, target] of myTargets) {
    const cell = t.off[actor]![target]!;
    actings.push({ side: 'mine', actor, target, priority: cell.priority, speed: effSpeed(t.mySpeed[actor]!, !!t.field.myTailwind) });
  }
  for (const [actor, target] of oppTargets) {
    const cell = t.thr[actor]![target]!;
    actings.push({ side: 'opp', actor, target, priority: cell.priority, speed: effSpeed(t.oppSpeed[actor]!, !!t.field.theirTailwind) });
  }

  // Priority first (higher acts first), then speed (Trick Room inverts speed).
  actings.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return tr ? a.speed - b.speed : b.speed - a.speed;
  });

  for (const act of actings) {
    if (act.side === 'mine') {
      if (myHp[act.actor]! <= 0) continue;          // KO'd before acting
      if (oppHp[act.target]! <= 0) continue;        // target already down → fizzle
      oppHp[act.target] = Math.max(0, oppHp[act.target]! - t.off[act.actor]![act.target]!.dmg);
    } else {
      if (oppHp[act.actor]! <= 0) continue;
      if (myHp[act.target]! <= 0) continue;
      myHp[act.target] = Math.max(0, myHp[act.target]! - t.thr[act.actor]![act.target]!.dmg);
    }
  }

  // Refill active slots from the bench after KOs (heuristic replacement).
  const myActive = refill(s.myActive, myHp, t.myN, t.off, oppHp, 'mine');
  const oppActive = refill(s.oppActive, oppHp, t.oppN, t.thr, myHp, 'opp');
  return { myHp, oppHp, myActive, oppActive };
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
      const total = liveFoes.reduce((acc, j) => acc + (dmgRows[i]?.[j]?.dmg ?? 0), 0);
      if (total > bestDmg) { bestDmg = total; best = i; }
    }
    if (best < 0) break;       // no bench left
    live.push(best);
    onField.add(best);
  }
  return live;
}

// All joint target assignments for a side's live actives (cartesian product of
// each active's live-foe targets). Empty when there are no live foes.
function jointActions(active: number[], foeHp: number[]): Array<Map<number, number>> {
  const liveFoes = foeHp.map((h, j) => (h > 0 ? j : -1)).filter(j => j >= 0);
  if (liveFoes.length === 0) return [];
  let combos: Array<Map<number, number>> = [new Map()];
  for (const actor of active) {
    const next: Array<Map<number, number>> = [];
    for (const combo of combos) {
      for (const foe of liveFoes) {
        const m = new Map(combo);
        m.set(actor, foe);
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
function value(t: Tables, s: State, depth: number, alpha: number): number {
  const term = terminal(s, depth);
  if (term !== null) return term;
  if (depth === 0) return leafScore(s);

  const myJoints = jointActions(s.myActive, s.oppHp);
  const oppJoints = jointActions(s.oppActive, s.myHp);
  if (myJoints.length === 0) return leafScore(s);

  let best = -Infinity;
  for (const my of myJoints) {
    let worst = Infinity;
    const replies = oppJoints.length ? oppJoints : [new Map<number, number>()];
    for (const opp of replies) {
      const child = resolveTurn(t, s, my, opp);
      const v = value(t, child, depth - 1, best);
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

/** Search the position to a fixed depth (plies) and return the best joint play. */
export function searchToDepth(input: SearchInput, depth: number): SearchResult {
  const t = buildTables(input);
  const s0 = initialState(input);

  const myJoints = jointActions(s0.myActive, s0.oppHp);
  let bestJoint: Map<number, number> | null = null;
  let bestScore = -Infinity;

  const oppJoints = jointActions(s0.oppActive, s0.myHp);
  for (const my of myJoints) {
    let worst = Infinity;
    const replies = oppJoints.length ? oppJoints : [new Map<number, number>()];
    for (const opp of replies) {
      const child = resolveTurn(t, s0, my, opp);
      const v = value(t, child, depth - 1, bestScore);
      if (v < worst) worst = v;
      if (worst <= bestScore) break;
    }
    if (worst > bestScore) { bestScore = worst; bestJoint = my; }
  }

  const plays: SearchPlay[] = [];
  if (bestJoint) {
    for (const [actor, target] of bestJoint) {
      plays.push({
        mySpecies: t.mySpecies[actor]!,
        move: t.off[actor]![target]!.move,
        targetSpecies: t.oppSpecies[target]!,
      });
    }
  }
  const verdict: SearchResult['verdict'] =
    bestScore >= WIN ? 'winning' : bestScore <= -WIN ? 'losing'
    : bestScore > MATERIAL / 2 ? 'winning' : bestScore < -MATERIAL / 2 ? 'losing' : 'even';

  return { depth, score: bestScore, plays, verdict };
}

/**
 * Iterative deepening: search depth 1, 2, … up to `maxDepth`, invoking
 * `onDepth` after each completes (so a background driver can publish improving
 * results). Returns the deepest result. Pure aside from the optional callback.
 */
export function searchIterative(
  input: SearchInput,
  maxDepth: number,
  onDepth?: (r: SearchResult) => void,
): SearchResult {
  let last: SearchResult = { depth: 0, score: 0, plays: [], verdict: 'even' };
  for (let d = 1; d <= maxDepth; d++) {
    last = searchToDepth(input, d);
    onDepth?.(last);
  }
  return last;
}
