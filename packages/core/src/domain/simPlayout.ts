/**
 * simPlayout.ts — play a FULL Champions game to a winner through the real
 * Showdown engine (`@pkmn/sim`), with a pluggable move policy. This is the
 * "simulate the battles properly" capability: instead of scoring an opening
 * position statically (teamSim.evaluateMatchup) or resolving a single turn
 * (simOracle.runExactOracle), we build a bring-vs-bring opening once and step it
 * turn-by-turn to completion — the sim resolves every mechanic and handles
 * faints/forced-switches natively, so the outcome is ground truth.
 *
 * Native-format truth, no proxy: both teams are real Champions sets we author,
 * so spreads/items/abilities are KNOWN (the clean label supply the scraped gen9
 * replay corpus could never give). Used to evaluate brings by ACTUAL win-rate
 * and to generate Champions-native training data.
 *
 * Dependency boundary: lazy `@pkmn/sim` via simBridge.ensureSimLoaded() — returns
 * an `{error}` when the optional dep is absent, never crashes the runtime path.
 *
 * v1 ships a GREEDY policy (highest-base-power move at a living foe). The proper
 * upgrade — our own `endgameSearch` as the policy — slots into `opts.policy`
 * without touching the loop. See training-data-plan.md.
 */
import type { Battle } from '@pkmn/sim';
import { ensureSimLoaded, buildBattle, readRoster, readOutcome, type SimMon } from './simBridge.js';
import type { PokemonSet, OpponentEntry, FieldState } from './types.js';
import { NEUTRAL_FIELD } from './types.js';
import { getMove, toId } from './data.js';
import { searchIterative, searchBudgeted, type SearchInput, type SearchMyMon, type SearchOppMon, type SearchResult } from './endgameSearch.js';

const toSimMon = (s: PokemonSet): SimMon => ({
  species: s.species, ability: s.ability, item: s.item, moves: s.moves,
  nature: s.nature, evs: s.evs as SimMon['evs'], ivs: s.ivs as SimMon['ivs'], level: s.level ?? 50,
});

/** A move policy: given the live battle + a side index, return that side's
 *  Showdown choice string for the current request ('default' is always legal). */
export type Policy = (battle: Battle, sideIdx: number) => string;

export interface GameResult {
  winner: 'p1' | 'p2' | 'tie';
  turns: number;
  /** 'kos' = a side was wiped out (clean last-standing win); 'timeout' = the turn
   *  cap was hit and the winner came from the official VGC tiebreak. A timeout
   *  win is a weaker signal than a KO win (useful when weighting training rows). */
  resolution: 'kos' | 'timeout';
  /** The sim's full `|`-protocol event log, when `opts.trace` is set — so a game
   *  can be replayed/eyeballed to confirm the policy plays sensibly. */
  log?: string[];
}

/** Official Play! Pokémon end-of-time tiebreak: (1) most un-fainted Pokémon, then
 *  (2) greatest total remaining HP%, else a genuine draw. This is ALSO the aim
 *  the policy plays toward when it can't force a clean wipe — exactly what the
 *  endgameSearch value function maximizes (material first, then HP). */
function officialTiebreak(roster: { p1: RM[]; p2: RM[] }): 'p1' | 'p2' | 'tie' {
  const aliveCount = (s: RM[]) => s.filter(m => !m.fainted).length;
  const totalHp = (s: RM[]) => s.reduce((t, m) => t + (m.fainted ? 0 : m.hpPct), 0);
  const c1 = aliveCount(roster.p1), c2 = aliveCount(roster.p2);
  if (c1 !== c2) return c1 > c2 ? 'p1' : 'p2';            // (1) most Pokémon remaining
  const h1 = totalHp(roster.p1), h2 = totalHp(roster.p2);
  if (Math.abs(h1 - h2) > 1e-6) return h1 > h2 ? 'p1' : 'p2'; // (2) greater total remaining HP%
  return 'tie';                                          // (3) genuine draw
}
type RM = { fainted: boolean; hpPct: number };

// Greedy single-slot fallback: highest-base-power legal move at the first living
// foe. Shared by greedyPolicy and the search policy's per-slot fallback.
function slotMoveChoice(slot: any, livingFoes: number[]): string {
  let best = 0, bestPow = -1;
  (slot.moves as any[]).forEach((mv, k) => {
    if (mv.disabled) return;
    const pow = (getMove(mv.move ?? mv.id) as { basePower?: number } | undefined)?.basePower ?? 0;
    if (pow > bestPow) { bestPow = pow; best = k; }
  });
  const mv = slot.moves[best];
  const tgt = (getMove(mv?.move ?? mv?.id) as { target?: string } | undefined)?.target ?? 'normal';
  const needsTarget = tgt === 'normal' || tgt === 'any' || tgt === 'adjacentFoe';
  return needsTarget && livingFoes.length ? `move ${best + 1} ${livingFoes[0]}` : `move ${best + 1}`;
}

function livingFoeSlots(battle: Battle, i: number): number[] {
  const foe = battle.sides[1 - i] as any;
  return foe.active.map((p: any, j: number) => (p && !p.fainted ? j + 1 : 0)).filter((n: number) => n > 0);
}

/** Highest-base-power move at the first living foe; first healthy bench mon for a
 *  forced switch. Always legal (reads the sim's own per-slot legal-move list). */
export const greedyPolicy: Policy = (battle, i) => {
  const side = battle.sides[i] as any;
  const req = side.activeRequest;
  if (!req || req.wait) return 'default';
  if (req.forceSwitch) {
    const bench: number[] = side.pokemon
      .map((p: any, idx: number) => (!p.isActive && !p.fainted ? idx : -1))
      .filter((n: number) => n >= 0);
    let b = 0;
    return (req.forceSwitch as boolean[]).map(need => (need ? `switch ${(bench[b++] ?? 0) + 1}` : 'pass')).join(', ');
  }
  if (req.active) {
    const lf = livingFoeSlots(battle, i);
    return (req.active as any[]).map(slot => (slot && slot.moves ? slotMoveChoice(slot, lf) : 'pass')).join(', ');
  }
  return 'default';
};

// --- Search-as-policy: play to WIN (maximin), not greedy damage ----------------

const entryOf = (set: PokemonSet): OpponentEntry => ({
  species: set.species, ability: set.ability, item: set.item,
  knownMoves: set.moves, candidates: [set], candidateLikelihoods: [1],
});
const WEATHER_MAP: Record<string, FieldState['weather']> = {
  sunnyday: 'Sun', desolateland: 'Harsh Sunshine', raindance: 'Rain', primordialsea: 'Heavy Rain',
  sandstorm: 'Sand', snow: 'Snow', snowscape: 'Snow', hail: 'Hail',
};
const TERRAIN_MAP: Record<string, FieldState['terrain']> = {
  electricterrain: 'Electric', grassyterrain: 'Grassy', mistyterrain: 'Misty', psychicterrain: 'Psychic',
};

function readField(battle: Battle, i: number): FieldState {
  const out = readOutcome(battle);
  const bf = (battle as any).field;
  const sc = (s: any, id: string) => !!s.sideConditions?.[id];
  const me = battle.sides[i] as any, foe = battle.sides[1 - i] as any;
  return {
    ...NEUTRAL_FIELD,
    weather: WEATHER_MAP[toId(out.weather)] ?? null,
    terrain: TERRAIN_MAP[toId(out.terrain)] ?? null,
    trickRoom: !!bf?.pseudoWeather?.trickroom,
    myTailwind: sc(me, 'tailwind'), theirTailwind: sc(foe, 'tailwind'),
    myReflect: sc(me, 'reflect'), theirReflect: sc(foe, 'reflect'),
    myLightScreen: sc(me, 'lightscreen'), theirLightScreen: sc(foe, 'lightscreen'),
  };
}

// Reconstruct a full-knowledge SearchInput from the live sim (self-play: both
// teams are authored). Alive mons only; megaActive when the on-field forme was
// renamed; boosts/status/field read back so the policy plays informed.
function buildInput(battle: Battle, i: number, mineSets: PokemonSet[], oppSets: PokemonSet[]): SearchInput {
  const out = readOutcome(battle);
  const roster = readRoster(battle);
  const mineRoster = i === 0 ? roster.p1 : roster.p2;
  const oppRoster = i === 0 ? roster.p2 : roster.p1;
  const mineSlots = i === 0 ? out.p1 : out.p2;
  const oppSlots = i === 0 ? out.p2 : out.p1;
  const boostOf = (slots: typeof mineSlots, sp: string) => slots.find(s => s && toId(s.baseSpecies) === toId(sp))?.boosts;

  let myMegaSpent = false, oppMegaSpent = false;
  const mine: SearchMyMon[] = [];
  for (const set of mineSets) {
    const r = mineRoster.find(m => toId(m.baseSpecies) === toId(set.species));
    if (!r || r.fainted) continue;
    const mega = toId(r.species) !== toId(set.species);
    if (mega) myMegaSpent = true;
    mine.push({ set, hpPercent: r.hpPct, active: r.active, megaActive: mega || undefined, status: r.status || undefined, boosts: boostOf(mineSlots, set.species) });
  }
  const opp: SearchOppMon[] = [];
  for (const set of oppSets) {
    const r = oppRoster.find(m => toId(m.baseSpecies) === toId(set.species));
    if (!r || r.fainted) continue;
    const mega = toId(r.species) !== toId(set.species);
    if (mega) oppMegaSpent = true;
    opp.push({ entry: entryOf(set), hpPercent: r.hpPct, active: r.active, megaActive: mega || undefined, status: r.status || undefined, boosts: boostOf(oppSlots, set.species) });
  }
  return { mine, opp, field: readField(battle, i), myMegaSpent, oppMegaSpent, allOppRevealed: true };
}

/** endgameSearch as the move policy — plays to WIN (maximin over win/loss), not
 *  greedy damage. Each turn it rebuilds a full-knowledge SearchInput from the live
 *  sim, searches to `depth`, and maps the recommended joint play (incl. mega) to a
 *  sim choice. Any slot the search can't map (forced switch, move illegal here)
 *  falls back to the greedy single-slot choice, so a game can never hang.
 *
 *  Throughput: each call runs the heavyweight endgame search, so a full game is
 *  ~10-15s at `depth` 2. Pass `budgetMs` to cap each decision (searchBudgeted —
 *  anytime deepening to `depth` within the budget), trading some play strength
 *  for many more games/sec; parallelise across matchups with MatchupPool. */
export function makeSearchPolicy(p1Sets: PokemonSet[], p2Sets: PokemonSet[], depth = 2, budgetMs?: number): Policy {
  return (battle, i) => {
    const side = battle.sides[i] as any;
    const req = side.activeRequest;
    if (!req || req.wait) return 'default';
    if (req.forceSwitch) return greedyPolicy(battle, i); // search doesn't pick forced replacements
    if (!req.active) return 'default';
    let result: SearchResult;
    try {
      const input = buildInput(battle, i, i === 0 ? p1Sets : p2Sets, i === 0 ? p2Sets : p1Sets);
      result = budgetMs ? searchBudgeted(input, depth, budgetMs) : searchIterative(input, depth);
    } catch { return greedyPolicy(battle, i); }
    const out = readOutcome(battle);
    const mySlots = i === 0 ? out.p1 : out.p2;
    const foeSlots = i === 0 ? out.p2 : out.p1;
    const lf = livingFoeSlots(battle, i);
    return (req.active as any[]).map((slot, s) => {
      if (!slot || !slot.moves) return 'pass';
      const onField = mySlots[s];
      if (!onField) return 'pass';
      const play = result.plays.find(p => toId(p.mySpecies) === toId(onField.baseSpecies));
      if (!play) return slotMoveChoice(slot, lf);
      if (play.switch) {
        const n = (side.pokemon as any[]).findIndex(p => !p.isActive && !p.fainted && toId(p.species.baseSpecies || p.species.name) === toId(play.targetSpecies));
        return n >= 0 ? `switch ${n + 1}` : slotMoveChoice(slot, lf);
      }
      const idx = (slot.moves as any[]).findIndex(m => toId(m.id ?? m.move) === toId(play.move));
      if (idx < 0) return slotMoveChoice(slot, lf);
      let c = `move ${idx + 1}`;
      const tgt = (getMove(play.move) as { target?: string } | undefined)?.target;
      const needsTarget = tgt === 'normal' || tgt === 'any' || tgt === 'adjacentFoe';
      if (!play.self && !play.spread && needsTarget) {
        const t = foeSlots.findIndex(fs => fs && !fs.fainted && toId(fs.baseSpecies) === toId(play.targetSpecies));
        if (t >= 0) c += ` ${t + 1}`;
        else if (lf.length) c += ` ${lf[0]}`;
      } else if (tgt === 'adjacentAlly') {
        const a = mySlots.findIndex((fs, si) => si !== s && fs && toId(fs.baseSpecies) === toId(play.targetSpecies));
        if (a >= 0) c += ` -${a + 1}`;
      }
      if (result.megaMon && toId(result.megaMon) === toId(onField.baseSpecies)) c += ' mega';
      return c;
    }).join(', ');
  };
}

/** Play `p1` vs `p2` (each a bring of ≤4) to a winner. Leads are the first two
 *  of each bring; full HP, neutral field. Deterministic given `seed`. */
export async function playGame(
  p1: PokemonSet[], p2: PokemonSet[],
  opts?: { seed?: [number, number, number, number]; turnCap?: number; policy?: Policy; trace?: boolean },
): Promise<GameResult | { error: string }> {
  if (!(await ensureSimLoaded())) return { error: '@pkmn/sim not installed — npm i @pkmn/sim to simulate' };
  const policy = opts?.policy ?? greedyPolicy;
  const turnCap = opts?.turnCap ?? 300;
  const lead = (n: number) => (n >= 2 ? [0, 1] : [0]);
  const battle = buildBattle({
    p1team: p1.map(toSimMon), p2team: p2.map(toSimMon),
    p1active: lead(p1.length), p2active: lead(p2.length),
    seed: opts?.seed,
  });

  // Step to completion. A stall guard forces 'default' if a policy choice fails
  // to advance the request (illegal/edge choice), so a game can never hang.
  let guard = 0, stallKey = '', stalls = 0;
  while (!battle.ended && battle.turn <= turnCap && guard++ < turnCap * 6) {
    const key = `${battle.turn}|${(battle as { requestState?: string }).requestState ?? ''}`;
    const forceDefault = key === stallKey && stalls >= 2;
    const c1 = forceDefault ? 'default' : policy(battle, 0);
    const c2 = forceDefault ? 'default' : policy(battle, 1);
    try { battle.makeChoices(c1, c2); } catch { try { battle.makeChoices('default', 'default'); } catch { break; } }
    if (key === stallKey) stalls++; else { stallKey = key; stalls = 0; }
  }
  // Win = LAST SIDE STANDING. When the sim ends naturally, `battle.winner` is
  // exactly that (Showdown ends the game when a side has no mon left) → a clean
  // 'kos' result. If we hit the turn cap first ("time ran out"), resolve by the
  // official VGC tiebreak (most mons, then total HP%) — a 'timeout' result.
  const log = opts?.trace ? ((battle as { log?: string[] }).log ?? []).slice() : undefined;
  const w = (battle as { winner?: string }).winner;
  const out = (winner: GameResult['winner'], resolution: GameResult['resolution']): GameResult =>
    log ? { winner, turns: battle.turn, resolution, log } : { winner, turns: battle.turn, resolution };
  if (battle.ended && (w === 'p1' || w === 'p2')) return out(w, 'kos');
  const roster = readRoster(battle);
  if (battle.ended) return out(officialTiebreak(roster), 'kos');
  return out(officialTiebreak(roster), 'timeout');
}
