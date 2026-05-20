import type { PokemonSet, ChampionsFormat } from '../types.js';

export type GimmickId = 'none' | 'mega' | 'tera' | 'zmove' | 'dynamax';

// Loosely-typed option bags handed to @smogon/calc constructors. Gimmick
// modules mutate these before `new CalcPokemon(...)` / `new CalcMove(...)`
// runs. Kept as Record<string, unknown> on purpose — coupling the Gimmick
// interface to @smogon/calc's internal types would make it brittle to upgrades.
export type CalcPokemonOpts = Record<string, unknown>;
export type CalcMoveOpts = Record<string, unknown>;

export interface BattleControl {
  hotkey: string;
  label: string;
}

export interface Gimmick {
  readonly id: GimmickId;
  readonly label: string;

  // --- Showdown parser hooks ---
  // Consume one input line. Return true if handled; false/undefined lets the
  // generic parser try the next line.
  parseShowdownLine?(line: string, draft: Partial<PokemonSet>): boolean;
  // Emit extra Showdown export lines for this set (after the standard ones).
  formatShowdownLines?(set: PokemonSet): string[];

  // --- @smogon/calc bridge ---
  // Override the species name passed to new CalcPokemon(...). Return null/undefined
  // to leave the set's species unchanged. Used e.g. by Mega to swap the base
  // forme for the mega forme when the set holds a mega stone — @smogon/calc
  // does NOT auto-resolve the forme from the held item.
  resolveSpecies?(args: { set: PokemonSet; active: boolean }): string | null | undefined;
  // Mutate the options object that will be passed to new CalcPokemon(...).
  enrichCalcPokemon?(args: { set: PokemonSet; active: boolean; opts: CalcPokemonOpts }): void;
  // Mutate the options object that will be passed to new CalcMove(...).
  enrichCalcMove?(args: { set: PokemonSet; active: boolean; move: string; opts: CalcMoveOpts }): void;

  // --- Inference ---
  // Yield partial sets representing variants the opponent might have chosen at
  // team-build time (e.g. each legal mega stone for a species). Inference mixes
  // these into its candidate generation.
  enumerateOpponentVariants?(speciesId: string): Array<Partial<PokemonSet>>;

  // --- Battle UI ---
  // Per-Pokemon activation control. null = nothing to render for this set.
  battleControl?(set: PokemonSet, active: boolean): BattleControl | null;

  // --- Validation ---
  // Returns human-readable errors for an illegal team configuration.
  validateSet?(set: PokemonSet, format: ChampionsFormat): string[];

  // --- Display ---
  // Optional one-liner appended to AI prompts' set summary.
  describeSet?(set: PokemonSet): string | null;
}
