import { Generations, calculate, Pokemon as CalcPokemon, Move as CalcMove, Field, Side } from '@smogon/calc';
import type { PokemonSet, FieldState, DamageObservation } from './types.js';
import { activeGimmick } from './gimmicks/index.js';
import { getMove } from './data.js';
// Side-effect import: registers the format loader with the gimmick registry
// so activeGimmick() resolves the configured gimmick (e.g. mega) rather than
// silently falling back to noneGimmick. Without this, damage calcs that go
// through damage.ts in isolation (tests, smoketest, etc.) would skip the
// gimmick's species/opts overrides.
import './data.js';

const GEN = Generations.get(9);

// Some species names in our data don't index in @smogon/calc's species table
// because the calc keys on forme names only (e.g. it has "Aegislash-Shield"
// but not bare "Aegislash"). Map our canonical name to the calc-compatible one.
// Run `npm run validate-format` to surface new asymmetries when dex data
// changes.
export const CALC_SPECIES_OVERRIDES: Record<string, string> = {
  Aegislash: 'Aegislash-Shield',
};
export function calcSpeciesName(name: string): string {
  return CALC_SPECIES_OVERRIDES[name] ?? name;
}

export interface DamageRange {
  min: number;
  max: number;
  rolls: number[];        // raw HP rolls (typically 16 evenly distributed)
  percentRolls: number[]; // same rolls expressed as % of defender's max HP
  minPercent: number;
  maxPercent: number;
  koChance: string;
  desc: string;
}

function toCalcPokemon(set: PokemonSet, opts: {
  curHpPercent?: number;
  status?: string;
  boosts?: Partial<Record<string, number>>;
  gimmickActive?: boolean;
  /** Terastallized AS this type. Champions is Mega-format, so live play never
   *  sets this — the replay validation harness does (real gen9 replays tera,
   *  and the calc models it natively once teraType is present). */
  teraType?: string;
  /** Protosynthesis / Quark Drive active on this stat (×1.3) — again a
   *  replay-harness input; the calc applies it via its boostedStat option. */
  boostedStat?: string;
} = {}): CalcPokemon {
  const calcOpts: Record<string, unknown> = {
    level: set.level,
    item: set.item,
    ability: set.ability,
    nature: set.nature,
    evs: set.evs as any,
    ivs: set.ivs as any,
    moves: set.moves as any,
    boosts: (opts.boosts as any) ?? undefined,
    status: (opts.status as any) ?? '',
    ...(opts.teraType ? { teraType: opts.teraType } : {}),
    ...(opts.boostedStat ? { boostedStat: opts.boostedStat } : {}),
  };
  // Let the active gimmick override the species name (e.g. Mega swaps the
  // base forme for the mega forme when a stone is held — @smogon/calc does
  // not auto-resolve this) and mutate calcOpts (e.g. set teraType + isTera,
  // isDynamaxed).
  const gimmick = activeGimmick();
  const resolvedSpecies = gimmick.resolveSpecies?.({ set, active: !!opts.gimmickActive }) ?? set.species;
  gimmick.enrichCalcPokemon?.({ set, active: !!opts.gimmickActive, opts: calcOpts });
  const p = new CalcPokemon(GEN, calcSpeciesName(resolvedSpecies), calcOpts as any);
  // Current HP is given as a PERCENT; scale it by the species' REAL max HP
  // after construction (HP-fraction BP moves: Eruption/Water Spout). Passing a
  // /100 value as raw curHP undercounted the fraction by ~maxHP/100.
  if (opts.curHpPercent != null) {
    (p as unknown as { originalCurHP: number }).originalCurHP =
      Math.max(1, Math.min(p.maxHP(), Math.round((opts.curHpPercent / 100) * p.maxHP())));
  }
  return p;
}

function toCalcField(state: FieldState, attackerSide: 'mine' | 'theirs', helpingHand = false): Field {
  const myTailwind = state.myTailwind;
  const theirTailwind = state.theirTailwind;
  const mySide = new Side({ isTailwind: myTailwind, isReflect: state.myReflect, isLightScreen: state.myLightScreen, isHelpingHand: attackerSide === 'mine' && helpingHand });
  const theirSide = new Side({ isTailwind: theirTailwind, isReflect: state.theirReflect, isLightScreen: state.theirLightScreen, isHelpingHand: attackerSide === 'theirs' && helpingHand });
  const weather = state.weather as any;
  const terrain = state.terrain as any;
  return new Field({
    gameType: 'Doubles',
    weather: weather ?? undefined,
    terrain: terrain ?? undefined,
    isGravity: false,
    isMagicRoom: false,
    isWonderRoom: false,
    attackerSide: attackerSide === 'mine' ? mySide : theirSide,
    defenderSide: attackerSide === 'mine' ? theirSide : mySide,
  });
}

export function damageRange(args: {
  attacker: PokemonSet;
  defender: PokemonSet;
  move: string;
  field: FieldState;
  attackerSide: 'mine' | 'theirs';
  attackerOpts?: Parameters<typeof toCalcPokemon>[1];
  defenderOpts?: Parameters<typeof toCalcPokemon>[1];
  helpingHand?: boolean;
  critical?: boolean;
  /** Override the automatic spread-modifier detection: a spread-target move
   *  that actually connected with only ONE foe takes no 0.75× reduction
   *  (replay ground truth knows the hit count; live calcs auto-detect). */
  spreadOverride?: boolean;
}): DamageRange {
  const atk = toCalcPokemon(args.attacker, args.attackerOpts);
  const def = toCalcPokemon(args.defender, args.defenderOpts);
  // Mega Sol (custom Champions ability, Meganium-Mega): the holder's moves are used
  // as if Sunny Day is active NO MATTER the actual weather — so its Fire moves get
  // ×1.5 and Weather Ball is Fire-typed even in the rain, and its Water moves are
  // weakened even in the rain. @smogon/calc has no logic for this ability name, so
  // force Sun in the holder's OFFENSIVE calc regardless of real weather. `atk.ability`
  // is the RESOLVED (mega) ability — the gimmick swapped in the forme's ability above.
  // Offense-only: when a Mega Sol mon DEFENDS, `atk` is the opponent, so the incoming
  // hit still uses the real weather. KNOWN LIMITATION: forcing the calc field to Sun
  // also drops the DEFENDER's real-weather SpD/Def boost (Sand→Rock, Snow→Ice) for that
  // single calc — a rare edge (a Mega Sol mon attacking a Rock/Ice type while Sand/Snow
  // is up). The dominant, intended effect (Fire ×1.5, Weather Ball → Fire) is correct.
  const effField: FieldState =
    (atk as unknown as { ability?: string }).ability === 'Mega Sol'
      ? { ...args.field, weather: 'Sun' }
      : args.field;
  // The attacker's resolved ability/item feed the calc's Move constructor so
  // hit counts resolve correctly (Skill Link pins 2-5-hit moves at 5) and
  // item/ability-dependent move types (Multi-Attack, Judgment) follow suit.
  // `atk` is post-gimmick, so a mega forme's swapped ability is what's passed.
  const moveOpts: Record<string, unknown> = {
    isCrit: args.critical,
    ability: (atk as unknown as { ability?: string }).ability,
    item: (atk as unknown as { item?: string }).item,
  };
  // Spread modifier: in doubles, moves targeting both foes (allAdjacentFoes)
  // or all adjacent (allAdjacent — both foes + ally) take a 0.75x damage
  // multiplier. @smogon/calc honors this via the `isSpread` flag; we set it
  // automatically from the move's dex target so callers don't have to.
  // Single-target moves (normal, any) leave isSpread unset (single hit, no
  // reduction).
  const moveData = getMove(args.move) as any;
  if (args.spreadOverride != null) {
    if (args.spreadOverride) moveOpts.isSpread = true;
  } else if (moveData?.target === 'allAdjacentFoes' || moveData?.target === 'allAdjacent') {
    moveOpts.isSpread = true;
  }
  activeGimmick().enrichCalcMove?.({
    set: args.attacker,
    active: !!args.attackerOpts?.gimmickActive,
    move: args.move,
    opts: moveOpts,
  });
  let move = new CalcMove(GEN, args.move, moveOpts as any);
  // Dragonize (custom Champions ability, Feraligatr-Mega): the holder's Normal-type
  // moves become Dragon type with 1.2x power. @smogon/calc has no logic for this
  // ability NAME, so its -ate conversion is silently dropped — the move stays Normal
  // (wrong type effectiveness: Ghost immunity, Steel/Rock resist vs Dragon's profile)
  // AND loses Feraligatr-Mega's Water/DRAGON STAB AND the 1.2x. Emulate it by
  // rebuilding the move with type+BP overrides; the calc then recomputes STAB +
  // effectiveness from the Dragon type. Mirror of the Mega Sol weather emulation
  // above. `atk.ability` is the RESOLVED (mega) ability — the gimmick swapped in the
  // forme's ability. (Damaging moves only; status moves don't deal damage.)
  if ((atk as unknown as { ability?: string }).ability === 'Dragonize'
    && moveData?.type === 'Normal' && moveData?.category !== 'Status') {
    const boostedBp = Math.round((((move as unknown as { bp?: number }).bp) ?? 0) * 1.2);
    move = new CalcMove(GEN, args.move, { ...moveOpts, overrides: { type: 'Dragon', basePower: boostedBp } } as any);
  }
  const field = toCalcField(effField, args.attackerSide, args.helpingHand);
  const result = calculate(GEN, atk, def, move, field);
  const dmg = result.damage;
  const rawRolls: number[] = Array.isArray(dmg)
    ? (Array.isArray(dmg[0]) ? (dmg as number[][]).flat() : (dmg as number[]))
    : [dmg as number];
  // Multi-hit moves (Dual Wingbeat, Bullet Seed, Rock Blast, Population Bomb…):
  // @smogon/calc returns PER-HIT rolls, so a single roll undercounts the move by
  // its hit count. kochance()/desc() are already total-based; only the raw rolls
  // need scaling. `move.hits` is the calc-resolved hit count (e.g. 2; 3 for the
  // 2-5 moves; 5 with Skill Link via the ability passed above).
  //
  // VARIABLE-count moves (dex multihit [2,5], no Skill Link) get the true
  // Gen-5+ hit-count distribution instead of the calc's flat 3-hit average:
  // 2/3 hits 35% each, 4/5 hits 15% each — encoded by replicating the per-hit
  // roll set ×7/7/3/3 (out of 20) at each count. Loaded Dice → 4 or 5, 50/50.
  // min/max then span the honest envelope (a 2-hit low roll no longer falls
  // below `min`, which used to make inference reject truthful observations),
  // and every rolls/percentRolls consumer (candidateLikelihood, the search's
  // koRolls pooling) weights KO odds by the real hit-count probabilities.
  // Approximation (same as the fixed-count path): per-hit rolls are treated
  // as perfectly correlated (total = hits × one roll) rather than summed
  // independently — slightly fatter tails, never a wrong envelope.
  const hits = Math.max(1, ((move as unknown as { hits?: number }).hits) ?? 1);
  const mh = moveData?.multihit as number | [number, number] | undefined;
  // Skill Link already pins hits at the max → fixed-count path. The weights
  // below encode the [2,5] distribution specifically — every variable-count
  // move in Gen 9 is [2,5]; anything exotic falls back to the calc's average.
  const isVariable = Array.isArray(mh) && mh[0] === 2 && mh[1] === 5 && hits !== 5;
  let rolls: number[];
  if (isVariable) {
    // The calc emits one nested 16-roll array PER hit (identical sets for
    // uniform-power 2-5 moves) — reduce to a single hit's set before weighting.
    const perHitRolls = rawRolls.slice(0, Math.max(1, Math.floor(rawRolls.length / hits)));
    const hasDice = /loaded\s*dice/i.test((atk as unknown as { item?: string }).item ?? '');
    const weights: Array<[number, number]> = hasDice
      ? [[4, 1], [5, 1]]
      : [[2, 7], [3, 7], [4, 3], [5, 3]];
    rolls = [];
    for (const [h, w] of weights) {
      for (let i = 0; i < w; i++) for (const r of perHitRolls) rolls.push(r * h);
    }
  } else {
    rolls = hits > 1 ? rawRolls.map(r => r * hits) : rawRolls;
  }
  const min = rolls.length ? Math.min(...rolls) : 0;
  const max = rolls.length ? Math.max(...rolls) : 0;
  const maxHP = def.maxHP();
  const percentRolls = rolls.map(r => (r / maxHP) * 100);
  // NOTE: kochance() THROWS on an all-zero damage result (status moves,
  // fixed-damage callbacks the calc can't price). Callers rely on that throw
  // to exclude non-damaging options (solveEndgame's sentinel path); the
  // replay checker catches it as an honest 'calc failed' skip.
  return {
    min,
    max,
    rolls,
    percentRolls,
    minPercent: (min / maxHP) * 100,
    maxPercent: (max / maxHP) * 100,
    koChance: result.kochance().text,
    desc: result.desc(),
  };
}

// Compute the defender's max HP for a given set (Gen 9 formula). Returns a
// sentinel of 1 if @smogon/calc can't construct this species — callers should
// treat ratios cautiously, but at least bring scoring won't crash.
export function maxHpFor(set: PokemonSet): number {
  try {
    const p = toCalcPokemon(set);
    const hp = p.maxHP();
    return hp > 0 ? hp : 1;
  } catch {
    return 1;
  }
}

// Convert an observed damage measurement to an absolute damage range.
// If the observation is in HP%, multiply by maxHP. If absolute, return as-is.
export function observationToAbsoluteDamage(
  obs: DamageObservation,
  defenderSet: PokemonSet,
): { lo: number; hi: number } {
  if (obs.damageRaw != null) return { lo: obs.damageRaw, hi: obs.damageRaw };
  if (obs.damageHpPercent != null) {
    const maxHP = maxHpFor(defenderSet);
    // HP% rounding: assume the user reported to nearest integer %, so the true
    // damage is within +/- 0.5% of the reported value.
    const lo = Math.floor(((obs.damageHpPercent - 0.5) / 100) * maxHP);
    const hi = Math.ceil(((obs.damageHpPercent + 0.5) / 100) * maxHP);
    return { lo: Math.max(0, lo), hi: Math.max(0, hi) };
  }
  return { lo: 0, hi: Number.POSITIVE_INFINITY };
}
