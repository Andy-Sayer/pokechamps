/**
 * replayDamageCheck.ts — J.3: is every observed replay damage event REACHABLE
 * by our damage model?
 *
 * Replays hide EV/IV spreads (even open team sheets blank them), so strict
 * `observed ∈ [min,max]` is rarely possible. Instead each event gets an
 * ENVELOPE check: damage is monotonic in the attacker's offensive stat and the
 * defender's bulk, so two calc calls bound everything any legal spread could
 * do — (min-investment attacker vs max-bulk defender) … (max-investment
 * attacker vs frail defender). The observed drop must land inside. Items and
 * abilities ARE known (OTS/reveals), which removes the big multiplicative
 * unknowns; when they aren't, the envelope widens (Choice item on the max
 * side, Assault Vest on the bulky side for special hits).
 *
 * An `out` verdict means: no spread our engine considers can produce that
 * number — a calc bug, an unmodelled modifier, or a parse misattribution.
 * That's the J north-star signal; `skipped` names the moves/states we can't
 * bound yet (speed-dependent BP, hit-count history, Tera).
 */
import type { PokemonSet, FieldState } from './types.js';
import { ZERO_EVS, MAX_IVS } from './types.js';
import { damageRange } from './damage.js';
import { getMove, toId } from './data.js';

export interface DamageCheck {
  turn: number;
  attacker: string;
  defender: string;
  move: string;
  /** Observed drop as % of the defender's bar. Faint-truncated when the
   *  defender died (true damage ≥ observed). */
  observedPct: number;
  faintTruncated: boolean;
  /** Reachable envelope (% of defender max HP) across legal spreads. */
  minPct: number;
  maxPct: number;
  verdict: 'in' | 'out' | 'skipped';
  note?: string;
}

/** Everything state-dependent the caller (replayDriver) tracked from the
 *  transcript at the moment of the hit. */
export interface DamageCheckInput {
  turn: number;
  move: string;
  critical?: boolean;
  /** True when a spread-target move connected with ≥2 foes (0.75×). */
  spreadHit?: boolean;
  helpingHand?: boolean;
  field: FieldState;
  attacker: CheckMon;
  defender: CheckMon;
  /** Observed HP before/after the hit (% of bar); fainted = truncated. */
  beforePct: number;
  afterPct: number;
  fainted: boolean;
  /** Damage was capped by a survival item (Focus Sash popped on this hit) —
   *  like a faint, the observed drop is only a LOWER bound on true damage. */
  capped?: boolean;
}

export interface CheckMon {
  species: string;
  level: number;
  /** Known held item (undefined = unknown, null/'' = known none/consumed). */
  item?: string | null;
  ability?: string;
  moves: string[];
  boosts?: Partial<Record<'atk' | 'def' | 'spa' | 'spd' | 'spe', number>>;
  status?: string;
  /** Current HP % (Eruption/Water Spout-class BP). */
  curHpPct?: number;
  /** Terastallized as this type — the calc models tera natively (STAB,
   *  defensive typing, Tera Blast) once teraType is passed. */
  teraType?: string;
  /** Glaive Rush volatile: this mon takes DOUBLE damage until it next acts. */
  doubleDamageTaken?: boolean;
  /** Protosynthesis/Quark Drive active on this stat (×1.3, no stage event). */
  boostedStat?: 'atk' | 'def' | 'spa' | 'spd' | 'spe';
  /** FULL known spread (authored transcripts / packed teams with EVs): the
   *  check collapses to STRICT containment on this side — any miss is a calc
   *  or pipeline bug, not a spread unknown. */
  evs?: Record<'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe', number>;
  ivs?: Record<'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe', number>;
  nature?: string;
}

// Moves whose BP/damage depends on state the envelope can't bound: speed
// ratios, hit/faint history, the target's own stats, or arbitrary counters.
const UNBOUNDED_MOVES = new Set([
  'gyroball', 'electroball',          // speed-ratio BP, both spreads unknown
  'foulplay',                         // target's Atk stat
  'ragefist', 'lastrespects',         // history counters
  'beatup',                           // party-dependent
  'counter', 'mirrorcoat', 'metalburst', 'comeuppance', // damage-received
  'reversal', 'flail',                // own-HP BP (could bound later)
  'powertrip', 'punishment',          // boost-count BP (boosts known — could bound later)
  // Fixed/HP-arithmetic damage via callbacks the calc zeroes out (could be
  // checked EXACTLY from tracked HP later — they don't need an envelope).
  'endeavor', 'superfang', 'naturesmadness', 'ruination', 'finalgambit', 'painsplit',
]);

// Rounding tolerance: both before/after percents round to integers (±0.5 each)
// plus 1 HP of max-HP quantisation across the envelope configs.
const TOL = 1.6;

function offensiveStatOf(move: string): 'atk' | 'spa' | 'def' | null {
  const md = getMove(move) as { category?: string; overrideOffensiveStat?: string; overrideOffensivePokemon?: string; damage?: unknown } | undefined;
  if (!md || (md.category !== 'Physical' && md.category !== 'Special')) return null;
  if (md.overrideOffensivePokemon === 'target') return null; // Foul Play class
  if (md.overrideOffensiveStat === 'def') return 'def';
  return md.category === 'Physical' ? 'atk' : 'spa';
}

// Nature picks per stat: [boosting, lowering].
const NATURES: Record<'atk' | 'spa' | 'def' | 'spd', [string, string]> = {
  atk: ['Adamant', 'Bold'],
  spa: ['Modest', 'Adamant'],
  def: ['Impish', 'Hasty'],
  spd: ['Calm', 'Naive'],
};

function buildSet(m: CheckMon, p: {
  nature: string;
  evs: Partial<Record<'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe', number>>;
  zeroIvStat?: 'atk' | 'spa' | 'def';
  item?: string;
}): PokemonSet {
  const ivs = { ...MAX_IVS };
  if (p.zeroIvStat) ivs[p.zeroIvStat] = 0;
  return {
    species: m.species, level: m.level || 50,
    item: p.item,
    ability: m.ability,
    nature: p.nature,
    evs: { ...ZERO_EVS, ...p.evs },
    ivs,
    moves: m.moves.length ? m.moves : [],
  };
}

/** Run the envelope check for one observed hit. */
export function checkDamageEvent(input: DamageCheckInput): DamageCheck {
  const { attacker, defender, move } = input;
  const observedPct = Math.max(0, input.beforePct - input.afterPct);
  const base: Omit<DamageCheck, 'verdict' | 'minPct' | 'maxPct'> = {
    turn: input.turn, attacker: attacker.species, defender: defender.species,
    move, observedPct, faintTruncated: input.fainted || !!input.capped,
  };
  const skip = (note: string): DamageCheck => ({ ...base, minPct: 0, maxPct: 0, verdict: 'skipped', note });

  if (UNBOUNDED_MOVES.has(toId(move))) return skip('state-dependent damage the envelope can\'t bound');
  const offStat = offensiveStatOf(move);
  const md = getMove(move) as { category?: string; damage?: unknown } | undefined;
  if (!offStat && !md?.damage) return skip('no standard offensive stat');

  // Items: known → as-is (empty string = known none). Unknown attacker gets a
  // Choice item on the max side; unknown defender gets AV on the bulky side
  // for special hits.
  const isSpecial = (getMove(move) as { category?: string } | undefined)?.category === 'Special';
  const atkItemKnown = attacker.item !== undefined;
  const defItemKnown = defender.item !== undefined;
  const atkItemMax = atkItemKnown ? (attacker.item || undefined) : (isSpecial ? 'Choice Specs' : 'Choice Band');
  const atkItemMin = atkItemKnown ? (attacker.item || undefined) : undefined;
  const defItemBulky = defItemKnown ? (defender.item || undefined) : (isSpecial ? 'Assault Vest' : undefined);
  const defItemFrail = defItemKnown ? (defender.item || undefined) : undefined;

  const defStat: 'def' | 'spd' = isSpecial ? 'spd' : 'def';
  const common = {
    move, field: input.field,
    helpingHand: input.helpingHand,
    critical: input.critical,
    spreadOverride: !!input.spreadHit,
  } as const;
  const opts = (m: CheckMon) => ({
    boosts: m.boosts as Record<string, number> | undefined,
    status: m.status || undefined,
    curHpPercent: m.curHpPct,
    teraType: m.teraType,
    boostedStat: m.boostedStat,
  });

  // A mon with a FULL known spread uses it for BOTH envelope ends (strict
  // containment on that side — authored Champions transcripts).
  const knownSet = (m: CheckMon): PokemonSet | null =>
    m.evs && m.nature
      ? {
          species: m.species, level: m.level || 50, item: m.item || undefined,
          ability: m.ability, nature: m.nature,
          evs: { ...m.evs }, ivs: { ...MAX_IVS, ...(m.ivs ?? {}) },
          moves: m.moves.length ? m.moves : [],
        }
      : null;

  // Envelope for one offensive-stat hypothesis. Tera Blast on a tera'd
  // attacker uses the HIGHER of Atk/SpA, so the caller merges both.
  const envFor = (stat: 'atk' | 'spa' | 'def'): { minPct: number; maxPct: number } => {
    const atkKnown = knownSet(attacker);
    const defKnown = knownSet(defender);
    const atkMax = atkKnown ?? buildSet(attacker, { nature: NATURES[stat][0], evs: { [stat]: 252 }, item: atkItemMax });
    const atkMin = atkKnown ?? buildSet(attacker, { nature: NATURES[stat][1], evs: {}, zeroIvStat: stat, item: atkItemMin });
    const defBulky = defKnown ?? buildSet(defender, { nature: NATURES[defStat][0], evs: { hp: 252, [defStat]: 252 }, item: defItemBulky });
    const defFrail = defKnown ?? buildSet(defender, { nature: NATURES[defStat][1], evs: {}, item: defItemFrail });
    // Sides: 'mine'/'theirs' only routes screens; the caller builds the field
    // with attackerSide-relative screens, so 'mine' is always the attacker.
    const hi = damageRange({ ...common, attacker: atkMax, defender: defFrail, attackerSide: 'mine', attackerOpts: opts(attacker), defenderOpts: opts(defender) });
    const lo = damageRange({ ...common, attacker: atkMin, defender: defBulky, attackerSide: 'mine', attackerOpts: opts(attacker), defenderOpts: opts(defender) });
    return { minPct: lo.minPercent, maxPct: hi.maxPercent };
  };

  let maxPct: number, minPct: number;
  try {
    if (toId(move) === 'terablast' && attacker.teraType) {
      const a = envFor('atk'), s = envFor('spa');
      minPct = Math.min(a.minPct, s.minPct);
      maxPct = Math.max(a.maxPct, s.maxPct);
    } else {
      ({ minPct, maxPct } = envFor(offStat ?? 'atk'));
    }
  } catch (e) {
    return skip(`calc failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Glaive Rush vulnerability: the defender takes ×2 from every hit until it
  // next acts — a flat multiplier on the whole envelope.
  if (defender.doubleDamageTaken) { minPct *= 2; maxPct *= 2; }

  // Faint- or sash-truncated: the observed drop is a LOWER bound on the true
  // damage — only "the hit must reach this hard" is assessable.
  if (input.fainted || input.capped) {
    const verdict = maxPct + TOL >= observedPct ? 'in' : 'out';
    return { ...base, minPct, maxPct, verdict, note: verdict === 'out' ? `hit needs ≥${observedPct.toFixed(0)}% but max reachable is ${maxPct.toFixed(0)}%` : undefined };
  }
  const verdict = observedPct >= minPct - TOL && observedPct <= maxPct + TOL ? 'in' : 'out';
  return {
    ...base, minPct, maxPct, verdict,
    note: verdict === 'out'
      ? (observedPct > maxPct ? `observed ${observedPct.toFixed(0)}% > max reachable ${maxPct.toFixed(0)}%` : `observed ${observedPct.toFixed(0)}% < min reachable ${minPct.toFixed(0)}%`)
      : undefined,
  };
}
