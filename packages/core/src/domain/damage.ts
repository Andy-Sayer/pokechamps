import { Generations, calculate, Pokemon as CalcPokemon, Move as CalcMove, Field, Side } from '@smogon/calc';
import type { PokemonSet, FieldState, DamageObservation } from './types.js';
import { activeGimmick } from './gimmicks/index.js';
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
  const moveOpts: Record<string, unknown> = { isCrit: args.critical };
  activeGimmick().enrichCalcMove?.({
    set: args.attacker,
    active: !!args.attackerOpts?.gimmickActive,
    move: args.move,
    opts: moveOpts,
  });
  const move = new CalcMove(GEN, args.move, moveOpts as any);
  const field = toCalcField(args.field, args.attackerSide, args.helpingHand);
  const result = calculate(GEN, atk, def, move, field);
  const dmg = result.damage;
  const rolls: number[] = Array.isArray(dmg)
    ? (Array.isArray(dmg[0]) ? (dmg as number[][]).flat() : (dmg as number[]))
    : [dmg as number];
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
