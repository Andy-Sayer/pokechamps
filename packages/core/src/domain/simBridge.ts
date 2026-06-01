/**
 * simBridge.ts — drive the REAL Showdown engine (`@pkmn/sim`) from a mid-battle
 * position, for ground-truth turn resolution.
 *
 * This is the foundation of the `project_sim_engine_strategy` plan: an EXACT
 * forward engine we can (a) diff our fast `endgameSearch.ts` against to find gaps,
 * and (b) later expose as an opt-in oracle for the recommended line.
 *
 * IMPORTANT — DEPENDENCY BOUNDARY. `@pkmn/sim` is a **devDependency**. Nothing on
 * the shipped/runtime path may import this module, or the TUI bundle pulls in the
 * whole engine. It is consumed only by tests today. When the opt-in oracle ships,
 * promote `@pkmn/sim` to an OPTIONAL dependency and lazy-`import()` this module so
 * the base bundle stays lean (see `project_tui_bundle_deploy`).
 *
 * The engine has no public "load arbitrary mid-game state" API, so we construct a
 * customgame battle (no team preview → actives are sent out immediately) and then
 * set HP / status / boosts / field to the target state before resolving the turn.
 */
import { Battle } from '@pkmn/sim';
import { toId } from './data.js';

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
}

/** Read-out of one active slot after a turn. */
export interface SimSlot {
  species: string;
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
function orderTeam(team: SimMon[], active: number[]): SimMon[] {
  const lead = active.map(i => team[i]!);
  const rest = team.filter((_, i) => !active.includes(i));
  return [...lead, ...rest];
}

/** Build a started customgame battle with the position's mid-state applied. */
export function buildBattle(pos: SimPosition): Battle {
  const battle = new Battle({ formatid: 'gen9doublescustomgame', seed: pos.seed ?? [1, 2, 3, 4] } as any);
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
    species: p.species.name, hpPct: p.hp / p.maxhp * 100, fainted: p.fainted, status: p.status || '',
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
