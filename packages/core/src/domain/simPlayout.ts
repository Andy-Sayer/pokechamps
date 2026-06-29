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
import { ensureSimLoaded, buildBattle, readRoster, type SimMon } from './simBridge.js';
import type { PokemonSet } from './types.js';
import { getMove } from './data.js';

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
    const foe = battle.sides[1 - i] as any;
    const livingFoes: number[] = foe.active
      .map((p: any, j: number) => (p && !p.fainted ? j + 1 : 0))
      .filter((n: number) => n > 0);
    return (req.active as any[]).map((slot, _s) => {
      if (!slot || !slot.moves) return 'pass';
      let best = 0, bestPow = -1;
      (slot.moves as any[]).forEach((mv, k) => {
        if (mv.disabled) return;
        const pow = (getMove(mv.move ?? mv.id) as { basePower?: number } | undefined)?.basePower ?? 0;
        if (pow > bestPow) { bestPow = pow; best = k; }
      });
      const mv = slot.moves[best];
      const tgt = (getMove(mv?.move ?? mv?.id) as { target?: string } | undefined)?.target ?? 'normal';
      const needsTarget = tgt === 'normal' || tgt === 'any' || tgt === 'adjacentFoe';
      let c = `move ${best + 1}`;
      if (needsTarget && livingFoes.length) c += ` ${livingFoes[0]}`;
      return c;
    }).join(', ');
  }
  return 'default';
};

/** Play `p1` vs `p2` (each a bring of ≤4) to a winner. Leads are the first two
 *  of each bring; full HP, neutral field. Deterministic given `seed`. */
export async function playGame(
  p1: PokemonSet[], p2: PokemonSet[],
  opts?: { seed?: [number, number, number, number]; turnCap?: number; policy?: Policy },
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
  const w = (battle as { winner?: string }).winner;
  if (battle.ended && (w === 'p1' || w === 'p2')) return { winner: w, turns: battle.turn, resolution: 'kos' };
  const roster = readRoster(battle);
  if (battle.ended) return { winner: officialTiebreak(roster), turns: battle.turn, resolution: 'kos' };
  return { winner: officialTiebreak(roster), turns: battle.turn, resolution: 'timeout' };
}
