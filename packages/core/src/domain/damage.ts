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
} = {}): CalcPokemon {
  const max = 100; // placeholder; calc derives real max from species
  const curHP = opts.curHpPercent != null ? Math.round((opts.curHpPercent / 100) * max) : undefined;
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
    ...(curHP != null ? { curHP } : {}),
  };
  // Let the active gimmick override the species name (e.g. Mega swaps the
  // base forme for the mega forme when a stone is held — @smogon/calc does
  // not auto-resolve this) and mutate calcOpts (e.g. set teraType + isTera,
  // isDynamaxed).
  const gimmick = activeGimmick();
  const resolvedSpecies = gimmick.resolveSpecies?.({ set, active: !!opts.gimmickActive }) ?? set.species;
  gimmick.enrichCalcPokemon?.({ set, active: !!opts.gimmickActive, opts: calcOpts });
  return new CalcPokemon(GEN, calcSpeciesName(resolvedSpecies), calcOpts as any);
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
  const moveOpts: Record<string, unknown> = { isCrit: args.critical };
  // Spread modifier: in doubles, moves targeting both foes (allAdjacentFoes)
  // or all adjacent (allAdjacent — both foes + ally) take a 0.75x damage
  // multiplier. @smogon/calc honors this via the `isSpread` flag; we set it
  // automatically from the move's dex target so callers don't have to.
  // Single-target moves (normal, any) leave isSpread unset (single hit, no
  // reduction).
  const moveData = getMove(args.move) as any;
  if (moveData?.target === 'allAdjacentFoes' || moveData?.target === 'allAdjacent') {
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
  // 2-5 moves; 5 with Skill Link).
  const hits = Math.max(1, ((move as unknown as { hits?: number }).hits) ?? 1);
  const rolls = hits > 1 ? rawRolls.map(r => r * hits) : rawRolls;
  const min = rolls.length ? Math.min(...rolls) : 0;
  const max = rolls.length ? Math.max(...rolls) : 0;
  const maxHP = def.maxHP();
  const percentRolls = rolls.map(r => (r / maxHP) * 100);
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
