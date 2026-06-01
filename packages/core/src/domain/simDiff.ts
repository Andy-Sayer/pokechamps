/**
 * simDiff.ts — diff our fast `endgameSearch` turn resolver against the real
 * Showdown engine (`@pkmn/sim`) on the SAME position + the SAME concrete moves, to
 * find where our model has gaps. Structural fields (fainted / status / boosts /
 * weather / terrain) are roll-INDEPENDENT, so a mismatch there is a real modelling
 * gap, not a damage roll. HP is reported for context but not asserted.
 *
 * DEV/TEST ONLY — imports `simBridge` (the `@pkmn/sim` devDependency). Must never be
 * reached from the runtime path (see `project_client_side_compute` /
 * `project_sim_engine_strategy`).
 */
import type { SearchInput, TurnAction } from './endgameSearch.js';
import { resolveOneTurn } from './endgameSearch.js';
import { defaultOpponentSet } from './bring.js';
import { toId } from './data.js';
import { buildBattle, stepTurn, readOutcome, type SimMon, type SimPosition, type SimSlotState, type SimSlot, type SimField } from './simBridge.js';
import type { PokemonSet } from './types.js';

const MAX_ACTIVE = 2;

function activeIdxs(flags: boolean[], hp: number[]): number[] {
  const out: number[] = [];
  flags.forEach((a, i) => { if (a && (hp[i] ?? 0) > 0) out.push(i); });
  return out.slice(0, MAX_ACTIVE);
}

function toSimMon(set: PokemonSet): SimMon {
  return {
    species: set.species, ability: set.ability ?? undefined, item: set.item ?? undefined,
    moves: set.moves ?? [], nature: set.nature, evs: set.evs as SimMon['evs'], ivs: set.ivs as SimMon['ivs'],
    level: set.level ?? 50,
  };
}

const SIM_WEATHER: Record<string, string> = { sunnyday: 'Sun', desolateland: 'Sun', raindance: 'Rain', primordialsea: 'Rain', sandstorm: 'Sand', snowscape: 'Snow', snow: 'Snow', hail: 'Snow' };
const SIM_TERRAIN: Record<string, string> = { electricterrain: 'Electric', grassyterrain: 'Grassy', mistyterrain: 'Misty', psychicterrain: 'Psychic' };
const nz = (b: SimSlot['boosts']): SimSlotState['boosts'] => { const o: Record<string, number> = {}; for (const k of ['atk', 'def', 'spa', 'spd', 'spe'] as const) if (b[k]) o[k] = b[k]!; return o; };

/** Re-seed the SearchInput from the sim's POST-SEND-OUT baseline (boosts/status/
 *  field), so both engines start the turn from the same state. The sim fires lead
 *  abilities (Intimidate/Drizzle) on send-out that our logged input wouldn't carry;
 *  aligning here de-confounds the comparison (esp. faints from Intimidate'd damage). */
function applySimBaseline(input: SearchInput, pos: SimPosition, before: ReturnType<typeof readOutcome>): SearchInput {
  const mine = input.mine.map(m => ({ ...m }));
  const opp = input.opp.map(o => ({ ...o }));
  pos.p1active.forEach(i => { const s = before.p1.find(x => x && x.species === mine[i]!.set.species); if (s) { mine[i]!.boosts = nz(s.boosts); mine[i]!.status = s.status || undefined; } });
  pos.p2active.forEach(j => { const s = before.p2.find(x => x && x.species === opp[j]!.entry.species); if (s) { opp[j]!.boosts = nz(s.boosts); opp[j]!.status = s.status || undefined; } });
  const field = { ...input.field, weather: (SIM_WEATHER[before.weather] ?? null) as SearchInput['field']['weather'], terrain: (SIM_TERRAIN[before.terrain] ?? null) as SearchInput['field']['terrain'] };
  return { ...input, mine, opp, field };
}

/** The concrete opponent set both engines reason about (top candidate, else a
 *  default) — so the comparison is apples-to-apples, not set-vs-set. */
function oppSet(input: SearchInput, j: number): PokemonSet {
  const e = input.opp[j]!.entry;
  return e.candidates?.[0] ?? defaultOpponentSet(e, 50);
}

/** Build the equivalent sim position from a SearchInput. */
export function searchInputToSimPosition(input: SearchInput): SimPosition {
  const myActive = activeIdxs(input.mine.map(m => !!m.active), input.mine.map(m => m.hpPercent));
  const oppActive = activeIdxs(input.opp.map(o => !!o.active), input.opp.map(o => o.hpPercent));
  const slotState = (hp: number, status?: string, boosts?: SimSlotState['boosts']): SimSlotState => ({ hpPct: hp, status: (status || '') as SimSlotState['status'], boosts });
  return {
    p1team: input.mine.map(m => toSimMon(m.set)),
    p2team: input.opp.map((_, j) => toSimMon(oppSet(input, j))),
    p1active: myActive,
    p2active: oppActive,
    p1state: myActive.map(i => slotState(input.mine[i]!.hpPercent, input.mine[i]!.status, input.mine[i]!.boosts as SimSlotState['boosts'])),
    p2state: oppActive.map(j => slotState(input.opp[j]!.hpPercent, input.opp[j]!.status, input.opp[j]!.boosts as SimSlotState['boosts'])),
    field: { weather: input.field.weather as SimField['weather'], terrain: input.field.terrain as SimField['terrain'] },
  };
}

/** One structural disagreement between the two engines. */
export interface Divergence {
  /** 'status' | 'boost:spe' | 'fainted' | 'weather' | 'terrain' | 'hp'. */
  field: string;
  who: string;          // species (or 'field')
  ours: string;
  sim: string;
}

export interface TurnDiffResult {
  divergences: Divergence[];
  /** Per-mon HP gap (|ours−sim| in %) for context, keyed by species. */
  hpGaps: Record<string, number>;
}

// Choice string for one active slot, using the move OUR engine actually picked.
function choiceFor(action: TurnAction | undefined, moveUsed: string | undefined, targetSlotPos: number): string {
  if (!action) return 'default';
  if (action.kind === 'protect') return 'default';
  const id = toId(moveUsed ?? '');
  if (!id) return 'default';
  if (action.kind === 'spread') return `move ${id}`;
  return `move ${id} ${targetSlotPos}`;
}

/**
 * Resolve one turn in BOTH engines and return the structural divergences. The sim
 * is told to use the exact moves our engine chose (so we compare the same play).
 * `myActions`/`oppActions` are keyed by active team-index; only attack/spread are
 * compared (protect/switch deferred). HP threshold: flagged only when one engine
 * faints a mon the other keeps alive (a roll won't flip that for a healthy mon).
 */
export function diffTurn(
  input: SearchInput,
  myActions: Map<number, TurnAction>,
  oppActions: Map<number, TurnAction>,
  seed?: [number, number, number, number],
): TurnDiffResult {
  const pos = searchInputToSimPosition(input);
  if (seed) pos.seed = seed;     // vary across positions so damage rolls average out
  const battle = buildBattle(pos);
  const simBefore = readOutcome(battle);
  // Start BOTH engines from the sim's post-send-out baseline (lead Intimidate /
  // weather …), so those don't show up as turn-resolution gaps. We still compare
  // the per-turn delta below as a second safeguard.
  const aligned = applySimBaseline(input, pos, simBefore);
  const ours = resolveOneTurn(aligned, myActions, oppActions);

  // Build sim choices in active-slot order, mapping our team-index targets → sim
  // slot positions (1-based index within the opposing side's active list).
  const slotPos = (teamIdx: number, activeList: number[]) => activeList.indexOf(teamIdx) + 1;
  const p1choice = pos.p1active.map(i => choiceFor(myActions.get(i), ours.mine[i]?.moveUsed,
    myActions.get(i)?.kind === 'attack' ? slotPos((myActions.get(i) as { target: number }).target, pos.p2active) : 0)).join(', ');
  const p2choice = pos.p2active.map(j => choiceFor(oppActions.get(j), ours.opp[j]?.moveUsed,
    oppActions.get(j)?.kind === 'attack' ? slotPos((oppActions.get(j) as { target: number }).target, pos.p1active) : 0)).join(', ');

  const sim = stepTurn(battle, p1choice, p2choice);

  const divergences: Divergence[] = [];
  const hpGaps: Record<string, number> = {};
  const bm = (b?: SimSlot['boosts']) => ({ atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...(b ?? {}) });

  // Compare the CHANGE each side's turn produced (after − before), so send-out
  // setup the two engines started from differently doesn't register as a gap.
  const cmpSide = (
    ourBefore: { status?: string; boosts?: SimSlot['boosts']; hpPct: number }[],
    ourAfter: typeof ours.mine, simSide: typeof sim.p1, simBeforeSide: SimSlot[] | undefined, activeList: number[],
  ) => {
    for (const i of activeList) {
      const oA = ourAfter[i]!;
      const oB = ourBefore[i]!;
      const sA = simSide.find(s => s && s.species === oA.species);
      const sB = simBeforeSide?.find(s => s && s.species === oA.species);
      if (!sA || !sB) continue;
      // Gained-faint this turn (was alive at start).
      const ourFaint = !( (oB.hpPct ?? 0) <= 0) && oA.fainted;
      const simFaint = !sB.fainted && sA.fainted;
      if (ourFaint !== simFaint) divergences.push({ field: 'fainted', who: oA.species, ours: String(ourFaint), sim: String(simFaint) });
      if (oA.fainted || sA.fainted) { hpGaps[oA.species] = Math.abs(oA.hpPct - sA.hpPct); continue; }
      // Gained status this turn (start was clean).
      const ourGained = !(oB.status || '') ? (oA.status || '') : '';
      const simGained = !(sB.status || '') ? (sA.status || '') : '';
      if (ourGained !== simGained) divergences.push({ field: 'status', who: oA.species, ours: ourGained || '-', sim: simGained || '-' });
      // Boost DELTA per stat.
      const obB = bm(oB.boosts), sbB = bm(sB.boosts);
      for (const k of ['atk', 'def', 'spa', 'spd', 'spe'] as const) {
        const od = (oA.boosts[k] ?? 0) - obB[k], sd = (sA.boosts[k] ?? 0) - sbB[k];
        if (od !== sd) divergences.push({ field: `boost:${k}`, who: oA.species, ours: String(od), sim: String(sd) });
      }
      hpGaps[oA.species] = Math.abs(oA.hpPct - sA.hpPct);
    }
  };
  const myBefore = pos.p1active.map(i => ({ status: aligned.mine[i]!.status, boosts: aligned.mine[i]!.boosts as SimSlot['boosts'], hpPct: aligned.mine[i]!.hpPercent }));
  const opBefore = pos.p2active.map(j => ({ status: aligned.opp[j]!.status, boosts: aligned.opp[j]!.boosts as SimSlot['boosts'], hpPct: aligned.opp[j]!.hpPercent }));
  // ourBefore is indexed by team-index in cmpSide, so build full-length arrays.
  const fill = (active: number[], vals: { status?: string; boosts?: SimSlot['boosts']; hpPct: number }[], n: number) => {
    const arr: { status?: string; boosts?: SimSlot['boosts']; hpPct: number }[] = Array.from({ length: n }, () => ({ hpPct: 100 }));
    active.forEach((idx, k) => { arr[idx] = vals[k]!; });
    return arr;
  };
  cmpSide(fill(pos.p1active, myBefore, input.mine.length), ours.mine, sim.p1, simBefore.p1.filter((s): s is SimSlot => !!s), pos.p1active);
  cmpSide(fill(pos.p2active, opBefore, input.opp.length), ours.opp, sim.p2, simBefore.p2.filter((s): s is SimSlot => !!s), pos.p2active);

  // Weather/terrain: compare what the TURN changed it TO (relative to each side's
  // own pre-turn value), so a lead's send-out weather isn't counted.
  const wChangedOurs = (ours.weather || '') !== (toId(aligned.field.weather || '') ? (aligned.field.weather || '') : '');
  const ourW = ours.weather || '-', simW = sim.weather || '-', simWBefore = simBefore.weather || '-';
  if (simW !== simWBefore || wChangedOurs) {
    if (toId(ourW.replace(/-/, '')) !== toId(simW)) divergences.push({ field: 'weather', who: 'field', ours: ourW, sim: simW });
  }
  const ourTer = toId(ours.terrain || ''), simTer = toId((sim.terrain || '').replace(/terrain$/, '')), simTerBefore = toId((simBefore.terrain || '').replace(/terrain$/, ''));
  if (ourTer !== simTer && simTer !== simTerBefore) divergences.push({ field: 'terrain', who: 'field', ours: ours.terrain || '-', sim: sim.terrain || '-' });

  return { divergences, hpGaps };
}
