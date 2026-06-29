/**
 * simBridge.ts — drive the REAL Showdown engine (`@pkmn/sim`) from a mid-battle
 * position, for ground-truth turn resolution.
 *
 * This is the foundation of the `project_sim_engine_strategy` plan: an EXACT
 * forward engine we can (a) diff our fast `endgameSearch.ts` against to find gaps,
 * and (b) later expose as an opt-in oracle for the recommended line.
 *
 * IMPORTANT — DEPENDENCY BOUNDARY. `@pkmn/sim` is an OPTIONAL dependency, loaded
 * lazily via `ensureSimLoaded()` — this module has NO eager engine import, so it
 * is safe on the runtime path (the opt-in `/exact` oracle imports it). The TUI
 * bundle marks `@pkmn/sim` external (scripts/bundle-tui.mjs): a bundle user
 * without the package simply gets `ensureSimLoaded() === false` and a friendly
 * message, while dev installs and the repo TUI have it available. Callers must
 * await `ensureSimLoaded()` before any of the sync APIs below.
 *
 * The engine has no public "load arbitrary mid-game state" API, so we construct a
 * customgame battle (no team preview → actives are sent out immediately) and then
 * set HP / status / boosts / field to the target state before resolving the turn.
 */
import type { Battle } from '@pkmn/sim';
import { toId } from './data.js';

// Lazily-loaded Battle constructor + Dex. Null until ensureSimLoaded() succeeds.
let BattleCtor: typeof Battle | null = null;
let SimDex: { species: { get(name: string): { exists?: boolean } | undefined } } | null = null;

/** Load `@pkmn/sim` if present. Returns false (without throwing) when the
 *  package isn't installed — the caller surfaces "exact engine unavailable". */
export async function ensureSimLoaded(): Promise<boolean> {
  if (BattleCtor) return true;
  try {
    const mod = await import('@pkmn/sim');
    BattleCtor = mod.Battle;
    SimDex = mod.Dex as unknown as typeof SimDex;
    return true;
  } catch {
    return false;
  }
}

/** True once ensureSimLoaded() has succeeded in this process. */
export function simAvailable(): boolean {
  return BattleCtor != null;
}

/** Does the loaded sim's dex know this species/forme? As of @pkmn/sim 0.10.11 the
 *  Champions mega formes (Dragonite-Mega, Eelektross-Mega, …) ARE present and
 *  mega-evolve correctly — every Champions-legal mega is covered (pinned by
 *  champions-sim-ready.test.ts). This is now a coverage probe for NEW/unstaged
 *  content rather than a "skip Champions megas" guard. Returns false when the sim
 *  isn't loaded. */
export function simHasSpecies(name: string): boolean {
  if (!SimDex || !name) return false;
  const s = SimDex.species.get(name);
  return !!s && s.exists !== false;
}

/** One Pokémon for the sim. Mirrors Showdown's PokemonSet shape (the fields we use). */
export interface SimMon {
  species: string;
  ability?: string;
  item?: string;
  moves: string[];
  nature?: string;
  evs?: Partial<Record<'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe', number>>;
  ivs?: Partial<Record<'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe', number>>;
  level?: number;
}

/** Target mid-battle state for one active slot. */
export interface SimSlotState {
  hpPct?: number;                                   // 0–100; default 100
  status?: '' | 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz';
  boosts?: Partial<Record<'atk' | 'def' | 'spa' | 'spd' | 'spe', number>>;
}

export interface SimField {
  weather?: 'Sun' | 'Rain' | 'Sand' | 'Snow' | null;
  terrain?: 'Electric' | 'Grassy' | 'Misty' | 'Psychic' | null;
}

/** A doubles position to resolve. `*active` are team indices in the lead two slots. */
export interface SimPosition {
  p1team: SimMon[];
  p2team: SimMon[];
  p1active: number[];          // ≤2 team indices, in slot order
  p2active: number[];
  p1state?: (SimSlotState | undefined)[];   // parallel to p1active
  p2state?: (SimSlotState | undefined)[];
  field?: SimField;
  seed?: [number, number, number, number];
  /** Resolve as a SINGLES battle (gen9customgame). Used for true 1v1 endgames:
   *  the sim can't start a doubles battle with a one-mon side, and a 1v1 has
   *  no doubles-only semantics (spread/ally targeting) to lose. */
  singles?: boolean;
}

/** Read-out of one active slot after a turn. */
export interface SimSlot {
  species: string;
  /** Forme-stable identity: a mega-evolved mon's `species` changes
   *  (Dragonite → Dragonite-Mega) but its `baseSpecies` does not — match on this
   *  to track a mon across a mega or a forme change within a turn. */
  baseSpecies: string;
  hpPct: number;
  fainted: boolean;
  status: string;
  boosts: Partial<Record<'atk' | 'def' | 'spa' | 'spd' | 'spe', number>>;
}
export interface SimOutcome {
  turn: number;
  p1: (SimSlot | null)[];
  p2: (SimSlot | null)[];
  weather: string;
  terrain: string;
}

const WEATHER_ID: Record<string, string> = { Sun: 'sunnyday', Rain: 'raindance', Sand: 'sandstorm', Snow: 'snowscape' };
const TERRAIN_ID: Record<string, string> = { Electric: 'electricterrain', Grassy: 'grassyterrain', Misty: 'mistyterrain', Psychic: 'psychicterrain' };

function toSimSet(m: SimMon) {
  return {
    name: m.species, species: m.species, item: m.item ?? '', ability: m.ability ?? '',
    moves: m.moves, nature: m.nature ?? 'Hardy',
    evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...(m.evs ?? {}) },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31, ...(m.ivs ?? {}) },
    level: m.level ?? 50,
  };
}

// Order a team so the desired actives occupy the first `active.length` slots —
// customgame sends out the leading team members, so we reorder to control leads.
// Exported so the oracle can map "switch to species X" to the sim's team slot.
export function orderTeam(team: SimMon[], active: number[]): SimMon[] {
  const lead = active.map(i => team[i]!);
  const rest = team.filter((_, i) => !active.includes(i));
  return [...lead, ...rest];
}

/** Build a started customgame battle with the position's mid-state applied.
 *  Requires a prior successful `await ensureSimLoaded()`. */
export function buildBattle(pos: SimPosition): Battle {
  if (!BattleCtor) throw new Error('@pkmn/sim not loaded — await ensureSimLoaded() first');
  const formatid = pos.singles ? 'gen9customgame' : 'gen9doublescustomgame';
  const battle = new BattleCtor({ formatid, seed: pos.seed ?? [1, 2, 3, 4] } as any);
  battle.setPlayer('p1', { name: 'p1', team: orderTeam(pos.p1team, pos.p1active).map(toSimSet) as any });
  battle.setPlayer('p2', { name: 'p2', team: orderTeam(pos.p2team, pos.p2active).map(toSimSet) as any });
  // Even customgame opens at a team-preview request; the default order (our
  // already-reordered team) sends out the lead two per side and fires send-out
  // abilities. This does NOT resolve a turn — we land at turn 1 awaiting moves.
  battle.makeChoices('default', 'default');
  // Now overwrite the mid-battle state we care about.
  applyState(battle.sides[0]!.active, pos.p1state);
  applyState(battle.sides[1]!.active, pos.p2state);
  const src = battle.sides[0]!.active[0]!;
  if (pos.field?.weather) battle.field.setWeather(WEATHER_ID[pos.field.weather]! as any, src);
  if (pos.field?.terrain) battle.field.setTerrain(TERRAIN_ID[pos.field.terrain]! as any, src);
  return battle;
}

function applyState(active: any[], states?: (SimSlotState | undefined)[]) {
  if (!states) return;
  active.forEach((p, i) => {
    const s = states[i];
    if (!p || !s) return;
    if (s.hpPct != null) p.sethp(Math.max(1, Math.round(p.maxhp * s.hpPct / 100)));
    if (s.status) { p.status = toId(s.status) as any; p.statusState = { id: toId(s.status) }; }
    if (s.boosts) {
      p.boosts = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
      for (const k of ['atk', 'def', 'spa', 'spd', 'spe'] as const) if (s.boosts[k]) p.boosts[k] = s.boosts[k]!;
    }
  });
}

/** Resolve ONE turn. Choices are Showdown choice strings, e.g. "move 1 1, move 2".
 *  Use 'default' to let the engine pick. Returns the post-turn structural state. */
export function stepTurn(battle: Battle, p1choice: string, p2choice: string): SimOutcome {
  battle.makeChoices(p1choice, p2choice);
  return readOutcome(battle);
}

export function readOutcome(battle: Battle): SimOutcome {
  const slot = (p: any): SimSlot | null => p == null ? null : ({
    species: p.species.name, baseSpecies: p.species.baseSpecies || p.species.name,
    hpPct: p.hp / p.maxhp * 100, fainted: p.fainted, status: p.status || '',
    boosts: { atk: p.boosts.atk, def: p.boosts.def, spa: p.boosts.spa, spd: p.boosts.spd, spe: p.boosts.spe },
  });
  return {
    turn: battle.turn,
    p1: battle.sides[0]!.active.map(slot),
    p2: battle.sides[1]!.active.map(slot),
    weather: battle.field.weather || '',
    terrain: battle.field.terrain || '',
  };
}

/** Post-turn state of EVERY Pokémon on a side (active + bench + fainted), keyed
 *  by forme-stable base species. Lets a caller find where a mon ended up even if
 *  it mega-evolved (species renamed) or switched out (left the active slots) —
 *  the active-slot read-out alone can't distinguish "switched out, alive" from
 *  "fainted". */
export interface RosterMon { baseSpecies: string; species: string; hpPct: number; fainted: boolean; status: string; active: boolean }
export function readRoster(battle: Battle): { p1: RosterMon[]; p2: RosterMon[] } {
  const side = (s: any): RosterMon[] => (s.pokemon as any[]).map(p => ({
    baseSpecies: p.species.baseSpecies || p.species.name, species: p.species.name,
    hpPct: p.maxhp ? p.hp / p.maxhp * 100 : 0, fainted: !!p.fainted, status: p.status || '',
    active: !!p.isActive,
  }));
  return { p1: side(battle.sides[0]!), p2: side(battle.sides[1]!) };
}
