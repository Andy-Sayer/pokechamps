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
import { inferSpread } from '../domain/inference.js';
import { maxHpFor } from '../domain/damage.js';
import { endOfTurn } from '../domain/endOfTurn.js';
import { inferOpponentSpeeds, applySpeedInference } from '../domain/speed.js';
import {
  applyHazardVerb,
  applyHazardsToSwitchIn,
  absorbsToxicSpikes,
} from '../domain/hazards.js';
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
      match.myStatus = { ...(match.myStatus ?? {}), [teamIndex]: effect.statusApplied };
      if (effect.statusApplied === 'tox') {
        match.myToxCounter = { ...(match.myToxCounter ?? {}), [teamIndex]: 1 };
      }
    } else {
      const o = match.opponentTeam[teamIndex];
      if (o) {
        o.status = effect.statusApplied;
        if (effect.statusApplied === 'tox') o.toxCounter = 1;
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
  };

  // Walk damaging actions in order, deriving each action's damageHpPercent
  // from previous-vs-remaining HP (per-target running HP for multi-hit turns).
  const oppHpSoFar = new Map<number, number>();
  const myHpSoFar = new Map<number, number>();
  const sortedActions = [...draftActions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const a of sortedActions) {
    if (a.kind === 'switch') continue;
    if (typeof a.target !== 'object') continue;
    const tIdx = a.targetTeamIndex;
    if (tIdx == null) continue;
    const tSide = a.target.side;
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

    a.damageHpPercent = Math.max(0, prevPct - newPct);
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

  // Update knownMoves + megaUsed on every opp that acted this turn.
  next.opponentTeam = next.opponentTeam.map(o => ({ ...o }));
  for (const a of draftActions) {
    if (a.side !== 'theirs' || a.kind === 'switch') continue;
    const idx = a.attackerTeamIndex;
    if (idx == null) continue;
    const entry = next.opponentTeam[idx];
    if (!entry) continue;
    if (!entry.knownMoves.includes(a.move)) {
      entry.knownMoves = [...entry.knownMoves, a.move];
    }
    if (a.mega) entry.megaUsed = true;
  }

  // Damage inference for every mine→theirs damaging action.
  const inferenceNotes: string[] = [];
  for (const a of draftActions) {
    if (a.kind === 'switch') continue;
    if (a.side !== 'mine') continue;
    if (a.damageHpPercent == null && a.damageRaw == null) continue;
    if (typeof a.target !== 'object' || a.target.side !== 'theirs') continue;
    const attackerSet = next.myTeam[a.attackerTeamIndex ?? -1];
    const oppIdx = a.targetTeamIndex;
    if (!attackerSet || oppIdx == null) continue;
    const opp = next.opponentTeam[oppIdx];
    if (!opp) continue;
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
    };
    try {
      const candidates = inferSpread({
        defenderSpecies: opp.species,
        defenderLevel: attackerSet.level,
        knownDefenderMoves: opp.knownMoves,
        attackerSet,
        observation: obs,
        startingCandidates: opp.candidates?.length
          ? opp.candidates.map(c => ({ evs: c.evs, nature: c.nature, item: c.item, ability: c.ability }))
          : undefined,
        // Server keeps response latency bounded by skipping the ~360k-spread
        // coarse fallback. If priors don't match, we accept an empty candidate
        // list — the client can re-run with quickOnly off later if needed.
        quickOnly: true,
      });
      const candidateSets: PokemonSet[] = candidates.map(c => ({
        species: opp.species,
        level: attackerSet.level,
        item: c.item,
        ability: c.ability,
        nature: c.nature,
        evs: c.evs,
        ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
        moves: opp.knownMoves,
      }));
      next.opponentTeam[oppIdx] = { ...opp, candidates: candidateSets };
      inferenceNotes.push(`${opp.species}: ${candidateSets.length} spread(s)`);
    } catch {
      inferenceNotes.push(`${opp.species}: inference failed`);
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
      if (outgoing != null) delete next.myBoosts[outgoing];
      nextActive.mine[a.attackerSlot] = a.targetTeamIndex;
    } else {
      const outgoing = nextActive.theirs[a.attackerSlot];
      if (outgoing != null && next.opponentTeam[outgoing]) {
        next.opponentTeam[outgoing] = { ...next.opponentTeam[outgoing], currentBoosts: {} };
      }
      nextActive.theirs[a.attackerSlot] = a.targetTeamIndex;
    }
    applyHazardOnSwitchInto(next, a.side, a.targetTeamIndex);
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
  };
  const nextActive: ActiveIdx = {
    mine: [activeIdx.mine[0], activeIdx.mine[1]],
    theirs: [activeIdx.theirs[0], activeIdx.theirs[1]],
  };

  const { side, teamIndex } = update;

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
      if (o) {
        o.status = update.status;
        if (update.status === 'tox') o.toxCounter = 1;
        if (update.status === 'slp') o.sleepCounter = 2;
      }
    } else {
      next.myStatus![teamIndex] = update.status;
      if (update.status === 'tox') next.myToxCounter![teamIndex] = 1;
      if (update.status === 'slp') next.mySleepCounter![teamIndex] = 2;
    }
  }
  if (update.cureStatus) {
    if (side === 'theirs') {
      const o = next.opponentTeam[teamIndex];
      if (o) { o.status = undefined; o.toxCounter = undefined; o.sleepCounter = undefined; }
    } else {
      delete next.myStatus![teamIndex];
      delete next.myToxCounter![teamIndex];
      delete next.mySleepCounter?.[teamIndex];
    }
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
  if (update.megaActivated) {
    if (side === 'mine') {
      const list = next.myMegaUsed ? [...next.myMegaUsed] : [];
      if (!list.includes(teamIndex)) list.push(teamIndex);
      next.myMegaUsed = list;
    } else {
      const o = next.opponentTeam[teamIndex];
      if (o) o.megaUsed = true;
    }
  }
  if (update.bringIntoSlot != null) {
    if (side === 'mine') {
      const outgoing = nextActive.mine[update.bringIntoSlot];
      if (outgoing != null) delete next.myBoosts![outgoing];
      nextActive.mine[update.bringIntoSlot] = teamIndex;
    } else {
      const outgoing = nextActive.theirs[update.bringIntoSlot];
      if (outgoing != null) {
        const o = next.opponentTeam[outgoing];
        if (o) o.currentBoosts = {};
      }
      nextActive.theirs[update.bringIntoSlot] = teamIndex;
      const brought = new Set(next.opponentBrought ?? []);
      brought.add(teamIndex as any);
      next.opponentBrought = [...brought].sort((a, b) => a - b) as Match['opponentBrought'];
    }
    applyHazardOnSwitchInto(next, side, teamIndex);
  }

  next.outcome = detectOutcome(next);

  return { match: next, activeIdx: nextActive };
}
