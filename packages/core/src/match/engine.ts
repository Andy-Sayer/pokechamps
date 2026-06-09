// MatchEngine — server-side / pure orchestration of a full turn submission and
// of individual state updates. This is a port of the same logic that lives in
// the TUI's BattleScreen (`finalizeTurn` / `applyStateUpdate` /
// `applyHazardUpdate`) with the React-specific calls stripped out.
//
// Both the TUI and the server now share this module so the inference + EOT
// pipeline only has one implementation. The TUI can call it directly (Phase
// 3.3) instead of re-deriving turn results client-side.
//
// Everything in here is sync and pure-ish (it mutates a fresh copy of the
// input match and returns it; the caller's Match object is not touched).

import type {
  Match,
  MoveAction,
  FieldState,
  DamageObservation,
  OpponentEntry,
  PokemonSet,
  Turn,
} from '../domain/types.js';
import { NEUTRAL_FIELD } from '../domain/types.js';
import { scoreSpread, scoreOffensiveSpread, recoilDrainHpEvs, reconcileCandidates } from '../domain/inference.js';
import { computeActionBoostContexts } from '../domain/turnBoosts.js';
import { maxHpFor } from '../domain/damage.js';
import { endOfTurn } from '../domain/endOfTurn.js';
import { inferOpponentSpeeds, applySpeedInference } from '../domain/speed.js';
import {
  applyHazardVerb,
  applyHazardsToSwitchIn,
  absorbsToxicSpikes,
  hazardClearEffect,
  applyHazardClear,
} from '../domain/hazards.js';
import { fieldMoveEffect, applyFieldMove } from '../domain/fieldMoves.js';
import { defaultOpponentSet } from '../domain/bring.js';
import { applyMegaAction } from '../domain/megaResolve.js';
import {
  switchInAbilityEffect,
  intimidateReaction,
  certainAbility,
  resolveDownloadBoost,
  foeDropOf,
  statDropImmune,
  defiantStat,
  type BoostMap,
} from '../domain/abilities.js';
import { sashProcced } from '../domain/itemSignals.js';
import { hpItemTriggerFor } from '../domain/hpItemTriggers.js';
import { statusBerryFor } from '../domain/statusBerries.js';
import { resistBerryForType } from '../domain/resistBerries.js';
import { effectiveness, speciesTypes } from '../domain/typechart.js';
import { EFFECT_DURATIONS } from '../domain/durations.js';
import { isChargeMove, isPivotMove, isItemRemovingMove, isItemSwapMove, getSpecies, getMove, getAbility, toId } from '../domain/data.js';
import type { StateUpdate, HazardUpdate } from '../domain/turnparser.js';

export type ActiveIdx = {
  mine: [number | null, number | null];
  theirs: [number | null, number | null];
};

// ---------------- helpers (mirror of BattleScreen.tsx) ----------------

// On-switch-in hazards. Mutates `match` in place. Same body as
// `applyHazardOnSwitchInto` in BattleScreen.tsx but operating on the engine's
// local mutable copy.
function applyHazardOnSwitchInto(
  match: Match,
  side: 'mine' | 'theirs',
  teamIndex: number,
): void {
  const field = match.field;
  if (!field) return;
  const hazards = side === 'mine' ? field.myHazards : field.theirHazards;
  if (!hazards) return;
  const incoming = side === 'mine'
    ? match.myTeam[teamIndex]
    : match.opponentTeam[teamIndex];
  if (!incoming) return;
  const effect = applyHazardsToSwitchIn(hazards, {
    species: incoming.species,
    ability: (incoming as any).ability,
    item: (incoming as any).item,
  });
  if (effect.hpPctLoss > 0) {
    if (side === 'mine') {
      const prev = match.myCurrentHp?.[teamIndex] ?? 100;
      const newHp = Math.max(0, prev - effect.hpPctLoss);
      match.myCurrentHp = { ...(match.myCurrentHp ?? {}), [teamIndex]: newHp };
      if (newHp === 0 && !(match.myFainted ?? []).includes(teamIndex)) {
        match.myFainted = [...(match.myFainted ?? []), teamIndex];
      }
    } else {
      const o = match.opponentTeam[teamIndex];
      if (o) {
        const prev = o.currentHpPercent ?? 100;
        const newHp = Math.max(0, prev - effect.hpPctLoss);
        o.currentHpPercent = newHp;
        if (newHp === 0) o.fainted = true;
      }
    }
  }
  if (effect.statusApplied) {
    if (side === 'mine') {
      if (tryApplyMyStatus(match, teamIndex, effect.statusApplied) && effect.statusApplied === 'tox') {
        match.myToxCounter = { ...(match.myToxCounter ?? {}), [teamIndex]: 1 };
      }
    } else {
      const o = match.opponentTeam[teamIndex];
      if (o && tryApplyOppStatus(o, effect.statusApplied) && effect.statusApplied === 'tox') {
        o.toxCounter = 1;
      }
    }
  }
  if (effect.boostsApplied) {
    if (side === 'mine') {
      const cur = { ...(match.myBoosts?.[teamIndex] ?? {}) };
      for (const [stat, delta] of Object.entries(effect.boostsApplied)) {
        (cur as any)[stat] = Math.max(-6, Math.min(6, ((cur as any)[stat] ?? 0) + (delta ?? 0)));
      }
      match.myBoosts = { ...(match.myBoosts ?? {}), [teamIndex]: cur };
    } else {
      const o = match.opponentTeam[teamIndex];
      if (o) {
        const cur = { ...(o.currentBoosts ?? {}) };
        for (const [stat, delta] of Object.entries(effect.boostsApplied)) {
          (cur as any)[stat] = Math.max(-6, Math.min(6, ((cur as any)[stat] ?? 0) + (delta ?? 0)));
        }
        o.currentBoosts = cur;
      }
    }
  }
  if (absorbsToxicSpikes({ species: incoming.species })) {
    if (side === 'mine' && match.field?.myHazards?.toxicSpikes) {
      match.field = { ...match.field, myHazards: { ...match.field.myHazards, toxicSpikes: 0 } };
    } else if (side === 'theirs' && match.field?.theirHazards?.toxicSpikes) {
      match.field = { ...match.field, theirHazards: { ...match.field.theirHazards, toxicSpikes: 0 } };
    }
  }
}

// Clear my-side move-restricting volatiles for a team index (on switch-out).
function clearMyVolatiles(match: Match, idx: number): void {
  if (match.myTaunted) match.myTaunted = match.myTaunted.filter(i => i !== idx);
  if (match.myEncoreMove) delete match.myEncoreMove[idx];
  if (match.myDisabledMove) delete match.myDisabledMove[idx];
  if (match.myTauntTurns) delete match.myTauntTurns[idx];
  if (match.myEncoreTurns) delete match.myEncoreTurns[idx];
  if (match.myDisableTurns) delete match.myDisableTurns[idx];
  if (match.myLeechSeeded) delete match.myLeechSeeded[idx];
  // Clears on switch-out: Curse, partial trap, Nightmare, Substitute.
  if (match.myCursed) delete match.myCursed[idx];
  if (match.myPartialTrap) delete match.myPartialTrap[idx];
  if (match.myNightmare) delete match.myNightmare[idx];
  if (match.myCurrentSub) delete match.myCurrentSub[idx];
  // Persists through switch: Salt Cure, Aqua Ring, Ingrain — not cleared here.
}

// Clear opp move-restricting volatiles + their counters (switch-out / cure).
function clearOppVolatiles(o: OpponentEntry): void {
  o.taunted = undefined; o.encoreMove = undefined; o.disabledMove = undefined;
  o.tauntTurns = undefined; o.encoreTurns = undefined; o.disableTurns = undefined;
  o.leechSeeded = undefined;
  // Clears on switch-out: Curse, partial trap, Nightmare, Substitute.
  o.cursed = undefined; o.partialTrap = undefined; o.nightmare = undefined; o.substitute = undefined;
  // Persists: saltCured, aquaRing, ingrain — not cleared here.
}

// Try to apply a non-volatile status to my mon, intercepted by a held status
// berry (Lum / Cheri / Chesto / Pecha / Rawst / Aspear). Returns true when
// the status WAS applied (caller should also set tox/sleep counters); returns
// false when the berry caught it (item marked consumed, status not set).
function tryApplyMyStatus(
  match: Match,
  teamIndex: number,
  status: NonNullable<import('../domain/types.js').ActivePokemonState['status']>,
): boolean {
  const consumed = match.myItemConsumed?.[teamIndex];
  const held = consumed ? undefined : match.myTeam[teamIndex]?.item;
  const cure = statusBerryFor(held, status);
  if (cure) {
    match.myItemConsumed = { ...(match.myItemConsumed ?? {}), [teamIndex]: cure.consumed };
    return false;
  }
  match.myStatus = { ...(match.myStatus ?? {}), [teamIndex]: status };
  return true;
}

// Opp-side mirror — only safe to call when the opp item is KNOWN (revealed
// via inference or explicit observation). Caller decides whether to invoke.
function tryApplyOppStatus(
  o: OpponentEntry,
  status: NonNullable<import('../domain/types.js').ActivePokemonState['status']>,
): boolean {
  if (o.itemConsumed || !o.item) {
    o.status = status;
    return true;
  }
  const cure = statusBerryFor(o.item, status);
  if (cure) {
    o.itemConsumed = cure.consumed;
    return false;
  }
  o.status = status;
  return true;
}

// Apply an EXPLICITLY-logged status (a `45 brn` target tag or a `/ brn` self-clause)
// to the mon at (side, teamIndex). Routes through the same status-berry interception
// as auto-applied status and sets the tox/slp counters on success. Skips a mon that's
// already non-volatile statused, so it's idempotent with the auto-apply passes.
function applyLoggedStatus(
  match: Match,
  side: 'mine' | 'theirs',
  teamIndex: number,
  status: NonNullable<import('../domain/types.js').ActivePokemonState['status']>,
): void {
  if (side === 'mine') {
    if (match.myStatus?.[teamIndex]) return;
    if (tryApplyMyStatus(match, teamIndex, status)) {
      if (status === 'tox') match.myToxCounter = { ...(match.myToxCounter ?? {}), [teamIndex]: 1 };
      if (status === 'slp') match.mySleepCounter = { ...(match.mySleepCounter ?? {}), [teamIndex]: 3 };
    }
  } else {
    const o = match.opponentTeam[teamIndex];
    if (!o || o.status) return;
    if (tryApplyOppStatus(o, status)) {
      if (status === 'tox') o.toxCounter = 1;
      if (status === 'slp') o.sleepCounter = 3;
    }
  }
}

// Type-based immunity for a status move: returns true when the target's types
// make the status land as a no-op regardless of accuracy/ability.
// brn → Fire; par → Electric (only when !ignoreImmunity i.e. Thunder Wave);
// psn/tox → Poison or Steel; powder moves (Sleep Powder/Spore) → Grass.
function isStatusMoveImmune(
  status: string,
  ignoreImmunity: boolean,
  isPowder: boolean,
  targetTypes: string[],
): boolean {
  if (status === 'brn') return targetTypes.includes('Fire');
  if (status === 'par' && !ignoreImmunity) return targetTypes.includes('Electric');
  if (status === 'psn' || status === 'tox') return targetTypes.some(t => t === 'Poison' || t === 'Steel');
  if (status === 'slp' && isPowder) return targetTypes.includes('Grass');
  return false;
}

// Merge a boost map into a side's active-slot boosts, clamped to [-6, +6].
// Mirrors the inline boost logic in applyHazardOnSwitchInto / applyStateUpdate.
function applyBoostsTo(
  match: Match,
  side: 'mine' | 'theirs',
  teamIndex: number,
  boosts: BoostMap,
): void {
  const clamp = (n: number) => Math.max(-6, Math.min(6, n));
  if (side === 'mine') {
    const cur = { ...(match.myBoosts?.[teamIndex] ?? {}) };
    for (const [stat, delta] of Object.entries(boosts)) {
      (cur as any)[stat] = clamp(((cur as any)[stat] ?? 0) + (delta ?? 0));
    }
    match.myBoosts = { ...(match.myBoosts ?? {}), [teamIndex]: cur };
  } else {
    const o = match.opponentTeam[teamIndex];
    if (!o) return;
    const cur = { ...(o.currentBoosts ?? {}) };
    for (const [stat, delta] of Object.entries(boosts)) {
      (cur as any)[stat] = clamp(((cur as any)[stat] ?? 0) + (delta ?? 0));
    }
    o.currentBoosts = cur;
  }
}

// Switch-in ability triggers (A.2). Called right after a mon enters a slot,
// alongside hazard application. Applies Intimidate (-1 Atk to each opposing
// active, honouring immunity / Defiant-style reactions), weather/terrain
// setters, and self-boost abilities. `active` must already reflect this
// switch (the engine updates the slot before calling). Opponent abilities only
// trigger when certain (observed, or the species has a single ability) so we
// never apply an effect the opp might not have.
function applySwitchInAbility(
  match: Match,
  side: 'mine' | 'theirs',
  teamIndex: number,
  active: ActiveIdx,
): string[] {
  const notes: string[] = [];
  const incoming = side === 'mine' ? match.myTeam[teamIndex] : match.opponentTeam[teamIndex];
  if (!incoming) return notes;
  const knownAbility = side === 'mine'
    ? (incoming as PokemonSet).ability
    : (incoming as OpponentEntry).ability;
  const ability = certainAbility({ knownAbility, species: incoming.species });
  const effect = switchInAbilityEffect(ability);
  if (!effect) return notes;

  // Weather / terrain: set on the shared field. Last setter wins, matching
  // normal weather override (we don't model primordial-weather locks).
  if (effect.weather || effect.terrain) {
    const f: FieldState = { ...(match.field ?? NEUTRAL_FIELD) };
    if (effect.weather) { f.weather = effect.weather; f.weatherTurns = EFFECT_DURATIONS.weather; notes.push(`${incoming.species}'s ${ability} set ${effect.weather}`); }
    if (effect.terrain) { f.terrain = effect.terrain; notes.push(`${incoming.species}'s ${ability} set ${effect.terrain} Terrain`); }
    match.field = f;
  }

  // Self-boosts (Intrepid Sword / Dauntless Shield).
  if (effect.selfBoosts) {
    applyBoostsTo(match, side, teamIndex, effect.selfBoosts);
    notes.push(`${incoming.species}'s ${ability} boosted itself`);
  }

  // Intimidate: -1 Atk to each opposing active.
  if (effect.intimidate) {
    const foeSide: 'mine' | 'theirs' = side === 'mine' ? 'theirs' : 'mine';
    const foeSlots = foeSide === 'mine' ? active.mine : active.theirs;
    for (const foeIdx of foeSlots) {
      if (foeIdx == null) continue;
      // My own foes' abilities are always known; opp foes only when certain.
      const foeAbility = foeSide === 'mine'
        ? match.myTeam[foeIdx]?.ability
        : certainAbility({
            knownAbility: match.opponentTeam[foeIdx]?.ability,
            species: match.opponentTeam[foeIdx]?.species ?? '',
          });
      const reaction = intimidateReaction(foeAbility);
      if (!reaction.blocked) applyBoostsTo(match, foeSide, foeIdx, { atk: -1 });
      if (reaction.reaction) applyBoostsTo(match, foeSide, foeIdx, reaction.reaction);
    }
    notes.push(`${incoming.species}'s Intimidate lowered foe Attack`);
  }

  // Download: boost Atk or SpA based on which of the opponent's defenses is lower.
  if (effect.download) {
    const foeSide: 'mine' | 'theirs' = side === 'mine' ? 'theirs' : 'mine';
    const foeSlots = foeSide === 'mine' ? active.mine : active.theirs;
    // Only boost from the first opponent we find (if multiple actives, use the
    // first one). In real VGC, Download triggers once per switch-in on one foe.
    for (const foeIdx of foeSlots) {
      if (foeIdx == null) continue;
      const foe = foeSide === 'mine' ? match.myTeam[foeIdx] : match.opponentTeam[foeIdx];
      if (!foe) continue;
      // Calculate which stat to boost based on the foe's base Def vs SpD.
      const baseStats = (getSpecies(foe.species) as any)?.stats ?? {};
      const defVal = baseStats.def ?? 100;
      const spdVal = baseStats.spd ?? 100;
      const boost = resolveDownloadBoost(defVal, spdVal);
      applyBoostsTo(match, side, teamIndex, { [boost.stat]: 1 });
      notes.push(`${incoming.species}'s Download boosted its ${boost.stat === 'atk' ? 'Attack' : 'Sp. Atk'}`);
      break; // Only boost once per switch-in
    }
  }

  // Trace: copy an opponent's ability on switch-in.
  if (effect.trace) {
    const foeSide: 'mine' | 'theirs' = side === 'mine' ? 'theirs' : 'mine';
    const foeSlots = foeSide === 'mine' ? active.mine : active.theirs;
    // Copy from the first opponent we find. In real VGC, Trace picks one
    // opponent's ability when the user enters (implementation detail: pick slot 0).
    for (const foeIdx of foeSlots) {
      if (foeIdx == null) continue;
      const foe = foeSide === 'mine' ? match.myTeam[foeIdx] : match.opponentTeam[foeIdx];
      if (!foe) continue;
      const foeAbility = foeSide === 'mine'
        ? (foe as PokemonSet).ability
        : (foe as OpponentEntry).ability;
      if (foeAbility) {
        // On my side: update the PokemonSet's ability.
        if (side === 'mine') {
          (match.myTeam[teamIndex] as any).ability = foeAbility;
          notes.push(`${incoming.species}'s Trace copied ${foe.species}'s ${foeAbility}`);
        } else {
          // On opponent side: update the OpponentEntry's ability.
          (match.opponentTeam[teamIndex] as any).ability = foeAbility;
          notes.push(`Opp ${incoming.species}'s Trace copied ${foe.species}'s ${foeAbility}`);
        }
      }
      break; // Only trace once per switch-in
    }
  }

  return notes;
}

// Faint-counting outcome detection (mirror of BattleScreen.detectOutcome).
export function detectOutcome(match: Match): 'victory' | 'defeat' | 'tie' | undefined {
  const myBrought = new Set(match.bring);
  const myDown = (match.myFainted ?? []).filter(i => myBrought.has(i as any)).length;
  const mineOver = myDown >= myBrought.size;

  const oppFaintedCount = match.opponentTeam.filter(o => o.fainted).length;
  const brought = match.opponentBrought ?? [];
  const oppBroughtAllDown = brought.length > 0 && brought.every(i => match.opponentTeam[i]?.fainted);
  const theirsOver = oppFaintedCount >= 4 || (oppBroughtAllDown && brought.length >= 4);

  if (mineOver && theirsOver) return 'tie';
  if (theirsOver) return 'victory';
  if (mineOver) return 'defeat';
  return undefined;
}

// Derive the current active slots by replaying every turn's switch actions on
// top of the initial leads. The TUI keeps activeIdx in React state; on the
// server we don't have that, so we recompute from the persisted match.
//
// We also fold in `bringIntoSlot` style state updates (those aren't stored as
// turns, so the server-side path applies them as it goes — this only needs to
// know about switch actions inside turns + initial leads).
export function deriveActiveIdx(match: Match): ActiveIdx {
  const mine: [number | null, number | null] = [
    match.bring[0] ?? null,
    match.bring[1] ?? null,
  ];
  const leads = match.opponentBrought ?? [];
  // Initial opp leads: the first 2 in opponentBrought.
  const theirs: [number | null, number | null] = [
    leads[0] ?? null,
    leads[1] ?? null,
  ];

  // Replay every turn's switch actions in order.
  for (const turn of match.turns) {
    for (const a of turn.actions) {
      if (a.kind !== 'switch') continue;
      if (a.targetTeamIndex == null) continue;
      if (a.side === 'mine') mine[a.attackerSlot] = a.targetTeamIndex;
      else theirs[a.attackerSlot] = a.targetTeamIndex;
    }
  }

  // Clear any slot whose occupant has fainted (the slot would be empty in the
  // live state since BattleScreen always nulls a slot after a faint).
  for (let s = 0 as 0 | 1; s <= 1; s = (s + 1) as 0 | 1) {
    const mIdx = mine[s];
    if (mIdx != null && (match.myFainted ?? []).includes(mIdx)) mine[s] = null;
    const tIdx = theirs[s];
    if (tIdx != null && match.opponentTeam[tIdx]?.fainted) theirs[s] = null;
  }

  return { mine, theirs };
}

// ---------------- finalizeTurn ----------------

export interface FinalizeTurnInput {
  match: Match;
  turn: { actions: MoveAction[]; field: FieldState };
  activeIdx: ActiveIdx;
}

export interface FinalizeTurnResult {
  match: Match;
  activeIdx: ActiveIdx;
  inferenceNotes: string[];
  eotNotes: string[];
}

export function finalizeTurn(input: FinalizeTurnInput): FinalizeTurnResult {
  const { match, turn, activeIdx } = input;
  const draftActions = turn.actions;
  const field = turn.field ?? match.field ?? NEUTRAL_FIELD;
  const turnIndex = match.turns.length + 1;
  const newTurn: Turn = { index: turnIndex, actions: draftActions, field };

  // Grow brought set with any opp-side switches this turn.
  const broughtSet = new Set(match.opponentBrought ?? []);
  for (const a of draftActions) {
    if (a.kind === 'switch' && a.side === 'theirs' && a.targetTeamIndex != null) {
      broughtSet.add(a.targetTeamIndex as any);
    }
  }

  let next: Match = {
    ...match,
    turns: [...match.turns, newTurn],
    opponentBrought: [...broughtSet].sort((a, b) => a - b) as Match['opponentBrought'],
    myCurrentHp: { ...(match.myCurrentHp ?? {}) },
    myFainted: [...(match.myFainted ?? [])],
    // Copy volatile maps so switch-out clears don't mutate the caller's match.
    myEncoreMove: { ...(match.myEncoreMove ?? {}) },
    myDisabledMove: { ...(match.myDisabledMove ?? {}) },
    myTauntTurns: { ...(match.myTauntTurns ?? {}) },
    myEncoreTurns: { ...(match.myEncoreTurns ?? {}) },
    myDisableTurns: { ...(match.myDisableTurns ?? {}) },
    myLeechSeeded: { ...(match.myLeechSeeded ?? {}) },
    mySaltCured: { ...(match.mySaltCured ?? {}) },
    myAquaRing: { ...(match.myAquaRing ?? {}) },
    myIngrain: { ...(match.myIngrain ?? {}) },
    myCursed: { ...(match.myCursed ?? {}) },
    myPartialTrap: { ...(match.myPartialTrap ?? {}) },
    myNightmare: { ...(match.myNightmare ?? {}) },
  };

  // Walk damaging actions in order, deriving each action's damageHpPercent
  // from previous-vs-remaining HP (per-target running HP for multi-hit turns).
  const oppHpSoFar = new Map<number, number>();
  const myHpSoFar = new Map<number, number>();
  // Substitute HP running maps (parallel; updated when a sub absorbs a hit).
  const oppSubHpSoFar = new Map<number, number>();
  const mySubHpSoFar = new Map<number, number>();
  // Actions that were absorbed by a substitute (skip from inference + real-HP update).
  const hitSub = new Set<MoveAction>();
  const sortedActions = [...draftActions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const a of sortedActions) {
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    if (typeof a.target !== 'object') continue;
    const tIdx = a.targetTeamIndex;
    if (tIdx == null) continue;
    const tSide = a.target.side;

    // Substitute: damage routes to the sub HP instead of the real mon.
    // Sound moves (flags.sound) bypass substitutes.
    const curSubHp = tSide === 'theirs'
      ? (oppSubHpSoFar.has(tIdx) ? oppSubHpSoFar.get(tIdx)! : next.opponentTeam[tIdx]?.substitute)
      : (mySubHpSoFar.has(tIdx) ? mySubHpSoFar.get(tIdx)! : next.myCurrentSub?.[tIdx]);
    if (curSubHp != null) {
      const mvFlags = getMove(a.move) as { flags?: Record<string, number> } | undefined;
      if (!mvFlags?.flags?.sound) {
        hitSub.add(a);
        if (a.damageHpPercent != null) {
          const subAfter = Math.max(0, curSubHp - a.damageHpPercent);
          if (tSide === 'theirs') oppSubHpSoFar.set(tIdx, subAfter);
          else mySubHpSoFar.set(tIdx, subAfter);
        }
        continue; // real mon HP unchanged
      }
    }

    const prevPct = tSide === 'theirs'
      ? (oppHpSoFar.get(tIdx) ?? next.opponentTeam[tIdx]?.currentHpPercent ?? 100)
      : (myHpSoFar.get(tIdx) ?? next.myCurrentHp![tIdx] ?? 100);

    let newPct: number | null = null;
    if (a.targetRemainingHpPercent != null) {
      newPct = Math.max(0, Math.min(100, a.targetRemainingHpPercent));
    } else if (a.targetRemainingHpRaw != null && tSide === 'mine') {
      const mySet = next.myTeam[tIdx];
      const max = mySet ? maxHpFor(mySet) : 0;
      newPct = max > 0 ? Math.max(0, Math.min(100, (a.targetRemainingHpRaw / max) * 100)) : 0;
    } else if (a.damageHpPercent != null) {
      newPct = Math.max(0, prevPct - a.damageHpPercent);
    } else if (a.damageRaw != null && tSide === 'mine') {
      const mySet = next.myTeam[tIdx];
      const max = mySet ? maxHpFor(mySet) : 0;
      const dmgPct = max > 0 ? (a.damageRaw / max) * 100 : 0;
      newPct = Math.max(0, prevPct - dmgPct);
    }
    if (newPct == null) continue;

    // Record the raw hit damage BEFORE any auto-trigger heal so inference
    // sees the actual move output, not the post-Sitrus residual.
    a.damageHpPercent = Math.max(0, prevPct - newPct);

    // HP-threshold item auto-trigger (Sitrus, pinch berries). My-side only:
    // opp items are usually unknown and auto-firing a guess would silently
    // corrupt downstream inference. Held item is the set's item unless
    // already marked consumed earlier in the match.
    if (tSide === 'mine' && newPct > 0) {
      const consumed = next.myItemConsumed?.[tIdx];
      const held = consumed ? undefined : next.myTeam[tIdx]?.item;
      const trig = hpItemTriggerFor(held, prevPct, newPct);
      if (trig) {
        if (trig.healPercent != null) {
          newPct = Math.min(100, newPct + trig.healPercent);
        }
        if (trig.boost) {
          applyBoostsTo(next, 'mine', tIdx, { [trig.boost.stat]: trig.boost.amount });
        }
        next.myItemConsumed = { ...(next.myItemConsumed ?? {}), [tIdx]: trig.consumed };
      }
    }

    // Resist berry auto-consume (my side): item is always known.
    // Fires even if the mon fainted — the berry reduced the hit, so it's spent.
    if (tSide === 'mine') {
      const consumed = next.myItemConsumed?.[tIdx];
      const held = consumed ? undefined : next.myTeam[tIdx]?.item;
      if (held) {
        const moveDex = getMove(a.move) as { type?: string } | undefined;
        if (moveDex?.type) {
          const heldId = toId(held);
          const berryForType = resistBerryForType(moveDex.type);
          // Chilan halves any Normal hit (even neutral) — check first.
          if (heldId === 'chilanberry' && moveDex.type === 'Normal') {
            next.myItemConsumed = { ...(next.myItemConsumed ?? {}), [tIdx]: held };
          } else if (berryForType && heldId === toId(berryForType)) {
            const defTypes = speciesTypes(next.myTeam[tIdx]!.species);
            if (effectiveness(moveDex.type, defTypes) > 1) {
              next.myItemConsumed = { ...(next.myItemConsumed ?? {}), [tIdx]: held };
            }
          }
        }
      }
    }

    if (tSide === 'theirs') oppHpSoFar.set(tIdx, newPct);
    else myHpSoFar.set(tIdx, newPct);
  }

  // Commit per-target final HP.
  if (oppHpSoFar.size > 0) {
    next.opponentTeam = next.opponentTeam.map((x, i) => {
      if (!oppHpSoFar.has(i)) return x;
      const hp = oppHpSoFar.get(i)!;
      return { ...x, currentHpPercent: hp, fainted: hp === 0 ? true : x.fainted };
    });
  }
  for (const [idx, hp] of myHpSoFar) {
    next.myCurrentHp![idx] = hp;
    if (hp === 0 && !next.myFainted!.includes(idx)) next.myFainted!.push(idx);
  }

  // Commit substitute HP changes; clear broken subs.
  for (const [idx, subHp] of oppSubHpSoFar) {
    const o = next.opponentTeam[idx];
    if (o) o.substitute = subHp <= 0 ? undefined : subHp;
  }
  if (mySubHpSoFar.size > 0) {
    next.myCurrentSub = { ...(next.myCurrentSub ?? {}) };
    for (const [idx, subHp] of mySubHpSoFar) {
      if (subHp <= 0) delete next.myCurrentSub[idx];
      else next.myCurrentSub[idx] = subHp;
    }
  }

  // Collected throughout the rest of finalize — mega resolution errors,
  // damage-inference candidates produced, etc.
  const inferenceNotes: string[] = [];

  // Resist berry auto-consume on opp side when item is KNOWN (set explicitly
  // by the user — never inferred from candidates). Opp conservatism: only
  // auto-fire when the item is certain, to avoid corrupting inference.
  for (const a of sortedActions) {
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    if (typeof a.target !== 'object' || a.target.side !== 'theirs') continue;
    const tIdx = a.targetTeamIndex;
    if (tIdx == null) continue;
    const o = next.opponentTeam[tIdx];
    if (!o || o.itemConsumed || !o.item) continue;
    const moveDex = getMove(a.move) as { type?: string } | undefined;
    if (!moveDex?.type) continue;
    const held = o.item;
    const heldId = toId(held);
    const berryForType = resistBerryForType(moveDex.type);
    // Chilan halves any Normal hit (even neutral) — check first.
    if (heldId === 'chilanberry' && moveDex.type === 'Normal') {
      o.itemConsumed = held;
    } else if (berryForType && heldId === toId(berryForType)) {
      const defTypes = speciesTypes(o.species);
      if (effectiveness(moveDex.type, defTypes) > 1) {
        o.itemConsumed = held;
      }
    }
  }

  // Update knownMoves on every opp that acted this turn (skipping mega and
  // switch actions which don't have a real move name).
  next.opponentTeam = next.opponentTeam.map(o => ({ ...o }));
  for (const a of draftActions) {
    if (a.side !== 'theirs') continue;
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    const idx = a.attackerTeamIndex;
    if (idx == null) continue;
    const entry = next.opponentTeam[idx];
    if (!entry) continue;
    if (!entry.knownMoves.includes(a.move)) {
      entry.knownMoves = [...entry.knownMoves, a.move];
    }
    if (a.mega) entry.megaUsed = true;
  }
  // Standalone mega actions: resolve the forme (X/Y when ambiguous), flip
  // megaUsed + megaForme + (opp side) confirm the held mega stone. Errors
  // come back as inference notes so the user sees them next turn.
  for (const a of draftActions) {
    if (a.kind !== 'mega') continue;
    const err = applyMegaAction(next, a);
    if (err) inferenceNotes.push(err);
  }

  // Two-turn charge moves (Solar Beam, Electro Shot, Phantom Force, etc.).
  // - If an action is a charge move with NO damage logged → the mon is
  //   charging; remember which move so the matchup grid can surface it.
  // - If an action has damage logged → clear any prior charging state
  //   for that mon (the move resolved this turn, either via Power Herb /
  //   sun / electric terrain, or it's just a different action entirely).
  for (const a of draftActions) {
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    const idx = a.attackerTeamIndex;
    if (idx == null) continue;
    const hasDamage = a.damageHpPercent != null || a.damageRaw != null
      || a.targetRemainingHpPercent != null || a.targetRemainingHpRaw != null;
    if (a.side === 'theirs') {
      const entry = next.opponentTeam[idx];
      if (!entry) continue;
      if (!hasDamage && isChargeMove(a.move)) {
        entry.charging = { move: a.move, turn: turnIndex };
      } else if (hasDamage) {
        entry.charging = undefined;
      }
    } else {
      const cur = next.myCharging ?? {};
      if (!hasDamage && isChargeMove(a.move)) {
        next.myCharging = { ...cur, [idx]: { move: a.move, turn: turnIndex } };
      } else if (hasDamage && cur[idx]) {
        const { [idx]: _, ...rest } = cur;
        next.myCharging = rest;
      }
    }
  }

  // Field-clearing moves (Defog / Rapid Spin / Court Change / Tidy Up).
  // Logged as ordinary move actions — detected by name here and applied to
  // the field so hazards/screens vanish without manual toggling.
  for (const a of draftActions) {
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    const clear = hazardClearEffect(a.move);
    if (!clear) continue;
    next.field = applyHazardClear(next.field ?? NEUTRAL_FIELD, a.side, clear.kind);
    if (a.attackerTeamIndex != null) {
      if (clear.userSpeedBoost) applyBoostsTo(next, a.side, a.attackerTeamIndex, { spe: clear.userSpeedBoost });
      if (clear.userAtkBoost) applyBoostsTo(next, a.side, a.attackerTeamIndex, { atk: clear.userAtkBoost });
    }
    inferenceNotes.push(`${a.move} cleared hazards`);
  }

  // Field-setting moves (weather / terrain / Trick Room / Tailwind / screens).
  for (const a of draftActions) {
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    const fm = fieldMoveEffect(a.move);
    if (!fm) continue;
    // Retrieve the setter's held item for duration adjustment (Damp Rock, Heat Rock, etc.)
    let setterItem: string | null | undefined;
    if (a.attackerTeamIndex != null) {
      if (a.side === 'mine') {
        setterItem = next.myTeam[a.attackerTeamIndex]?.item;
      } else {
        setterItem = next.opponentTeam[a.attackerTeamIndex]?.item;
      }
    }
    next.field = applyFieldMove(next.field ?? NEUTRAL_FIELD, a.side, fm, setterItem);
    inferenceNotes.push(`${a.move} set field state`);
  }

  // Leech Seed: set the volatile on a foe target. Fails on Grass-types
  // (immune) and on already-seeded targets. Cleared on switch-out by
  // clearMy/OppVolatiles, drained + heals at EOT in endOfTurn.
  for (const a of draftActions) {
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    if (a.move !== 'Leech Seed') continue;
    if (typeof a.target !== 'object') continue;
    const tIdx = a.targetTeamIndex;
    const sIdx = a.attackerTeamIndex;
    if (tIdx == null || sIdx == null) continue;
    if (a.target.side === 'theirs') {
      const o = next.opponentTeam[tIdx];
      if (!o || o.leechSeeded) continue;
      const formeName = o.megaUsed && o.megaForme ? o.megaForme : o.species;
      const types = (getSpecies(formeName) as { types?: string[] } | undefined)?.types;
      if (types?.includes('Grass')) continue;
      if (o.substitute != null) continue; // Substitute blocks Leech Seed
      const lsAbilOpp = certainAbility({ knownAbility: o.ability, species: o.species });
      if (lsAbilOpp && toId(lsAbilOpp) === 'magicbounce') continue;
      o.leechSeeded = { seederSide: a.side, seederIndex: sIdx };
      inferenceNotes.push(`o${tIdx + 1} seeded`);
    } else {
      const set = next.myTeam[tIdx];
      if (!set) continue;
      if (next.myLeechSeeded?.[tIdx]) continue;
      const formeName = next.myMegaUsed?.includes(tIdx) && next.myMegaForme?.[tIdx] ? next.myMegaForme[tIdx] : set.species;
      const types = (getSpecies(formeName) as { types?: string[] } | undefined)?.types;
      if (types?.includes('Grass')) continue;
      if (next.myCurrentSub?.[tIdx] != null) continue; // Substitute blocks Leech Seed
      if (toId(set.ability ?? '') === 'magicbounce') continue;
      next.myLeechSeeded = { ...(next.myLeechSeeded ?? {}), [tIdx]: { seederSide: a.side, seederIndex: sIdx } };
      inferenceNotes.push(`m${tIdx + 1} seeded`);
    }
  }

  // Substitute: the move costs the user 25% of their max HP and creates a sub
  // with that HP. The sub absorbs incoming damage (already handled above in the
  // HP update loop). Substitute fails silently if the user is at ≤25% HP.
  // Mirror in BattleScreen.tsx.
  for (const a of draftActions) {
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    if (a.move !== 'Substitute') continue;
    if (a.attackerTeamIndex == null) continue;
    if (a.side === 'mine') {
      if (next.myCurrentSub?.[a.attackerTeamIndex] != null) continue; // already subbed
      const myHp = next.myCurrentHp?.[a.attackerTeamIndex] ?? 100;
      if (myHp <= 25) continue;
      next.myCurrentHp = { ...(next.myCurrentHp ?? {}), [a.attackerTeamIndex]: myHp - 25 };
      next.myCurrentSub = { ...(next.myCurrentSub ?? {}), [a.attackerTeamIndex]: 25 };
    } else {
      const o = next.opponentTeam[a.attackerTeamIndex];
      if (!o || o.substitute != null) continue; // already subbed
      if ((o.currentHpPercent ?? 100) <= 25) continue;
      o.currentHpPercent = Math.max(0, (o.currentHpPercent ?? 100) - 25);
      o.substitute = 25;
    }
  }

  // Move self-stat drops (Overheat / Leaf Storm / Draco Meteor −2 SpA, Close
  // Combat −1 Def −1 SpD, Hammer Arm −1 Spe, …). Auto-apply once the move
  // connects (damage logged); Contrary inverts the boost. Mirror in
  // BattleScreen.tsx.
  for (const a of draftActions) {
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    if (a.attackerTeamIndex == null) continue;
    if (a.damageHpPercent == null && a.damageRaw == null) continue; // missed → no self-drop
    const m = getMove(a.move) as { self?: { boosts?: BoostMap } } | undefined;
    const boosts = m?.self?.boosts;
    if (!boosts) continue;
    const abil = a.side === 'mine'
      ? next.myTeam[a.attackerTeamIndex]?.ability
      : next.opponentTeam[a.attackerTeamIndex]?.ability;
    const contrary = !!abil && toId(abil) === 'contrary';
    const applied: BoostMap = {};
    for (const [stat, delta] of Object.entries(boosts)) {
      applied[stat as keyof BoostMap] = contrary ? -(delta as number) : (delta as number);
    }
    applyBoostsTo(next, a.side, a.attackerTeamIndex, applied);
  }

  // Foe-targeted stat drops from a damaging move's GUARANTEED (100%) secondary
  // (Icy Wind / Snarl / Electroweb / Struggle Bug / Breaking Swipe / Low Sweep / …):
  // apply to the TARGET's boosts when the move connected, honouring Clear Body /
  // White Smoke / Full Metal Body / Clear Amulet immunity + a standing Substitute,
  // Contrary inversion, and the **Defiant / Competitive +2 reaction**. Spread moves
  // log one action per target, so per-action application covers single + spread.
  // (Intimidate's Defiant trigger is handled on switch-in via intimidateReaction.)
  // Mirror in BattleScreen.tsx.
  for (const a of draftActions) {
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    if (a.damageHpPercent == null && a.damageRaw == null) continue;   // missed / immune → no secondary
    if (typeof a.target !== 'object' || a.targetTeamIndex == null) continue;
    const drop = foeDropOf(a.move);
    if (!drop) continue;
    const tSide = a.target.side;
    const tIdx = a.targetTeamIndex;
    if (tSide === 'mine' ? next.myCurrentSub?.[tIdx] != null : next.opponentTeam[tIdx]?.substitute != null) continue; // Sub blocks secondaries
    const tAbil = tSide === 'mine'
      ? next.myTeam[tIdx]?.ability
      : certainAbility({ knownAbility: next.opponentTeam[tIdx]?.ability, species: next.opponentTeam[tIdx]?.species ?? '' });
    const tItem = tSide === 'mine' ? next.myTeam[tIdx]?.item : next.opponentTeam[tIdx]?.item;
    if (statDropImmune(tAbil, tItem)) continue;                       // no drop, no Defiant
    if (tAbil && toId(tAbil) === 'contrary') {                        // Contrary: drop → boost, no Defiant
      const inv: BoostMap = {};
      for (const [s, d] of Object.entries(drop)) inv[s as keyof BoostMap] = -(d as number);
      applyBoostsTo(next, tSide, tIdx, inv);
      continue;
    }
    applyBoostsTo(next, tSide, tIdx, drop);
    const react = defiantStat(tAbil);
    if (react) {
      applyBoostsTo(next, tSide, tIdx, { [react]: 2 } as BoostMap);
      inferenceNotes.push(`${tSide === 'mine' ? 'm' : 'o'}${tIdx + 1} ${react === 'atk' ? 'Defiant' : 'Competitive'} +2 ${react} (foe-drop)`);
    }
  }

  // Drain moves (Giga Drain, Drain Punch, Leech Life, …): heal the attacker by
  // drain[0]/drain[1] of damage dealt (absolute HP → attacker's %). Mirror in
  // BattleScreen.tsx.
  const maxHpOf = (side: 'mine' | 'theirs', idx: number): number => {
    if (side === 'mine') return next.myTeam[idx] ? maxHpFor(next.myTeam[idx]!) : 0;
    const e = next.opponentTeam[idx];
    if (!e) return 0;
    return e.candidates?.[0] ? maxHpFor(e.candidates[0]!) : maxHpFor(defaultOpponentSet(e, 50));
  };
  for (const a of draftActions) {
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    if (a.attackerTeamIndex == null) continue;
    if (a.damageHpPercent == null) continue;
    if (typeof a.target !== 'object') continue;
    const tIdx = a.targetTeamIndex;
    if (tIdx == null) continue;
    const m = getMove(a.move) as { drain?: [number, number] } | undefined;
    const drain = m?.drain;
    if (!drain) continue;
    const defMax = maxHpOf(a.target.side, tIdx);
    const atkMax = maxHpOf(a.side, a.attackerTeamIndex);
    if (!defMax || !atkMax) continue;
    // Observed self-HP overrides the computed drain heal (ground truth).
    if (a.side === 'mine' && a.selfRemainingHpRaw != null) {
      next.myCurrentHp = next.myCurrentHp ?? {};
      next.myCurrentHp[a.attackerTeamIndex] = Math.max(0, Math.min(100, (a.selfRemainingHpRaw / atkMax) * 100));
      continue;
    }
    if (a.side === 'theirs' && a.selfRemainingHpPercent != null) {
      const o = next.opponentTeam[a.attackerTeamIndex];
      if (o) o.currentHpPercent = Math.max(0, Math.min(100, a.selfRemainingHpPercent));
      continue;
    }
    const dmgAbs = (a.damageHpPercent / 100) * defMax;
    const healPct = (dmgAbs * drain[0] / drain[1]) / atkMax * 100;
    // Liquid Ooze: drain deals damage to the attacker instead of healing.
    let defAbilForDrain: string | undefined;
    if (a.target.side === 'theirs') {
      const o = next.opponentTeam[tIdx];
      defAbilForDrain = o?.megaUsed && o.megaForme
        ? ((getSpecies(o.megaForme) as { abilities?: Record<string, string> } | undefined)?.abilities?.['0'] ?? o.ability ?? undefined)
        : (o?.ability ?? undefined);
    } else {
      const set = next.myTeam[tIdx];
      const megaForme = next.myMegaUsed?.includes(tIdx) ? next.myMegaForme?.[tIdx] : undefined;
      defAbilForDrain = megaForme
        ? ((getSpecies(megaForme) as { abilities?: Record<string, string> } | undefined)?.abilities?.['0'] ?? set?.ability ?? undefined)
        : set?.ability;
    }
    const liquidOoze = defAbilForDrain && toId(defAbilForDrain) === 'liquidooze';
    if (a.side === 'mine') {
      next.myCurrentHp = next.myCurrentHp ?? {};
      if (liquidOoze) {
        next.myCurrentHp[a.attackerTeamIndex] = Math.max(0, (next.myCurrentHp[a.attackerTeamIndex] ?? 100) - healPct);
      } else {
        next.myCurrentHp[a.attackerTeamIndex] = Math.min(100, (next.myCurrentHp[a.attackerTeamIndex] ?? 100) + healPct);
      }
    } else {
      const o = next.opponentTeam[a.attackerTeamIndex];
      if (o) {
        if (liquidOoze) {
          o.currentHpPercent = Math.max(0, (o.currentHpPercent ?? 100) - healPct);
        } else {
          o.currentHpPercent = Math.min(100, (o.currentHpPercent ?? 100) + healPct);
        }
      }
    }
  }

  // Recoil damage for the attacker (Brave Bird, Wood Hammer, Head Smash, etc.).
  // move.recoil = [n, d] → n/d of damage dealt; mindBlownRecoil → 50% of max HP.
  // Rock Head ability blocks standard recoil (but not mindBlown/steelBeam). Mirror in BattleScreen.tsx.
  for (const a of draftActions) {
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    if (a.attackerTeamIndex == null) continue;
    if (typeof a.target !== 'object') continue;
    const tIdx = a.targetTeamIndex;
    if (tIdx == null) continue;
    const rm = getMove(a.move) as { recoil?: [number, number]; mindBlownRecoil?: boolean } | undefined;
    const hasRecoil = rm?.recoil || rm?.mindBlownRecoil;
    if (!hasRecoil) continue;
    const atkAbil = a.side === 'mine'
      ? next.myTeam[a.attackerTeamIndex]?.ability
      : next.opponentTeam[a.attackerTeamIndex]?.ability;
    const atkMax = maxHpOf(a.side, a.attackerTeamIndex);
    if (!atkMax) continue;
    // Observed self-HP (`/ <hp>`) is ground truth — apply it (it already reflects
    // recoil + any contact-item chip) and skip the estimate.
    if (a.side === 'mine' && a.selfRemainingHpRaw != null) {
      next.myCurrentHp = next.myCurrentHp ?? {};
      next.myCurrentHp[a.attackerTeamIndex] = Math.max(0, Math.min(100, (a.selfRemainingHpRaw / atkMax) * 100));
      continue;
    }
    if (a.side === 'theirs' && a.selfRemainingHpPercent != null) {
      const o = next.opponentTeam[a.attackerTeamIndex];
      if (o) o.currentHpPercent = Math.max(0, Math.min(100, a.selfRemainingHpPercent));
      continue;
    }
    let recoilPct: number;
    const magicGuard = !!atkAbil && toId(atkAbil) === 'magicguard';
    if (magicGuard) continue;
    if (rm?.mindBlownRecoil) {
      recoilPct = 50; // 50% of user's max HP
    } else {
      if (a.damageHpPercent == null) continue; // recoil requires damage to have landed
      const rockHead = !!atkAbil && toId(atkAbil) === 'rockhead';
      if (rockHead) continue;
      const defMax = maxHpOf(a.target.side, tIdx);
      if (!defMax) continue;
      const [n, d] = rm!.recoil!;
      const dmgAbs = (a.damageHpPercent / 100) * defMax;
      recoilPct = (dmgAbs * n / d) / atkMax * 100;
    }
    if (a.side === 'mine') {
      next.myCurrentHp = next.myCurrentHp ?? {};
      const before = next.myCurrentHp[a.attackerTeamIndex] ?? 100;
      next.myCurrentHp[a.attackerTeamIndex] = Math.max(0, before - recoilPct);
    } else {
      const o = next.opponentTeam[a.attackerTeamIndex];
      if (o) o.currentHpPercent = Math.max(0, (o.currentHpPercent ?? 100) - recoilPct);
    }
  }

  // Rough Skin / Iron Barbs: contact move hits → attacker loses 1/8 of their max HP.
  // Only fires when the defender's ability is known (opp conservatism). Mirror in BattleScreen.tsx.
  for (const a of draftActions) {
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    if (a.attackerTeamIndex == null) continue;
    if (a.damageHpPercent == null) continue;
    if (typeof a.target !== 'object') continue;
    const tIdx = a.targetTeamIndex;
    if (tIdx == null) continue;
    const mv = getMove(a.move) as { flags?: Record<string, number> } | undefined;
    if (!mv?.flags?.contact) continue;
    let defAbil: string | undefined;
    if (a.target.side === 'theirs') {
      const o = next.opponentTeam[tIdx];
      defAbil = o?.megaUsed && o.megaForme
        ? ((getSpecies(o.megaForme) as { abilities?: Record<string, string> } | undefined)?.abilities?.['0'] ?? o.ability ?? undefined)
        : (o?.ability ?? undefined);
    } else {
      const set = next.myTeam[tIdx];
      const megaForme = next.myMegaUsed?.includes(tIdx) ? next.myMegaForme?.[tIdx] : undefined;
      defAbil = megaForme
        ? ((getSpecies(megaForme) as { abilities?: Record<string, string> } | undefined)?.abilities?.['0'] ?? set?.ability ?? undefined)
        : set?.ability;
    }
    if (!defAbil) continue;
    const dId = toId(defAbil);
    if (dId !== 'roughskin' && dId !== 'ironbarbs') continue;
    // Magic Guard on the attacker blocks the contact chip.
    const atkAbilRS = a.side === 'mine'
      ? next.myTeam[a.attackerTeamIndex]?.ability
      : next.opponentTeam[a.attackerTeamIndex]?.ability;
    if (atkAbilRS && toId(atkAbilRS) === 'magicguard') continue;
    const chip = 100 / 8; // 12.5% of attacker's max HP
    if (a.side === 'mine') {
      next.myCurrentHp = next.myCurrentHp ?? {};
      next.myCurrentHp[a.attackerTeamIndex] = Math.max(0, (next.myCurrentHp[a.attackerTeamIndex] ?? 100) - chip);
    } else {
      const o = next.opponentTeam[a.attackerTeamIndex];
      if (o) o.currentHpPercent = Math.max(0, (o.currentHpPercent ?? 100) - chip);
    }
  }

  // Spicy Spray (Champions custom defender ability): when a damaging hit lands
  // on its holder, the attacker is burned. Skip Fire-types (burn-immune) and
  // attackers already non-volatile-statused. Effective ability honors mega.
  for (const a of draftActions) {
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    if (a.attackerTeamIndex == null) continue;
    if (a.damageHpPercent == null && a.damageRaw == null) continue;
    if (typeof a.target !== 'object') continue;
    const tIdx = a.targetTeamIndex;
    if (tIdx == null) continue;
    // Resolve defender's effective ability (mega forme's if mega'd).
    let defAbility: string | undefined;
    let defFormeName = '';
    if (a.target.side === 'theirs') {
      const o = next.opponentTeam[tIdx];
      if (!o) continue;
      defFormeName = o.megaUsed && o.megaForme ? o.megaForme : o.species;
      defAbility = o.megaUsed && o.megaForme
        ? ((getSpecies(o.megaForme) as { abilities?: Record<string, string> } | undefined)?.abilities?.['0'] ?? o.ability ?? undefined)
        : (o.ability ?? undefined);
    } else {
      const set = next.myTeam[tIdx];
      if (!set) continue;
      const megaForme = next.myMegaUsed?.includes(tIdx) ? next.myMegaForme?.[tIdx] : undefined;
      defFormeName = megaForme ?? set.species;
      defAbility = megaForme
        ? ((getSpecies(megaForme) as { abilities?: Record<string, string> } | undefined)?.abilities?.['0'] ?? set.ability ?? undefined)
        : (set.ability ?? undefined);
    }
    if (!defAbility || toId(defAbility) !== 'spicyspray') continue;
    // Attacker burn — skip Fire-types and if already statused.
    const aIdx = a.attackerTeamIndex;
    const aSide = a.side;
    let atkFormeName = '';
    if (aSide === 'mine') {
      const myMega = next.myMegaUsed?.includes(aIdx) ? next.myMegaForme?.[aIdx] : undefined;
      atkFormeName = myMega ?? next.myTeam[aIdx]?.species ?? '';
    } else {
      const oppEntry = next.opponentTeam[aIdx];
      atkFormeName = (oppEntry?.megaUsed && oppEntry.megaForme) || oppEntry?.species || '';
    }
    const atkTypes = (getSpecies(atkFormeName) as { types?: string[] } | undefined)?.types ?? [];
    if (atkTypes.includes('Fire')) continue;
    let applied: boolean;
    if (aSide === 'mine') {
      if (next.myStatus?.[aIdx]) continue;
      applied = tryApplyMyStatus(next, aIdx, 'brn');
    } else {
      const o = next.opponentTeam[aIdx];
      if (!o || o.status) continue;
      applied = tryApplyOppStatus(o, 'brn');
    }
    const ref = `${aSide === 'mine' ? 'm' : 'o'}${aIdx + 1}`;
    inferenceNotes.push(applied
      ? `${ref} burned (Spicy Spray on ${defFormeName})`
      : `${ref} Rawst/Lum Berry cured the Spicy Spray burn`);
  }

  // Status-category moves auto-apply their status to the target. Only fires for
  // moves with category=Status and a top-level `status` field; secondary
  // effects on damaging moves (Nuzzle's 100% par) are Tier-4 probabilistic.
  // Type immunities respected: brn→Fire; par→Electric unless ignoreImmunity;
  // psn/tox→Poison+Steel; powder→Grass. Mirror in BattleScreen.tsx.
  for (const a of draftActions) {
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    if (a.attackerTeamIndex == null) continue;
    const sm = getMove(a.move) as { category?: string; status?: string; flags?: Record<string, number>; ignoreImmunity?: boolean } | undefined;
    if (!sm?.status || sm.category !== 'Status') continue;
    if (typeof a.target !== 'object') continue;
    const tIdx = a.targetTeamIndex;
    if (tIdx == null) continue;
    const tSide = a.target.side;
    const tTypes: string[] = tSide === 'mine'
      ? ((getSpecies(next.myTeam[tIdx]?.species ?? '') as { types?: string[] } | undefined)?.types ?? [])
      : ((getSpecies(next.opponentTeam[tIdx]?.species ?? '') as { types?: string[] } | undefined)?.types ?? []);
    if (isStatusMoveImmune(sm.status, !!sm.ignoreImmunity, !!(sm.flags?.powder), tTypes)) continue;
    // Substitute blocks status-category moves.
    if (tSide === 'mine' ? next.myCurrentSub?.[tIdx] != null : next.opponentTeam[tIdx]?.substitute != null) continue;
    // Magic Bounce reflects status-category moves back at the user.
    const tAbilMB = tSide === 'mine'
      ? next.myTeam[tIdx]?.ability
      : certainAbility({ knownAbility: next.opponentTeam[tIdx]?.ability, species: next.opponentTeam[tIdx]?.species ?? '' });
    if (tAbilMB && toId(tAbilMB) === 'magicbounce') continue;
    const st = sm.status as NonNullable<import('../domain/types.js').ActivePokemonState['status']>;
    if (tSide === 'mine') {
      if (next.myStatus?.[tIdx]) continue; // already non-volatile statused
      if (tryApplyMyStatus(next, tIdx, st)) {
        if (st === 'tox') next.myToxCounter = { ...(next.myToxCounter ?? {}), [tIdx]: 1 };
        if (st === 'slp') next.mySleepCounter = { ...(next.mySleepCounter ?? {}), [tIdx]: 3 };
      }
    } else {
      const o = next.opponentTeam[tIdx];
      if (!o || o.status) continue; // already non-volatile statused
      if (tryApplyOppStatus(o, st)) {
        if (st === 'tox') o.toxCounter = 1;
        if (st === 'slp') o.sleepCounter = 3;
      }
    }
  }

  // Explicitly-logged status from the turn line — observed facts the auto-apply
  // above can't infer: a damaging move's secondary status (`o1 > Scald > o1 > 45
  // brn`) or a contact-ability status on the ATTACKER (`m1 > Flare Blitz > o1 >
  // 45 / 80 brn`, burned by the foe's Flame Body). Mirror in BattleScreen.tsx.
  for (const a of draftActions) {
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    if (a.targetStatus && typeof a.target === 'object' && a.targetTeamIndex != null) {
      applyLoggedStatus(next, a.target.side, a.targetTeamIndex, a.targetStatus);
    }
    if (a.attackerStatus && a.attackerTeamIndex != null) {
      applyLoggedStatus(next, a.side, a.attackerTeamIndex, a.attackerStatus);
    }
  }

  // Setup self-boost moves (Swords Dance, Nasty Plot, Calm Mind, Dragon Dance,
  // Bulk Up, Quiver Dance, Shell Smash, etc.). Category=Status with a top-level
  // `boosts` field and target=self. Contrary inverts the deltas.
  // Mirror in BattleScreen.tsx.
  for (const a of draftActions) {
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    if (a.attackerTeamIndex == null) continue;
    const bm = getMove(a.move) as { category?: string; boosts?: BoostMap; target?: string } | undefined;
    if (!bm?.boosts || bm.category !== 'Status' || bm.target !== 'self') continue;
    const abil = a.side === 'mine'
      ? next.myTeam[a.attackerTeamIndex]?.ability
      : next.opponentTeam[a.attackerTeamIndex]?.ability;
    const contrary = !!abil && toId(abil) === 'contrary';
    const applied: BoostMap = {};
    for (const [stat, delta] of Object.entries(bm.boosts)) {
      applied[stat as keyof BoostMap] = contrary ? -(delta as number) : (delta as number);
    }
    applyBoostsTo(next, a.side, a.attackerTeamIndex, applied);
  }

  // Item-removing moves (Knock Off / Thief / Covet / berry-eaters). Mark the
  // target's item gone so the damage calc stops applying it. We don't always
  // know the opp's item — itemConsumed just needs to be truthy for the calc to
  // strip it; on my side we record the real lost item name for display.
  for (const a of draftActions) {
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    if (!isItemRemovingMove(a.move)) continue;
    if (typeof a.target !== 'object') continue;
    const tIdx = a.targetTeamIndex;
    if (tIdx == null) continue;
    if (a.target.side === 'theirs') {
      const o = next.opponentTeam[tIdx];
      if (o && !o.itemConsumed) o.itemConsumed = `knocked off (${a.move})`;
    } else {
      if (next.myItemConsumed?.[tIdx] == null) {
        const lost = next.myTeam[tIdx]?.item;
        next.myItemConsumed = { ...(next.myItemConsumed ?? {}), [tIdx]: lost ?? `knocked off (${a.move})` };
      }
    }
  }

  // Item-swap moves (Trick / Switcheroo). Exchange the user's and target's
  // held items so later damage calcs use the new holdings. The opp's item may
  // be unknown (undefined) — swapping still records what we DO know: the foe
  // now holds the user's item, the user now holds whatever the foe had.
  for (const a of draftActions) {
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    if (!isItemSwapMove(a.move)) continue;
    if (typeof a.target !== 'object') continue;
    const aIdx = a.attackerTeamIndex;
    const tIdx = a.targetTeamIndex;
    if (aIdx == null || tIdx == null) continue;
    const attackerItem = (a.side === 'mine' ? next.myTeam[aIdx]?.item : next.opponentTeam[aIdx]?.item) ?? undefined;
    const targetItem = (a.target.side === 'mine' ? next.myTeam[tIdx]?.item : next.opponentTeam[tIdx]?.item) ?? undefined;
    if (a.side === 'mine') { if (next.myTeam[aIdx]) next.myTeam[aIdx]!.item = targetItem; }
    else { if (next.opponentTeam[aIdx]) next.opponentTeam[aIdx]!.item = targetItem; }
    if (a.target.side === 'mine') { if (next.myTeam[tIdx]) next.myTeam[tIdx]!.item = attackerItem; }
    else { if (next.opponentTeam[tIdx]) next.opponentTeam[tIdx]!.item = attackerItem; }
    inferenceNotes.push(`${a.move}: swapped items`);
  }

  // Focus Sash logged via `... > o1 > N sash`. If it PROCCED (1-HP sliver),
  // the item is consumed and the capped damage is unreliable. If it did NOT
  // proc (survived with HP to spare), the damage is the move's true output and
  // we've simply learned the mon holds a Focus Sash (still held, not consumed).
  for (const a of draftActions) {
    if (!a.sash) continue;
    if (typeof a.target !== 'object') continue;
    const tIdx = a.targetTeamIndex;
    if (tIdx == null) continue;
    const procced = sashProcced(a);
    if (a.target.side === 'theirs') {
      const o = next.opponentTeam[tIdx];
      if (!o) continue;
      if (procced) { o.itemConsumed = 'Focus Sash'; o.fainted = false; if ((o.currentHpPercent ?? 0) <= 0) o.currentHpPercent = 1; }
      else o.item = 'Focus Sash'; // held, not consumed — damage stands
    } else if (procced) {
      next.myItemConsumed = { ...(next.myItemConsumed ?? {}), [tIdx]: 'Focus Sash' };
      next.myFainted = (next.myFainted ?? []).filter(i => i !== tIdx);
    }
  }

  // `(berry)` suffix: resist berry consumed. Derive berry name from move type and
  // record as learned+consumed for opp, or consumed for mine.
  for (const a of draftActions) {
    if (!a.berry) continue;
    if (typeof a.target !== 'object') continue;
    const tIdx = a.targetTeamIndex;
    if (tIdx == null) continue;
    const moveDex = getMove(a.move) as { type?: string } | undefined;
    const berryName = moveDex?.type ? resistBerryForType(moveDex.type) : undefined;
    if (!berryName) continue;
    if (a.target.side === 'theirs') {
      const o = next.opponentTeam[tIdx];
      if (!o) continue;
      if (!o.item) o.item = berryName;
      o.itemConsumed = berryName;
    } else {
      next.myItemConsumed = { ...(next.myItemConsumed ?? {}), [tIdx]: berryName };
    }
  }

  // Positional boost context per damaging action — the boosts in effect at that
  // point in the turn (Helping Hand / Coaching / setup / earlier-logged boost lines),
  // so a hit is inferred against the boosted state instead of an unboosted one.
  const boostCtx = computeActionBoostContexts({
    actions: draftActions,
    myStartBoosts: match.myBoosts ?? {},
    oppStartBoosts: Object.fromEntries(match.opponentTeam.map((o, i) => [i, o.currentBoosts ?? {}])),
    myActive: [activeIdx.mine[0], activeIdx.mine[1]],
    oppActive: [activeIdx.theirs[0], activeIdx.theirs[1]],
  });

  // Damage inference for every mine→theirs damaging action.
  for (const a of draftActions) {
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    if (a.side !== 'mine') continue;
    if (sashProcced(a)) continue; // Sash-capped damage understates the move — don't infer from it
    if (hitSub.has(a)) continue; // sub absorbed the hit — real mon HP unchanged
    if (a.damageHpPercent == null && a.damageRaw == null) continue;
    if (typeof a.target !== 'object' || a.target.side !== 'theirs') continue;
    const attackerSet = next.myTeam[a.attackerTeamIndex ?? -1];
    const oppIdx = a.targetTeamIndex;
    if (!attackerSet || oppIdx == null) continue;
    const opp = next.opponentTeam[oppIdx];
    if (!opp) continue;
    const bc = boostCtx.get(a);
    const obs: DamageObservation = {
      attackerSide: 'mine',
      attackerSpecies: attackerSet.species,
      defenderSide: 'theirs',
      defenderSpecies: opp.species,
      move: a.move,
      field,
      damageHpPercent: a.damageHpPercent,
      damageRaw: a.damageRaw,
      attackerGimmickActive: a.mega,
      defenderGimmickActive: opp.megaUsed,
      critical: a.critical,
      attackerBoosts: bc?.attackerBoosts,
      defenderBoosts: bc?.defenderBoosts,
      helpingHand: bc?.helpingHand,
    };
    try {
      const scored = scoreSpread({
        defenderSpecies: opp.species,
        defenderLevel: attackerSet.level,
        knownDefenderMoves: opp.knownMoves,
        attackerSet,
        observation: obs,
        startingCandidates: opp.candidates?.length
          ? opp.candidates.map(c => ({ evs: c.evs, nature: c.nature, item: c.item, ability: c.ability }))
          : undefined,
        // A recoil/drain readout pins the HP EV defense-independently — honour it.
        hpEvCandidates: opp.hpEvLock,
        // Item permanence: if the item was already consumed BEFORE this turn, it's
        // gone — read pre-turn state so a berry popping on THIS hit still applies.
        itemKnownGone: !!match.opponentTeam[oppIdx]?.itemConsumed,
        // Server keeps response latency bounded by skipping the ~360k-spread
        // coarse fallback. The Hybrid solver still returns a best-effort set
        // (never empty) so the client always has candidates to show.
        quickOnly: true,
      });
      const candidateSets: PokemonSet[] = scored.map(s => ({
        species: opp.species,
        level: attackerSet.level,
        item: s.candidate.item,
        ability: s.candidate.ability,
        nature: s.candidate.nature,
        evs: s.candidate.evs,
        ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
        moves: opp.knownMoves,
      }));
      const defEntry = { ...opp, candidates: candidateSets, candidateLikelihoods: scored.map(s => s.likelihood) };
      defEntry.observations = [...(opp.observations ?? []), { oppIsAttacker: false, otherSet: attackerSet, observation: obs }].slice(-10);
      next.opponentTeam[oppIdx] = defEntry;
      inferenceNotes.push(`${opp.species}: ${candidateSets.length} spread(s)`);
    } catch {
      inferenceNotes.push(`${opp.species}: inference failed`);
    }
  }

  // Offensive inference: when an opponent lands a damaging move on one of MY
  // known mons, narrow their Atk/SpA investment (the defensive solver never
  // touches those, so threats were otherwise computed from prior/zero offense).
  // Chains onto the candidates we already have.
  for (const a of draftActions) {
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    if (a.side !== 'theirs') continue;
    if (sashProcced(a)) continue;
    if (hitSub.has(a)) continue;
    if (a.damageHpPercent == null && a.damageRaw == null) continue;
    if (typeof a.target !== 'object' || a.target.side !== 'mine') continue;
    const oppIdx = a.attackerTeamIndex;
    const myIdx = a.targetTeamIndex;
    if (oppIdx == null || myIdx == null) continue;
    const opp = next.opponentTeam[oppIdx];
    const defenderSet = next.myTeam[myIdx];
    if (!opp?.candidates?.length || !defenderSet) continue;
    // Use the opp's active forme (mega if they've mega'd) for the calc.
    const attackerSpecies = opp.megaUsed && opp.megaForme ? opp.megaForme : opp.species;
    const obc = boostCtx.get(a);
    const obs: DamageObservation = {
      attackerSide: 'theirs', attackerSpecies, defenderSide: 'mine', defenderSpecies: defenderSet.species,
      move: a.move, field,
      damageHpPercent: a.damageHpPercent, damageRaw: a.damageRaw,
      defenderGimmickActive: next.myMegaUsed?.includes(myIdx),
      critical: a.critical,
      attackerBoosts: obc?.attackerBoosts,
      defenderBoosts: obc?.defenderBoosts,
      helpingHand: obc?.helpingHand,
    };
    try {
      const scored = scoreOffensiveSpread({
        attackerSpecies, attackerLevel: defenderSet.level,
        startingCandidates: opp.candidates.map(c => ({ evs: c.evs, nature: c.nature, item: c.item, ability: c.ability })),
        attackerMoves: opp.knownMoves, move: a.move, defenderSet, observation: obs,
      });
      const candidateSets: PokemonSet[] = scored.map(s => ({
        species: opp.candidates![0]!.species, level: defenderSet.level,
        item: s.candidate.item, ability: s.candidate.ability, nature: s.candidate.nature,
        evs: s.candidate.evs, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, moves: opp.knownMoves,
      }));
      const offEntry = { ...next.opponentTeam[oppIdx]!, candidates: candidateSets, candidateLikelihoods: scored.map(s => s.likelihood) };
      offEntry.observations = [...(offEntry.observations ?? []), { oppIsAttacker: true, otherSet: defenderSet, observation: obs }].slice(-10);
      next.opponentTeam[oppIdx] = offEntry;
    } catch { /* keep prior belief */ }
  }

  // Recoil/drain HP readout: a `/ <hp>` self-HP on a recoil/drain move solves the
  // opponent's max HP defense-independently (recoil/drain ∝ damage dealt). Pin the
  // opp's HP EV(s) and lock them for future inference. Both directions: the opp
  // recoils into my mon, OR I recoil into the opp.
  for (const a of draftActions) {
    if (a.kind === 'switch' || a.kind === 'mega') continue;
    if (a.attackerTeamIndex == null || a.targetTeamIndex == null || typeof a.target !== 'object') continue;
    if (a.damageHpPercent == null) continue;
    const selfAfter = a.side === 'mine' ? a.selfRemainingHpRaw : a.selfRemainingHpPercent;
    if (selfAfter == null) continue;
    const rm = getMove(a.move) as { recoil?: [number, number]; drain?: [number, number] } | undefined;
    const effect: 'recoil' | 'drain' | null = rm?.recoil ? 'recoil' : rm?.drain ? 'drain' : null;
    if (!effect) continue;
    const frac = effect === 'recoil' ? rm!.recoil![0] / rm!.recoil![1] : rm!.drain![0] / rm!.drain![1];
    const oppIsAttacker = a.side === 'theirs';
    const oppIdx = oppIsAttacker ? a.attackerTeamIndex : a.targetTeamIndex;
    const myIdx = oppIsAttacker ? a.targetTeamIndex : a.attackerTeamIndex;
    const opp = next.opponentTeam[oppIdx];
    const mySet = next.myTeam[myIdx];
    if (!opp || !mySet) continue;
    const knownMaxHp = maxHpFor(mySet);
    const attackerBeforeFrac = (oppIsAttacker
      ? (match.opponentTeam[a.attackerTeamIndex]?.currentHpPercent ?? 100)
      : (match.myCurrentHp?.[a.attackerTeamIndex] ?? 100)) / 100;
    const attackerAfterFrac = oppIsAttacker ? Math.min(100, selfAfter) / 100 : selfAfter / (knownMaxHp || 1);
    const peelFrac = a.selfHpSource === 'helmet' ? 1 / 6 : a.selfHpSource === 'orb' ? 1 / 10 : a.selfHpSource === 'barbs' ? 1 / 8 : 0;
    const attackerFainted = oppIsAttacker
      ? !!next.opponentTeam[a.attackerTeamIndex]?.fainted || attackerAfterFrac <= 0
      : !!next.myFainted?.includes(a.attackerTeamIndex) || attackerAfterFrac <= 0;
    const hpEvs = recoilDrainHpEvs({
      effect, frac, oppIsAttacker, oppSpecies: opp.species, oppLevel: mySet.level ?? 50,
      attackerBeforeFrac, attackerAfterFrac, attackerFainted, peelFrac,
      targetDropFrac: a.damageHpPercent / 100, knownMaxHp,
    });
    if (!hpEvs.length) continue;
    opp.hpEvLock = hpEvs;
    // Pin the current candidates' HP to the lock (override + budget filter + dedupe).
    if (opp.candidates?.length) {
      const seen = new Set<string>();
      const pinnedCands: PokemonSet[] = [];
      for (const c of opp.candidates) for (const hp of hpEvs) {
        if (hp + c.evs.def + c.evs.spd > 508) continue;
        const evs = { ...c.evs, hp };
        const key = `${hp}|${evs.def}|${evs.spd}|${c.nature}|${c.item}|${c.ability}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pinnedCands.push({ ...c, evs });
      }
      if (pinnedCands.length) opp.candidates = pinnedCands;
    }
    inferenceNotes.push(`${opp.species}: HP pinned via ${effect} (EV ${hpEvs.join('/')})`);
  }

  // Joint reconcile: re-check each surviving candidate against the FULL history
  // of observations on that mon and keep only the ones consistent with ALL of
  // them (a true joint nature × item × EV solve; catches an offensive nature
  // promotion or Hybrid recovery that contradicts an earlier defensive fit).
  for (let oi = 0; oi < next.opponentTeam.length; oi++) {
    const opp = next.opponentTeam[oi];
    if (!opp?.candidates?.length || (opp.observations?.length ?? 0) < 2) continue;
    const level = opp.candidates[0]!.level;
    const r = reconcileCandidates({
      oppSpecies: opp.species, oppLevel: level, knownMoves: opp.knownMoves,
      candidates: opp.candidates.map(c => ({ evs: c.evs, nature: c.nature, item: c.item, ability: c.ability })),
      likelihoods: opp.candidateLikelihoods, history: opp.observations!,
    });
    if (r.candidates.length === opp.candidates.length) continue; // unchanged
    opp.candidates = r.candidates.map(c => ({
      species: opp.species, level, item: c.item, ability: c.ability, nature: c.nature,
      evs: c.evs, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, moves: opp.knownMoves,
    }));
    opp.candidateLikelihoods = r.likelihoods;
    inferenceNotes.push(`${opp.species}: reconciled to ${opp.candidates.length} spread(s)`);
  }

  // Tag pivot-follow switches. A pivot move (U-turn etc.) executes, then
  // forces its user out — the user logs the switch as the next action by
  // the same mon + slot. That switch happens within the pivot's priority
  // bracket, not at the natural +6 switch bracket, so speed inference
  // would draw false signals from it without this tag.
  for (let i = 0; i < draftActions.length; i++) {
    const swAct = draftActions[i]!;
    if (swAct.kind !== 'switch') continue;
    // Walk backwards for the most recent same-side+slot action.
    for (let j = i - 1; j >= 0; j--) {
      const prev = draftActions[j]!;
      if (prev.side !== swAct.side || prev.attackerSlot !== swAct.attackerSlot) continue;
      if (prev.kind === 'switch' || prev.kind === 'mega') break; // not a pivot chain
      if (isPivotMove(prev.move)) swAct.pivot = true;
      break;
    }
  }

  // Speed inference uses the whole match history.
  const speeds = inferOpponentSpeeds(next, next.myTeam);
  applySpeedInference(next.opponentTeam, speeds);

  // Persist switches into the active-slot state; reset switching-out boosts.
  const nextActive: ActiveIdx = {
    mine: [activeIdx.mine[0], activeIdx.mine[1]],
    theirs: [activeIdx.theirs[0], activeIdx.theirs[1]],
  };
  next.myBoosts = { ...(next.myBoosts ?? {}) };
  for (const a of draftActions) {
    if (a.kind !== 'switch' || a.targetTeamIndex == null) continue;
    if (a.side === 'mine') {
      const outgoing = nextActive.mine[a.attackerSlot];
      if (outgoing != null) {
        if (toId(next.myTeam[outgoing]?.ability ?? '') === 'regenerator') {
          next.myCurrentHp = next.myCurrentHp ?? {};
          next.myCurrentHp[outgoing] = Math.min(100, (next.myCurrentHp[outgoing] ?? 100) + 100 / 3);
        }
        delete next.myBoosts[outgoing]; clearMyVolatiles(next, outgoing);
      }
      nextActive.mine[a.attackerSlot] = a.targetTeamIndex;
    } else {
      const outgoing = nextActive.theirs[a.attackerSlot];
      if (outgoing != null && next.opponentTeam[outgoing]) {
        const o = { ...next.opponentTeam[outgoing], currentBoosts: {} };
        if (o.ability && toId(o.ability) === 'regenerator') {
          o.currentHpPercent = Math.min(100, (o.currentHpPercent ?? 100) + 100 / 3);
        }
        clearOppVolatiles(o);
        next.opponentTeam[outgoing] = o;
      }
      nextActive.theirs[a.attackerSlot] = a.targetTeamIndex;
    }
    applyHazardOnSwitchInto(next, a.side, a.targetTeamIndex);
    inferenceNotes.push(...applySwitchInAbility(next, a.side, a.targetTeamIndex, nextActive));
  }

  // End-of-turn effects.
  const eotResult = endOfTurn(next, field, nextActive);
  next = eotResult.match;

  // Clear emptied active slots after auto-faint.
  for (let i = 0; i < 2; i++) {
    const slot = i as 0 | 1;
    const mIdx = nextActive.mine[slot];
    if (mIdx != null && next.myFainted!.includes(mIdx)) nextActive.mine[slot] = null;
    const tIdx = nextActive.theirs[slot];
    if (tIdx != null && next.opponentTeam[tIdx]?.fainted) nextActive.theirs[slot] = null;
  }

  next.outcome = detectOutcome(next);

  return { match: next, activeIdx: nextActive, inferenceNotes, eotNotes: eotResult.notes };
}

// ---------------- applyStateUpdate ----------------

export interface ApplyStateInput {
  match: Match;
  update: StateUpdate | HazardUpdate;
  activeIdx: ActiveIdx;
}

export interface ApplyStateResult {
  match: Match;
  activeIdx: ActiveIdx;
}

function isHazardUpdate(u: StateUpdate | HazardUpdate): u is HazardUpdate {
  return (u as HazardUpdate).verb !== undefined;
}

export function applyStateUpdate(input: ApplyStateInput): ApplyStateResult {
  if (isHazardUpdate(input.update)) {
    return applyHazardUpdateImpl(input.match, input.update, input.activeIdx);
  }
  return applyStateUpdateImpl(input.match, input.update, input.activeIdx);
}

function applyHazardUpdateImpl(
  match: Match,
  update: HazardUpdate,
  activeIdx: ActiveIdx,
): ApplyStateResult {
  const nextField: FieldState = { ...(match.field ?? NEUTRAL_FIELD) };
  if (update.side === 'mine') {
    nextField.myHazards = applyHazardVerb(nextField.myHazards, update.verb, update.arg);
  } else {
    nextField.theirHazards = applyHazardVerb(nextField.theirHazards, update.verb, update.arg);
  }
  const next: Match = { ...match, field: nextField };
  return {
    match: next,
    activeIdx: { mine: [activeIdx.mine[0], activeIdx.mine[1]], theirs: [activeIdx.theirs[0], activeIdx.theirs[1]] },
  };
}

function applyStateUpdateImpl(
  match: Match,
  update: StateUpdate,
  activeIdx: ActiveIdx,
): ApplyStateResult {
  const next: Match = {
    ...match,
    opponentTeam: match.opponentTeam.map(o => ({ ...o, currentBoosts: { ...(o.currentBoosts ?? {}) } })),
    myCurrentHp: { ...(match.myCurrentHp ?? {}) },
    myFainted: [...(match.myFainted ?? [])],
    myBoosts: { ...(match.myBoosts ?? {}) },
    myItemConsumed: { ...(match.myItemConsumed ?? {}) },
    myStatus: { ...(match.myStatus ?? {}) },
    myToxCounter: { ...(match.myToxCounter ?? {}) },
    mySleepCounter: { ...(match.mySleepCounter ?? {}) },
    myTaunted: [...(match.myTaunted ?? [])],
    myEncoreMove: { ...(match.myEncoreMove ?? {}) },
    myDisabledMove: { ...(match.myDisabledMove ?? {}) },
    myTauntTurns: { ...(match.myTauntTurns ?? {}) },
    myEncoreTurns: { ...(match.myEncoreTurns ?? {}) },
    myDisableTurns: { ...(match.myDisableTurns ?? {}) },
    myLeechSeeded: { ...(match.myLeechSeeded ?? {}) },
    mySaltCured: { ...(match.mySaltCured ?? {}) },
    myAquaRing: { ...(match.myAquaRing ?? {}) },
    myIngrain: { ...(match.myIngrain ?? {}) },
    myCursed: { ...(match.myCursed ?? {}) },
    myPartialTrap: { ...(match.myPartialTrap ?? {}) },
    myNightmare: { ...(match.myNightmare ?? {}) },
    myFlinched: { ...(match.myFlinched ?? {}) },
  };
  const nextActive: ActiveIdx = {
    mine: [activeIdx.mine[0], activeIdx.mine[1]],
    theirs: [activeIdx.theirs[0], activeIdx.theirs[1]],
  };

  const { side, teamIndex } = update;

  // Reveal/set a mon's ability (no /info). Canonicalise via the dex so downstream
  // (certainAbility / defiantStat / the calc's ability swap) sees the proper name.
  if (update.setAbility != null) {
    const ab = getAbility(update.setAbility);
    const canon = ab?.exists ? ab.name : update.setAbility;
    if (side === 'theirs') {
      const o = next.opponentTeam[teamIndex];
      if (o) o.ability = canon;
    } else {
      const s = next.myTeam[teamIndex];
      if (s) next.myTeam = next.myTeam.map((m, i) => (i === teamIndex ? { ...m, ability: canon } : m));
    }
  }

  if (update.hpPercent != null) {
    if (side === 'theirs') {
      const o = next.opponentTeam[teamIndex];
      if (o) o.currentHpPercent = update.hpPercent;
    } else {
      next.myCurrentHp![teamIndex] = update.hpPercent;
    }
  }
  if (update.hpRaw != null && side === 'mine') {
    const mySet = next.myTeam[teamIndex];
    const max = mySet ? maxHpFor(mySet) : 0;
    const pct = max > 0 ? Math.max(0, Math.min(100, (update.hpRaw / max) * 100)) : 0;
    next.myCurrentHp![teamIndex] = pct;
  }

  const applyHealPct = (pct: number) => {
    if (side === 'theirs') {
      const o = next.opponentTeam[teamIndex];
      if (!o || o.fainted) return;
      const prev = o.currentHpPercent ?? 100;
      o.currentHpPercent = Math.max(0, Math.min(100, prev + pct));
    } else {
      if ((next.myFainted ?? []).includes(teamIndex)) return;
      const prev = next.myCurrentHp![teamIndex] ?? 100;
      next.myCurrentHp![teamIndex] = Math.max(0, Math.min(100, prev + pct));
    }
  };
  if (update.healPercent != null) applyHealPct(update.healPercent);
  if (update.healRaw != null && side === 'mine') {
    const mySet = next.myTeam[teamIndex];
    const max = mySet ? maxHpFor(mySet) : 0;
    if (max > 0) applyHealPct((update.healRaw / max) * 100);
  }
  if (update.namedHeal === 'sitrus') {
    applyHealPct(25);
    if (side === 'theirs') {
      const o = next.opponentTeam[teamIndex];
      if (o) o.itemConsumed = 'Sitrus Berry';
    } else {
      next.myItemConsumed![teamIndex] = 'Sitrus Berry';
    }
  }
  if (update.namedHeal === 'leftovers') {
    applyHealPct(100 / 16);                        // EOT Leftovers tick: +1/16 max HP
    if (side === 'theirs') {
      const o = next.opponentTeam[teamIndex];
      if (o) o.item = 'Leftovers';                 // confirm the held item (persistent — not consumed)
    }
  }

  const applyDamagePct = (pct: number) => {
    if (side === 'theirs') {
      const o = next.opponentTeam[teamIndex];
      if (!o) return;
      const prev = o.currentHpPercent ?? 100;
      const newHp = Math.max(0, prev - pct);
      o.currentHpPercent = newHp;
      if (newHp === 0) {
        o.fainted = true;
        if (nextActive.theirs[0] === teamIndex) nextActive.theirs[0] = null;
        if (nextActive.theirs[1] === teamIndex) nextActive.theirs[1] = null;
      }
    } else {
      const prev = next.myCurrentHp![teamIndex] ?? 100;
      const newHp = Math.max(0, prev - pct);
      next.myCurrentHp![teamIndex] = newHp;
      if (newHp === 0 && !next.myFainted!.includes(teamIndex)) {
        next.myFainted!.push(teamIndex);
        if (nextActive.mine[0] === teamIndex) nextActive.mine[0] = null;
        if (nextActive.mine[1] === teamIndex) nextActive.mine[1] = null;
      }
    }
  };
  if (update.damagePercent != null) applyDamagePct(update.damagePercent);
  if (update.damageRaw != null && side === 'mine') {
    const mySet = next.myTeam[teamIndex];
    const max = mySet ? maxHpFor(mySet) : 0;
    if (max > 0) applyDamagePct((update.damageRaw / max) * 100);
  }

  if (update.boosts) {
    const clamp = (n: number) => Math.max(-6, Math.min(6, n));
    if (side === 'theirs') {
      const o = next.opponentTeam[teamIndex];
      if (o) {
        const cur = { ...(o.currentBoosts ?? {}) };
        for (const [stat, delta] of Object.entries(update.boosts)) {
          (cur as any)[stat] = clamp(((cur as any)[stat] ?? 0) + (delta ?? 0));
        }
        o.currentBoosts = cur;
      }
    } else {
      const cur = { ...(next.myBoosts![teamIndex] ?? {}) };
      for (const [stat, delta] of Object.entries(update.boosts)) {
        (cur as any)[stat] = clamp(((cur as any)[stat] ?? 0) + (delta ?? 0));
      }
      next.myBoosts![teamIndex] = cur;
    }
  }

  if (update.namedTrigger === 'wp') {
    const clamp = (n: number) => Math.max(-6, Math.min(6, n));
    if (side === 'theirs') {
      const o = next.opponentTeam[teamIndex];
      if (o) {
        const cur = { ...(o.currentBoosts ?? {}) };
        cur.atk = clamp((cur.atk ?? 0) + 2);
        cur.spa = clamp((cur.spa ?? 0) + 2);
        o.currentBoosts = cur;
        o.itemConsumed = 'Weakness Policy';
      }
    } else {
      const cur = { ...(next.myBoosts![teamIndex] ?? {}) };
      cur.atk = clamp((cur.atk ?? 0) + 2);
      cur.spa = clamp((cur.spa ?? 0) + 2);
      next.myBoosts![teamIndex] = cur;
      next.myItemConsumed![teamIndex] = 'Weakness Policy';
    }
  }
  if (update.namedTrigger === 'sash') {
    if (side === 'theirs') {
      const o = next.opponentTeam[teamIndex];
      if (o) { o.currentHpPercent = 1; o.fainted = false; o.itemConsumed = 'Focus Sash'; }
    } else {
      const mySet = next.myTeam[teamIndex];
      const max = mySet ? maxHpFor(mySet) : 0;
      if (max > 0) next.myCurrentHp![teamIndex] = Math.max(1 / max * 100, 0.5);
      next.myFainted = (next.myFainted ?? []).filter(i => i !== teamIndex);
      next.myItemConsumed![teamIndex] = 'Focus Sash';
    }
  }
  if (update.namedTrigger === 'balloon') {
    if (side === 'theirs') {
      const o = next.opponentTeam[teamIndex];
      if (o) o.itemConsumed = 'Air Balloon';
    } else {
      next.myItemConsumed![teamIndex] = 'Air Balloon';
    }
  }

  if (update.status) {
    if (side === 'theirs') {
      const o = next.opponentTeam[teamIndex];
      if (o && tryApplyOppStatus(o, update.status)) {
        if (update.status === 'tox') o.toxCounter = 1;
        if (update.status === 'slp') o.sleepCounter = 2;
      }
    } else {
      if (tryApplyMyStatus(next, teamIndex, update.status)) {
        if (update.status === 'tox') next.myToxCounter![teamIndex] = 1;
        if (update.status === 'slp') next.mySleepCounter![teamIndex] = 2;
      }
    }
  }
  if (update.cureStatus) {
    if (side === 'theirs') {
      const o = next.opponentTeam[teamIndex];
      if (o) { o.status = undefined; o.toxCounter = undefined; o.sleepCounter = undefined; clearOppVolatiles(o); }
    } else {
      delete next.myStatus![teamIndex];
      delete next.myToxCounter![teamIndex];
      delete next.mySleepCounter?.[teamIndex];
      clearMyVolatiles(next, teamIndex);
    }
  }
  // Move-restricting volatiles (taunt / encore / disable).
  if (update.taunt || update.encoreMove != null || update.disableMove != null) {
    if (side === 'theirs') {
      const o = next.opponentTeam[teamIndex];
      if (o) {
        if (update.taunt) { o.taunted = true; o.tauntTurns = update.volatileTurns ?? EFFECT_DURATIONS.taunt; }
        if (update.encoreMove != null) { o.encoreMove = update.encoreMove; o.encoreTurns = update.volatileTurns ?? EFFECT_DURATIONS.encore; }
        if (update.disableMove != null) { o.disabledMove = update.disableMove; o.disableTurns = update.volatileTurns ?? EFFECT_DURATIONS.disable; }
      }
    } else {
      if (update.taunt) { if (!next.myTaunted!.includes(teamIndex)) next.myTaunted!.push(teamIndex); next.myTauntTurns![teamIndex] = update.volatileTurns ?? EFFECT_DURATIONS.taunt; }
      if (update.encoreMove != null) { next.myEncoreMove![teamIndex] = update.encoreMove; next.myEncoreTurns![teamIndex] = update.volatileTurns ?? EFFECT_DURATIONS.encore; }
      if (update.disableMove != null) { next.myDisabledMove![teamIndex] = update.disableMove; next.myDisableTurns![teamIndex] = update.volatileTurns ?? EFFECT_DURATIONS.disable; }
    }
  }
  // Residual-chip volatiles.
  if (update.saltCure) {
    if (side === 'theirs') { const o = next.opponentTeam[teamIndex]; if (o) o.saltCured = true; }
    else next.mySaltCured![teamIndex] = true;
  }
  if (update.aquaRing) {
    if (side === 'theirs') { const o = next.opponentTeam[teamIndex]; if (o) o.aquaRing = true; }
    else next.myAquaRing![teamIndex] = true;
  }
  if (update.ingrain) {
    if (side === 'theirs') { const o = next.opponentTeam[teamIndex]; if (o) o.ingrain = true; }
    else next.myIngrain![teamIndex] = true;
  }
  if (update.curse) {
    if (side === 'theirs') { const o = next.opponentTeam[teamIndex]; if (o) o.cursed = true; }
    else next.myCursed![teamIndex] = true;
  }
  if (update.partialTrap != null) {
    if (side === 'theirs') { const o = next.opponentTeam[teamIndex]; if (o) o.partialTrap = update.partialTrap; }
    else next.myPartialTrap![teamIndex] = update.partialTrap;
  }
  if (update.nightmare) {
    if (side === 'theirs') { const o = next.opponentTeam[teamIndex]; if (o) o.nightmare = true; }
    else next.myNightmare![teamIndex] = true;
  }
  if (update.perish != null) {
    if (side === 'theirs') { const o = next.opponentTeam[teamIndex]; if (o) o.perishCount = update.perish; }
    else { next.myPerishCount = { ...(next.myPerishCount ?? {}), [teamIndex]: update.perish }; }
  }
  if (update.flinch) {
    if (side === 'theirs') { const o = next.opponentTeam[teamIndex]; if (o) o.flinched = true; }
    else { next.myFlinched = { ...(next.myFlinched ?? {}) }; next.myFlinched[teamIndex] = true; }
  }

  if (update.fainted) {
    if (side === 'theirs') {
      const o = next.opponentTeam[teamIndex];
      if (o) { o.fainted = true; o.currentHpPercent = 0; }
      if (nextActive.theirs[0] === teamIndex) nextActive.theirs[0] = null;
      if (nextActive.theirs[1] === teamIndex) nextActive.theirs[1] = null;
    } else {
      if (!next.myFainted!.includes(teamIndex)) next.myFainted!.push(teamIndex);
      next.myCurrentHp![teamIndex] = 0;
      if (nextActive.mine[0] === teamIndex) nextActive.mine[0] = null;
      if (nextActive.mine[1] === teamIndex) nextActive.mine[1] = null;
    }
  }
  if (update.bringIntoSlot != null) {
    if (side === 'mine') {
      const outgoing = nextActive.mine[update.bringIntoSlot];
      if (outgoing != null) {
        if (toId(next.myTeam[outgoing]?.ability ?? '') === 'regenerator') {
          next.myCurrentHp = next.myCurrentHp ?? {};
          next.myCurrentHp[outgoing] = Math.min(100, (next.myCurrentHp[outgoing] ?? 100) + 100 / 3);
        }
        delete next.myBoosts![outgoing]; clearMyVolatiles(next, outgoing);
      }
      nextActive.mine[update.bringIntoSlot] = teamIndex;
    } else {
      const outgoing = nextActive.theirs[update.bringIntoSlot];
      if (outgoing != null) {
        const o = next.opponentTeam[outgoing];
        if (o) {
          if (o.ability && toId(o.ability) === 'regenerator') {
            o.currentHpPercent = Math.min(100, (o.currentHpPercent ?? 100) + 100 / 3);
          }
          o.currentBoosts = {}; clearOppVolatiles(o);
        }
      }
      nextActive.theirs[update.bringIntoSlot] = teamIndex;
      const brought = new Set(next.opponentBrought ?? []);
      brought.add(teamIndex as any);
      next.opponentBrought = [...brought].sort((a, b) => a - b) as Match['opponentBrought'];
    }
    applyHazardOnSwitchInto(next, side, teamIndex);
    applySwitchInAbility(next, side, teamIndex, nextActive);
  }

  next.outcome = detectOutcome(next);

  return { match: next, activeIdx: nextActive };
}
