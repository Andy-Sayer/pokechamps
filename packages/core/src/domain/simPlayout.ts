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
import { effectiveness } from './typechart.js';
import { searchIterative, searchBudgeted, type SearchInput, type SearchMyMon, type SearchOppMon, type SearchResult, type SearchBreadth } from './endgameSearch.js';

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

// Greedy single-slot fallback: highest (base-power × type-effectiveness) legal move
// at the first living foe. EFFECTIVENESS-WEIGHTED so it never clicks an immune or
// ineffective move (e.g. Earthquake into a Flying wall) when it fires — which it
// does whenever the search returns empty plays for a side. Choice-locked mons are
// handled by the sim marking their other moves `disabled`, so only the locked move
// is considered. Shared by greedyPolicy and the search policy's per-slot fallback.
function slotMoveChoice(slot: any, livingFoes: number[], foeTypes: string[] = []): string {
  let best = 0, bestScore = -1;
  (slot.moves as any[]).forEach((mv, k) => {
    if (mv.disabled) return;
    const md = getMove(mv.move ?? mv.id) as { basePower?: number; type?: string } | undefined;
    const pow = md?.basePower ?? 0;
    // Damaging moves score power × effectiveness (0 = immune → never picked over a
    // move that does anything); status moves get a tiny score so they win only when
    // nothing damaging connects.
    const eff = (pow > 0 && md?.type && foeTypes.length) ? effectiveness(md.type, foeTypes) : 1;
    const score = pow > 0 ? pow * eff : 0.01;
    if (score > bestScore) { bestScore = score; best = k; }
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
// Types of the foe in a given 1-based active slot (for the effectiveness-weighted
// fallback). Empty array if the slot is empty/fainted or types can't be read.
function foeTypesAt(battle: Battle, i: number, foeSlot1: number): string[] {
  const p = (battle.sides[1 - i] as any).active?.[foeSlot1 - 1];
  if (!p || p.fainted) return [];
  try { return (typeof p.getTypes === 'function' ? p.getTypes() : p.types) ?? []; } catch { return []; }
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
    const ft = lf.length ? foeTypesAt(battle, i, lf[0]!) : [];
    return (req.active as any[]).map(slot => (slot && slot.moves ? slotMoveChoice(slot, lf, ft) : 'pass')).join(', ');
  }
  return 'default';
};

// --- Search-as-policy: play to WIN (maximin), not greedy damage ----------------

const entryOf = (set: PokemonSet): OpponentEntry => ({
  species: set.species, ability: set.ability, item: set.item,
  knownMoves: set.moves, candidates: [set], candidateLikelihoods: [1],
});
const PROTECT_MOVE_IDS = new Set(['protect', 'detect', 'kingsshield', 'banefulbunker', 'spikyshield', 'obstruct', 'silktrap', 'burningbulwark']);
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
  // "Protected last turn" from the sim's lastMove → seeds the search's consecutive-
  // protect ban, so the per-turn policy stops re-offering a Protect that would fail.
  const protectedLast = (sideIdx: number, sp: string): boolean => {
    const p = (battle.sides[sideIdx] as any).active?.find((a: any) => a && toId(a.species?.baseSpecies ?? a.species?.name ?? '') === toId(sp));
    const lm = p?.lastMove;
    const id = typeof lm === 'string' ? lm : lm?.id;
    return id ? PROTECT_MOVE_IDS.has(toId(id)) : false;
  };

  let myMegaSpent = false, oppMegaSpent = false;
  const mine: SearchMyMon[] = [];
  for (const set of mineSets) {
    const r = mineRoster.find(m => toId(m.baseSpecies) === toId(set.species));
    if (!r || r.fainted) continue;
    const mega = toId(r.species) !== toId(set.species);
    if (mega) myMegaSpent = true;
    mine.push({ set, hpPercent: r.hpPct, active: r.active, megaActive: mega || undefined, status: r.status || undefined, boosts: boostOf(mineSlots, set.species), protectedLastTurn: r.active ? protectedLast(i, set.species) : undefined });
  }
  const opp: SearchOppMon[] = [];
  for (const set of oppSets) {
    const r = oppRoster.find(m => toId(m.baseSpecies) === toId(set.species));
    if (!r || r.fainted) continue;
    const mega = toId(r.species) !== toId(set.species);
    if (mega) oppMegaSpent = true;
    opp.push({ entry: entryOf(set), hpPercent: r.hpPct, active: r.active, megaActive: mega || undefined, status: r.status || undefined, boosts: boostOf(oppSlots, set.species), protectedLastTurn: r.active ? protectedLast(1 - i, set.species) : undefined });
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
let warnedEmptyPlays = false;
export function makeSearchPolicy(p1Sets: PokemonSet[], p2Sets: PokemonSet[], depth = 2, budgetMs?: number, breadth?: SearchBreadth, nodeBudget?: number): Policy {
  return (battle, i) => {
    const side = battle.sides[i] as any;
    const req = side.activeRequest;
    if (!req || req.wait) return 'default';
    if (req.forceSwitch) return greedyPolicy(battle, i); // search doesn't pick forced replacements
    if (!req.active) return 'default';
    let result: SearchResult;
    try {
      const input = buildInput(battle, i, i === 0 ? p1Sets : p2Sets, i === 0 ? p2Sets : p1Sets);
      // nodeBudget (env or arg) → DETERMINISTIC reproducible search (cut on nodes,
      // not wall-clock). ~40M ≈ the old b40s "deepest" on typical hardware.
      result = nodeBudget ? searchBudgeted(input, depth, 0, undefined, breadth, nodeBudget)
        : budgetMs ? searchBudgeted(input, depth, budgetMs, undefined, breadth)
        : searchIterative(input, depth, undefined, breadth);
    } catch { return greedyPolicy(battle, i); }
    // GUARD: empty plays on a non-forced turn means the search was built for the
    // wrong side — almost always makeSearchPolicy called with (oppTeam, myTeam)
    // instead of (side0Team, side1Team). That silently defaults the WHOLE side to
    // greedy (effectiveness-blind), which corrupts playouts. Warn once, loudly.
    if (result.plays.length === 0 && (req.active as any[]).some((s: any) => s && s.moves)) {
      if (process.env.DBG_EMPTY) console.error(`[EMPTY-PLAYS side${i}] greedy fallback this turn`);
      else if (!warnedEmptyPlays) { warnedEmptyPlays = true; console.warn(`[makeSearchPolicy] side ${i} got EMPTY plays → entire side falling back to GREEDY. Check policy arg order: makeSearchPolicy(side0Team, side1Team), NOT (myTeam, oppTeam).`); }
    }
    const out = readOutcome(battle);
    const mySlots = i === 0 ? out.p1 : out.p2;
    const foeSlots = i === 0 ? out.p2 : out.p1;
    const lf = livingFoeSlots(battle, i);
    const ft = lf.length ? foeTypesAt(battle, i, lf[0]!) : [];
    return (req.active as any[]).map((slot, s) => {
      if (!slot || !slot.moves) return 'pass';
      const onField = mySlots[s];
      if (!onField) return 'pass';
      const play = result.plays.find(p => toId(p.mySpecies) === toId(onField.baseSpecies));
      if (!play) return slotMoveChoice(slot, lf, ft);
      if (play.switch) {
        const n = (side.pokemon as any[]).findIndex(p => !p.isActive && !p.fainted && toId(p.species.baseSpecies || p.species.name) === toId(play.targetSpecies));
        return n >= 0 ? `switch ${n + 1}` : slotMoveChoice(slot, lf, ft);
      }
      const idx = (slot.moves as any[]).findIndex(m => toId(m.id ?? m.move) === toId(play.move));
      if (idx < 0) return slotMoveChoice(slot, lf, ft);
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

// --- Opponent-piloting prior (idea 5): play the opponent's team to its GAME PLAN ---
// The simulated opponent otherwise runs the same maximin search as us, which may not
// commit to the team's setup the way a real pilot does. This biases the opponent's
// MOVES toward the team's plan — the turn-1-ish setup commits humans reliably make —
// and defers to the search otherwise. (Ability weather like Drizzle/Drought needs no
// override: the sim auto-sets it on switch-in.)

export interface PilotPlan { trickRoom: boolean; tailwind: boolean; weatherMove?: string; weatherId?: string; fakeOut: boolean }

// Weather-MOVE id → the weather id it sets (ability weather is excluded — automatic).
const WEATHER_MOVE_TO_ID: Record<string, string> = { sunnyday: 'sunnyday', raindance: 'raindance', sandstorm: 'sandstorm', snowscape: 'snow', chillyreception: 'snow' };

/** Derive a team's setup plan from its movesets (the moves we'll force when unmet). */
export function derivePilotPlan(sets: PokemonSet[]): PilotPlan {
  const moves = new Set(sets.flatMap(s => (s.moves ?? []).map(m => toId(m))));
  const weatherMove = Object.keys(WEATHER_MOVE_TO_ID).find(m => moves.has(m));
  return { trickRoom: moves.has('trickroom'), tailwind: moves.has('tailwind'), weatherMove, weatherId: weatherMove ? WEATHER_MOVE_TO_ID[weatherMove] : undefined, fakeOut: moves.has('fakeout') };
}

/** Policy that pilots `p2Sets`'s team to `plan`: force the plan move (Trick Room /
 *  Tailwind / weather move / Fake Out) on a slot whose condition is unmet, partner
 *  plays greedy; if no plan move applies this turn, defer entirely to the search. */
export function makePilotPolicy(p1Sets: PokemonSet[], p2Sets: PokemonSet[], depth: number, plan: PilotPlan): Policy {
  const search = makeSearchPolicy(p1Sets, p2Sets, depth);
  return (battle, i) => {
    const side = battle.sides[i] as any;
    const req = side.activeRequest;
    if (!req || req.wait || req.forceSwitch || !req.active) return search(battle, i);
    const bf = (battle as any).field;
    const trUp = !!bf?.pseudoWeather?.trickroom;
    const twUp = !!side.sideConditions?.tailwind;
    const weather = toId(bf?.weather ?? '');
    const lf = livingFoeSlots(battle, i);
    let fired = false;
    const parts = (req.active as any[]).map((slot, s) => {
      if (!slot || !slot.moves) return null;
      const idxOf = (id: string) => (slot.moves as any[]).findIndex(m => !m.disabled && toId(m.id ?? m.move) === id);
      let idx = -1, target = '';
      if (plan.trickRoom && !trUp && (idx = idxOf('trickroom')) >= 0) { /* field move, no target */ }
      else if (plan.weatherMove && plan.weatherId && weather !== plan.weatherId && (idx = idxOf(plan.weatherMove)) >= 0) { /* field */ }
      else if (plan.tailwind && !twUp && (idx = idxOf('tailwind')) >= 0) { /* side */ }
      else if (plan.fakeOut && ((side.active?.[s] as any)?.activeTurns ?? 0) === 0 && (idx = idxOf('fakeout')) >= 0) { target = lf.length ? ` ${lf[0]}` : ''; }
      if (idx >= 0) { fired = true; return `move ${idx + 1}${target}`; }
      return null; // fill with greedy below (only if some other slot fired)
    });
    if (!fired) return search(battle, i); // no plan this turn → full search (stronger play)
    return parts.map((p, s) => p ?? ((req.active as any[])[s]?.moves ? slotMoveChoice((req.active as any[])[s], lf) : 'pass')).join(', ');
  };
}

/** Play `p1` vs `p2` (each a bring of ≤4) to a winner. Leads are the first two
 *  of each bring; full HP, neutral field. Deterministic given `seed`. `p2Policy`
 *  lets the opponent use a different policy (e.g. makePilotPolicy) than us. */
export async function playGame(
  p1: PokemonSet[], p2: PokemonSet[],
  opts?: { seed?: [number, number, number, number]; turnCap?: number; policy?: Policy; p2Policy?: Policy; trace?: boolean },
): Promise<GameResult | { error: string }> {
  if (!(await ensureSimLoaded())) return { error: '@pkmn/sim not installed — npm i @pkmn/sim to simulate' };
  const policy = opts?.policy ?? greedyPolicy;
  const p2Policy = opts?.p2Policy ?? policy;
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
    const c2 = forceDefault ? 'default' : p2Policy(battle, 1);
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
