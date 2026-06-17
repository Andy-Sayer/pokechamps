// Attack + Speed breakpoint computation and candidate-spread generation for the
// spread optimizer. Works in Champions Stat Points (SP, 0-32 per stat) and
// converts to EV (evFromSp) for the calc. The thesis: an attacker only needs
// enough Atk/SpA to hold its KEY KOs and enough Spe to outspeed the relevant
// tier — the rest is "wasted full send" that can become bulk to survive the
// return hit on the targets it only 2HKOs. We GENERATE candidates at those
// breakpoints; the battle sim decides which actually wins.
import { getSpecies, getMove, toId } from './data.js';
import { evFromSp } from './pikalytics.js';
import { damageRange, maxHpFor } from './damage.js';
import type { PokemonSet, Stats } from './types.js';
import { NEUTRAL_FIELD } from './types.js';

export const SP_BUDGET = 66;   // 32/32/2 — the Champions budget (252/252/12 EV)
export const SP_MAX = 32;      // per-stat cap

// --- Speed -----------------------------------------------------------------
const PLUS_SPE = new Set(['Timid', 'Jolly', 'Naive', 'Hasty']);
const MINUS_SPE = new Set(['Brave', 'Relaxed', 'Quiet', 'Sassy']);
function speMult(nature: string): number { return PLUS_SPE.has(nature) ? 1.1 : MINUS_SPE.has(nature) ? 0.9 : 1; }
function speStat(base: number, evSpe: number, mult: number): number {
  return Math.floor((Math.floor(((2 * base + 31 + Math.floor(evSpe / 4)) * 50) / 100) + 5) * mult);
}
/** My mon's Speed stat at a given Speed SP. */
export function monSpeed(set: PokemonSet, speSP: number): number {
  const base = (getSpecies(set.species) as { baseStats?: { spe: number } } | undefined)?.baseStats?.spe ?? 0;
  return speStat(base, evFromSp(speSP), speMult(set.nature));
}
/** An opponent set's effective Speed (honours Choice Scarf). */
export function oppSpeed(set: PokemonSet): number {
  const base = (getSpecies(set.species) as { baseStats?: { spe: number } } | undefined)?.baseStats?.spe ?? 0;
  let s = speStat(base, set.evs.spe ?? 0, speMult(set.nature));
  if (toId(set.item ?? '') === 'choicescarf') s = Math.floor(s * 1.5);
  return s;
}

// --- Which stat does this mon attack with? ---------------------------------
export function attackingStat(set: PokemonSet): 'atk' | 'spa' | null {
  let phys = 0, spec = 0;
  for (const mv of set.moves) {
    const m = getMove(mv) as { category?: string } | undefined;
    if (m?.category === 'Physical') phys++;
    else if (m?.category === 'Special') spec++;
  }
  if (phys === 0 && spec === 0) return null;            // pure support mon
  return phys >= spec ? 'atk' : 'spa';
}

// --- Breakpoints -----------------------------------------------------------
/** Distinct min-SP-to-OHKO values (1..32) for this mon's damaging moves across
 *  the given defenders. Empty when it OHKOs everything at 0 or nothing at 32. */
export function attackBreakpoints(set: PokemonSet, stat: 'atk' | 'spa', defenders: PokemonSet[], rain = false): number[] {
  const field = rain ? { ...NEUTRAL_FIELD, weather: 'Rain' as const } : NEUTRAL_FIELD;
  const bps = new Set<number>();
  for (const mv of set.moves) {
    const m = getMove(mv) as { category?: string } | undefined;
    if (m?.category !== 'Physical' && m?.category !== 'Special') continue;
    for (const def of defenders) {
      const max = maxHpFor(def);
      for (let sp = 0; sp <= SP_MAX; sp++) {
        let ohko = false;
        try {
          const r = damageRange({ attacker: { ...set, evs: { ...set.evs, [stat]: evFromSp(sp) } }, defender: def, move: mv, field, attackerSide: 'mine' });
          ohko = r.min >= max;
        } catch { break; }                              // immune → no breakpoint
        if (ohko) { if (sp > 0) bps.add(sp); break; }
      }
    }
  }
  return [...bps].sort((a, b) => a - b);
}
/** Distinct min-SP values (1..32) to outspeed each opponent in the gauntlet. */
export function speedBreakpoints(set: PokemonSet, opponents: PokemonSet[]): number[] {
  const targets = new Set(opponents.map(oppSpeed));
  const bps = new Set<number>();
  for (const tgt of targets) {
    for (let sp = 0; sp <= SP_MAX; sp++) {
      if (monSpeed(set, sp) > tgt) { if (sp > 0) bps.add(sp); break; }
    }
  }
  return [...bps].sort((a, b) => a - b);
}

/** The Speed SP a mon must KEEP to preserve every outspeed its max-Speed build
 *  achieves vs `opponents` — computed WITHOUT Tailwind, so the floor still holds
 *  when Tailwind is down. This is the guard against the optimizer's Tailwind
 *  blind spot: under a team's own (doubled) Tailwind the search sees base Speed
 *  as near-worthless — everything doubles, order preserved — and would pour it
 *  all into bulk, even zeroing a fast cleaner or a Choice Scarf, whose entire
 *  purpose is Speed. The optimizer may free Speed ABOVE this floor (genuine
 *  overkill → bulk is fine) but never below it.
 *    - Choice Scarf → SP_MAX: a Scarf is a Speed item; cutting its Speed is
 *      incoherent regardless of breakpoints (and `monSpeed` ignores the ×1.5,
 *      so its breakpoints would be wrong anyway).
 *    - otherwise the highest required-outspeed breakpoint, or 0 when the mon
 *      outspeeds nothing relevant even at max (a genuinely slow / Trick Room mon
 *      that legitimately wants its Speed in bulk). */
export function requiredSpeedSP(set: PokemonSet, opponents: PokemonSet[]): number {
  if (toId(set.item ?? '') === 'choicescarf') return SP_MAX;
  const bps = speedBreakpoints(set, opponents);
  return bps.length ? Math.max(...bps) : 0;
}

// --- Candidate spreads -----------------------------------------------------
// Representative levels from a breakpoint list, capped to keep the per-mon
// candidate count tractable for the gauntlet.
//   - attack: never 0 (a 0-investment attacker is never the answer) — the
//     lowest is the cheapest KO breakpoint, plus a mid value, plus the full
//     send. When a mon OHKOs nothing/everything at a breakpoint, fall back to
//     {8, 16, 32} so "shed attack into bulk" is still tested.
//   - speed: includes lower values (a mon may not need the speed), still ≤3.
function levels(bps: number[], allowZero: boolean): number[] {
  const out = new Set<number>([SP_MAX]);
  if (bps.length) { out.add(bps[0]!); out.add(bps[Math.floor(bps.length / 2)]!); }
  else { out.add(16); out.add(allowZero ? 8 : 16); }
  if (allowZero) out.add(0);
  const all = [...out].filter(v => v >= 0 && v <= SP_MAX).sort((a, b) => a - b);
  // cap to 3: lowest, middle, full
  return all.length <= 3 ? all : [all[0]!, all[Math.floor(all.length / 2)]!, all[all.length - 1]!];
}

/** Speed candidate levels for the gauntlet, floored at `floor` (requiredSpeedSP):
 *  never offers a Speed that would cost a real no-Tailwind outspeed, so 0 appears
 *  only when the mon outspeeds nothing relevant. Always keeps the floor itself
 *  (so freed SP can be realised) and the full send. Capped to 3 (floor/mid/full). */
function speedLevels(bps: number[], floor: number): number[] {
  const raw = levels(bps, floor === 0).filter(v => v >= floor);
  const all = [...new Set([floor, ...raw, SP_MAX])].sort((a, b) => a - b);
  return all.length <= 3 ? all : [all[0]!, all[Math.floor(all.length / 2)]!, all[all.length - 1]!];
}

function spread(set: PokemonSet, stat: 'atk' | 'spa' | null, atkSP: number, speSP: number, hpSP: number, defSP: number, spdSP: number): PokemonSet {
  const evs: Stats = { hp: evFromSp(hpSP), atk: 0, def: evFromSp(defSP), spa: 0, spd: evFromSp(spdSP), spe: evFromSp(speSP) };
  if (stat) evs[stat] = evFromSp(atkSP);
  return { ...set, evs };
}

/** Candidate spreads for one mon: cross the attack & speed breakpoint levels,
 *  pour the freed SP (budget − atk − spe) into bulk under three distributions
 *  (pure HP, HP+Def, HP+SpD). The current 32/32/2 build is always included as
 *  the baseline. Bounded to keep the per-mon gauntlet count reasonable. */
export function candidateSpreads(set: PokemonSet, defenders: PokemonSet[], opponents: PokemonSet[], rain: boolean): { label: string; set: PokemonSet }[] {
  const stat = attackingStat(set);
  const atkLevels = stat ? levels(attackBreakpoints(set, stat, defenders, rain), false) : [0];
  // Speed is floored at the no-Tailwind required-outspeed level so the optimizer
  // can't strip a cleaner's (or a Scarf's) Speed just because the team's own
  // Tailwind makes base Speed look worthless inside the shallow gauntlet horizon.
  const speLevels = speedLevels(speedBreakpoints(set, opponents), requiredSpeedSP(set, opponents));
  const out: { label: string; set: PokemonSet }[] = [];
  const seen = new Set<string>();
  const add = (label: string, s: PokemonSet) => {
    const k = `${s.evs.hp}|${s.evs.atk}|${s.evs.def}|${s.evs.spa}|${s.evs.spd}|${s.evs.spe}`;
    if (seen.has(k)) return; seen.add(k);
    out.push({ label, set: s });
  };
  // Baseline: 32/32/2 (max attack, max speed, 2 into HP) — what the team runs now.
  add('baseline 32/32 +2HP', spread(set, stat, SP_MAX, SP_MAX, SP_BUDGET - 2 * SP_MAX, 0, 0));
  for (const atk of atkLevels) {
    for (const spe of speLevels) {
      const bulk = SP_BUDGET - (stat ? atk : 0) - spe;
      if (bulk < 0) continue;
      const cap = (n: number) => Math.min(SP_MAX, Math.max(0, n));
      const hp = cap(bulk);
      const half = cap(Math.floor(bulk / 2)), rest = cap(bulk - Math.floor(bulk / 2));
      const tag = `${stat ? `${atk}atk/` : ''}${spe}spe`;
      add(`${tag} +${hp}HP`, spread(set, stat, atk, spe, hp, 0, 0));
      if (bulk >= 16) {
        add(`${tag} +${half}HP/${rest}Def`, spread(set, stat, atk, spe, half, rest, 0));
        add(`${tag} +${half}HP/${rest}SpD`, spread(set, stat, atk, spe, half, 0, rest));
      }
    }
  }
  return out.slice(0, 20);   // hard cap so one mon's scout doesn't dominate a round
}
