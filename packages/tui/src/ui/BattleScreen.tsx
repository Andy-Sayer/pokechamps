import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import type { Match, FieldState, DamageObservation, MoveAction, OpponentEntry, PokemonSet } from '@pokechamps/core/domain/types.js';
import { NEUTRAL_FIELD } from '@pokechamps/core/domain/types.js';
import { scoreSpread, scoreOffensiveSpread, mostLikely, recoilDrainHpEvs, reconcileCandidates } from '@pokechamps/core/domain/inference.js';
import { computeActionBoostContexts } from '@pokechamps/core/domain/turnBoosts.js';
import { maxHpFor } from '@pokechamps/core/domain/damage.js';
import { endOfTurn } from '@pokechamps/core/domain/endOfTurn.js';
import { inferOpponentSpeeds, applySpeedInference, actualSpeed, predictTurnOrder, effectiveSpeedRange } from '@pokechamps/core/domain/speed.js';
import { reviewLastTurn } from '@pokechamps/core/ai/prompts.js';
import { isAvailable as aiAvailable } from '@pokechamps/core/ai/client.js';
import type { Stores } from '@pokechamps/core/storage/index.js';
import { getSpecies, getMove, toId, isChargeMove, isPivotMove, isItemRemovingMove, isItemSwapMove, isSpreadMove, moveFlinchChance } from '@pokechamps/core/domain/data.js';
import { defaultOpponentSet } from '@pokechamps/core/domain/bring.js';
import { parseTurnLine, type ParseContext, type StateUpdate, type HazardUpdate } from '@pokechamps/core/domain/turnparser.js';
import { applyHazardVerb, applyHazardsToSwitchIn, absorbsToxicSpikes, hazardGlyphs, hazardClearEffect, applyHazardClear } from '@pokechamps/core/domain/hazards.js';
import { fieldMoveEffect, applyFieldMove } from '@pokechamps/core/domain/fieldMoves.js';
import { EFFECT_DURATIONS } from '@pokechamps/core/domain/durations.js';
import { detectChoiceLock, sashProcced, firstTurnOut, isFirstTurnMove, type ChoiceLock } from '@pokechamps/core/domain/itemSignals.js';
import { hpItemTriggerFor } from '@pokechamps/core/domain/hpItemTriggers.js';
import { statusBerryFor } from '@pokechamps/core/domain/statusBerries.js';
import { resistBerryForType } from '@pokechamps/core/domain/resistBerries.js';
import { effectiveness, speciesTypes } from '@pokechamps/core/domain/typechart.js';
import { switchInAbilityEffect, intimidateReaction, certainAbility, resolveDownloadBoost, type BoostMap } from '@pokechamps/core/domain/abilities.js';
import { deriveSuggestionContext, getSuggestions, applySuggestion, type SuggestionKind } from '@pokechamps/core/domain/actionSuggest.js';
import { predictOffense, predictOffenseAll, predictThreat, predictThreatAll, speedVerdict, type SpeedVerdict, type MatchupCell, type Confidence } from '@pokechamps/core/domain/predictions.js';
import { PikaSpinner } from './PikaSpinner.js';
import { ExportPanel } from './ExportPanel.js';
import { OverridePanel } from './OverridePanel.js';
import { MatchSummary } from './MatchSummary.js';
import { formatShowdownTeamSP } from '@pokechamps/core/domain/showdown.js';
import { BATTLE_COMMANDS, parseCommand, type BattleCommandId } from './slashCommands.js';
import { deriveActiveIdx } from '@pokechamps/core/match/engine.js';
import { applyMegaAction } from '@pokechamps/core/domain/megaResolve.js';
import { getMegaOptions } from '@pokechamps/core/domain/gimmicks/mega.js';
import { solveEndgame } from '@pokechamps/core/domain/endgame.js';
import type { EndgamePosition } from '@pokechamps/core/domain/endgame.js';
import { createSearch, searchInputFromMatch, oppCanMega, wideningSchedule, type SearchResult } from '@pokechamps/core/domain/endgameSearch.js';

export interface BattleScreenProps {
  stores: Stores;
  match: Match;
  // Optional `intent` lets the user pick "new match" from the match-end
  // menu and have the parent route accordingly. Default behaviour is back
  // to main menu.
  onEnd: (intent?: 'menu' | 'new-match') => void;
  // Spectator mode: render the full host viewpoint read-only. The parent feeds
  // live state by passing a fresh `match` prop on each WS frame (synced into
  // local state below); input + commands are disabled and a banner replaces the
  // turn composer. We only add a read path — finalizeTurn is never called here,
  // so the host path is untouched. See docs/notes/live-share-plan.md.
  spectator?: boolean;
  // One-line connection status for the spectator banner ('● live' etc.).
  spectatorLabel?: string;
}

// fire-and-forget snapshot save with an error surface via setMessage. Local
// file writes shouldn't block the UI, but we want save failures to be loud.
function saveMatchAsync(stores: Stores, match: Match, setMessage: (s: string) => void): void {
  void stores.matches.update(match.id, match).catch(err => {
    setMessage(`Save failed: ${err?.message ?? err}`);
  });
}

// Eligible replacements for a given side+slot: team mons that aren't fainted
// and aren't currently in the other active slot. For my side we restrict
// further to the chosen `bring` list (you can't send in a mon you didn't bring).
function eligibleReplacements(
  side: 'mine' | 'theirs',
  slot: 0 | 1,
  match: Match,
  active: { mine: [number | null, number | null]; theirs: [number | null, number | null] },
): Array<{ teamIndex: number; species: string }> {
  if (side === 'mine') {
    const otherSlot = active.mine[slot === 0 ? 1 : 0];
    const fainted = new Set(match.myFainted ?? []);
    const bring = new Set(match.bring);
    return match.myTeam
      .map((m, i) => ({ teamIndex: i, species: m.species }))
      .filter(x => bring.has(x.teamIndex as any) && !fainted.has(x.teamIndex) && x.teamIndex !== otherSlot);
  }
  const otherSlot = active.theirs[slot === 0 ? 1 : 0];
  return match.opponentTeam
    .map((o, i) => ({ teamIndex: i, species: o.species, fainted: !!o.fainted }))
    .filter(x => !x.fainted && x.teamIndex !== otherSlot);
}

// Apply on-switch hazards to the side receiving the incoming mon. Mutates
// the match in place: subtracts HP%, may apply status / boosts, clears
// toxic-spikes layers when a Poison-type absorbs them.
function applyHazardOnSwitchInto(match: Match, side: 'mine' | 'theirs', teamIndex: number) {
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
      if (tryApplyMyStatusInto(match, teamIndex, effect.statusApplied) && effect.statusApplied === 'tox') {
        match.myToxCounter = { ...(match.myToxCounter ?? {}), [teamIndex]: 1 };
      }
    } else {
      const o = match.opponentTeam[teamIndex];
      if (o && tryApplyOppStatusInto(o, effect.statusApplied) && effect.statusApplied === 'tox') {
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
  // Poison-type absorbs toxic spikes on entry.
  if (absorbsToxicSpikes({ species: incoming.species })) {
    if (side === 'mine' && match.field?.myHazards?.toxicSpikes) {
      match.field = { ...match.field, myHazards: { ...match.field.myHazards, toxicSpikes: 0 } };
    } else if (side === 'theirs' && match.field?.theirHazards?.toxicSpikes) {
      match.field = { ...match.field, theirHazards: { ...match.field.theirHazards, toxicSpikes: 0 } };
    }
  }
}

// Status-berry interception on my side. Returns true if status was applied
// (caller still owns tox/sleep counter setup); false if the berry caught it.
function tryApplyMyStatusInto(
  match: Match,
  teamIndex: number,
  status: NonNullable<import('@pokechamps/core/domain/types.js').ActivePokemonState['status']>,
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

// Opp-side mirror. Only catches when opp's item is known (else we set status
// directly — auto-firing a guess would silently corrupt downstream inference).
function tryApplyOppStatusInto(
  o: OpponentEntry,
  status: NonNullable<import('@pokechamps/core/domain/types.js').ActivePokemonState['status']>,
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
// to (side, teamIndex). Mirror of applyLoggedStatus in engine.ts: routes through the
// berry interception, sets tox/slp counters, skips an already-statused mon.
function applyLoggedStatusInto(
  match: Match,
  side: 'mine' | 'theirs',
  teamIndex: number,
  status: NonNullable<import('@pokechamps/core/domain/types.js').ActivePokemonState['status']>,
): void {
  if (side === 'mine') {
    if (match.myStatus?.[teamIndex]) return;
    if (tryApplyMyStatusInto(match, teamIndex, status)) {
      if (status === 'tox') match.myToxCounter = { ...(match.myToxCounter ?? {}), [teamIndex]: 1 };
      if (status === 'slp') match.mySleepCounter = { ...(match.mySleepCounter ?? {}), [teamIndex]: 3 };
    }
  } else {
    const o = match.opponentTeam[teamIndex];
    if (!o || o.status) return;
    if (tryApplyOppStatusInto(o, status)) {
      if (status === 'tox') o.toxCounter = 1;
      if (status === 'slp') o.sleepCounter = 3;
    }
  }
}

// Type-based immunity for a status move. Mirrors isStatusMoveImmune in engine.ts.
function isStatusMoveImmune(status: string, ignoreImmunity: boolean, isPowder: boolean, targetTypes: string[]): boolean {
  if (status === 'brn') return targetTypes.includes('Fire');
  if (status === 'par' && !ignoreImmunity) return targetTypes.includes('Electric');
  if (status === 'psn' || status === 'tox') return targetTypes.some(t => t === 'Poison' || t === 'Steel');
  if (status === 'slp' && isPowder) return targetTypes.includes('Grass');
  return false;
}

// Merge a boost map into a side's active boosts, clamped to [-6, +6].
function applyBoostsInto(match: Match, side: 'mine' | 'theirs', teamIndex: number, boosts: BoostMap) {
  const clamp = (n: number) => Math.max(-6, Math.min(6, n));
  if (side === 'mine') {
    const cur = { ...(match.myBoosts?.[teamIndex] ?? {}) };
    for (const [stat, delta] of Object.entries(boosts)) (cur as any)[stat] = clamp(((cur as any)[stat] ?? 0) + (delta ?? 0));
    match.myBoosts = { ...(match.myBoosts ?? {}), [teamIndex]: cur };
  } else {
    const o = match.opponentTeam[teamIndex];
    if (!o) return;
    const cur = { ...(o.currentBoosts ?? {}) };
    for (const [stat, delta] of Object.entries(boosts)) (cur as any)[stat] = clamp(((cur as any)[stat] ?? 0) + (delta ?? 0));
    o.currentBoosts = cur;
  }
}

// Switch-in ability triggers (A.2). Mirror of engine.applySwitchInAbility —
// applies Intimidate / weather / terrain / self-boosts when a mon enters a
// slot. `active` must already reflect this switch. Returns user-facing notes.
function applySwitchInAbilityInto(
  match: Match,
  side: 'mine' | 'theirs',
  teamIndex: number,
  active: { mine: [number | null, number | null]; theirs: [number | null, number | null] },
): string[] {
  const notes: string[] = [];
  const incoming = side === 'mine' ? match.myTeam[teamIndex] : match.opponentTeam[teamIndex];
  if (!incoming) return notes;
  const knownAbility = side === 'mine' ? (incoming as PokemonSet).ability : (incoming as OpponentEntry).ability;
  const ability = certainAbility({ knownAbility, species: incoming.species });
  const effect = switchInAbilityEffect(ability);
  if (!effect) return notes;

  if (effect.weather || effect.terrain) {
    const f: FieldState = { ...(match.field ?? NEUTRAL_FIELD) };
    if (effect.weather) { f.weather = effect.weather; f.weatherTurns = EFFECT_DURATIONS.weather; notes.push(`${incoming.species}'s ${ability} set ${effect.weather}`); }
    if (effect.terrain) { f.terrain = effect.terrain; notes.push(`${incoming.species}'s ${ability} set ${effect.terrain} Terrain`); }
    match.field = f;
  }
  if (effect.selfBoosts) {
    applyBoostsInto(match, side, teamIndex, effect.selfBoosts);
    notes.push(`${incoming.species}'s ${ability} boosted itself`);
  }
  if (effect.intimidate) {
    const foeSide: 'mine' | 'theirs' = side === 'mine' ? 'theirs' : 'mine';
    const foeSlots = foeSide === 'mine' ? active.mine : active.theirs;
    for (const foeIdx of foeSlots) {
      if (foeIdx == null) continue;
      const foeAbility = foeSide === 'mine'
        ? match.myTeam[foeIdx]?.ability
        : certainAbility({ knownAbility: match.opponentTeam[foeIdx]?.ability, species: match.opponentTeam[foeIdx]?.species ?? '' });
      const reaction = intimidateReaction(foeAbility);
      if (!reaction.blocked) applyBoostsInto(match, foeSide, foeIdx, { atk: -1 });
      if (reaction.reaction) applyBoostsInto(match, foeSide, foeIdx, reaction.reaction);
    }
    notes.push(`${incoming.species}'s Intimidate lowered foe Attack`);
  }
  // Download: +1 Atk or +1 SpA vs the first foe's lower base defense.
  if (effect.download) {
    const foeSide: 'mine' | 'theirs' = side === 'mine' ? 'theirs' : 'mine';
    const foeSlots = foeSide === 'mine' ? active.mine : active.theirs;
    for (const foeIdx of foeSlots) {
      if (foeIdx == null) continue;
      const foe = foeSide === 'mine' ? match.myTeam[foeIdx] : match.opponentTeam[foeIdx];
      if (!foe) continue;
      const baseStats = (getSpecies(foe.species) as any)?.stats ?? {};
      const boost = resolveDownloadBoost(baseStats.def ?? 100, baseStats.spd ?? 100);
      applyBoostsInto(match, side, teamIndex, { [boost.stat]: 1 });
      notes.push(`${incoming.species}'s Download boosted its ${boost.stat === 'atk' ? 'Attack' : 'Sp. Atk'}`);
      break;
    }
  }
  // Trace: copy the first foe's ability on switch-in.
  if (effect.trace) {
    const foeSide: 'mine' | 'theirs' = side === 'mine' ? 'theirs' : 'mine';
    const foeSlots = foeSide === 'mine' ? active.mine : active.theirs;
    for (const foeIdx of foeSlots) {
      if (foeIdx == null) continue;
      const foe = foeSide === 'mine' ? match.myTeam[foeIdx] : match.opponentTeam[foeIdx];
      if (!foe) continue;
      const foeAbility = side === 'mine'
        ? (foe as OpponentEntry).ability
        : (foe as PokemonSet).ability;
      if (foeAbility) {
        if (side === 'mine') (match.myTeam[teamIndex] as any).ability = foeAbility;
        else (match.opponentTeam[teamIndex] as any).ability = foeAbility;
        notes.push(`${incoming.species}'s Trace copied ${foe.species}'s ${foeAbility}`);
      }
      break;
    }
  }
  return notes;
}

// Detect match outcome from faint counts. Mine ends when all brought mons
// are fainted (always 4); opp ends when 4 distinct opps have fainted OR
// when every revealed brought opp is down (whichever is sooner). Ties when
// both sides hit zero on the same call.
function detectOutcome(match: Match): 'victory' | 'defeat' | 'tie' | undefined {
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

// Walk both sides; return the first empty active slot that has any eligible
// replacement, or null if everything's filled or there's no one to send in.
function findPendingReplacement(
  match: Match,
  active: { mine: [number | null, number | null]; theirs: [number | null, number | null] },
): { side: 'mine' | 'theirs'; slot: 0 | 1 } | null {
  for (const side of ['mine', 'theirs'] as const) {
    for (const slot of [0, 1] as const) {
      const here = side === 'mine' ? active.mine[slot] : active.theirs[slot];
      if (here != null) continue;
      if (eligibleReplacements(side, slot, match, active).length > 0) {
        return { side, slot };
      }
    }
  }
  return null;
}

// Initial active slots: my first 2 bring slots, plus opp's 2 visible leads.
function initialActiveIndices(match: Match): {
  mine: [number | null, number | null];
  theirs: [number | null, number | null];
} {
  const m0 = match.bring[0] ?? null;
  const m1 = match.bring[1] ?? null;
  const leads = match.opponentBrought ?? [];
  const t0 = leads[0] ?? null;
  const t1 = leads[1] ?? null;
  return { mine: [m0, m1], theirs: [t0, t1] };
}

function shortName(name: string, width = 12): string {
  return name.length <= width ? name : name.slice(0, width);
}

// /ask <lhs> vs <rhs>. Each side can be a slot ref (m1/m2 for my actives or
// any m1..m6 for team members, o1..o6 for opp slots) or a raw species name
// (autocompletes via dex). Optional `+mega` / `+megax` / `+megay` suffix
// forces the post-mega forme. Returns either an error string or a multi-line
// prediction summary — both go straight into setMessage.
//
// This is read-only — no match state changes. Intentional: the user wants to
// scout a hypothetical without rewinding or "what-iffing" the current turn.
export function runAskCommand(
  args: string,
  match: Match,
  activeIdx: { mine: [number | null, number | null]; theirs: [number | null, number | null] },
  field: FieldState,
): string {
  if (!args) {
    return '/ask <mine> vs <opp>  e.g. /ask m1+mega vs o3  or  /ask Delphox-Mega vs Sneasler';
  }
  const parts = args.split(/\s+vs\s+|\s+v\s+/i);
  if (parts.length !== 2) {
    return 'Expected "<mine> vs <opp>" — separator must be "vs".';
  }
  const mine = resolveAskSide(parts[0]!.trim(), 'mine', match, activeIdx);
  if (typeof mine === 'string') return `LHS: ${mine}`;
  const opp = resolveAskSide(parts[1]!.trim(), 'theirs', match, activeIdx);
  if (typeof opp === 'string') return `RHS: ${opp}`;

  // Mega is a decision, not a fixed forme: when my side holds a stone and the
  // user didn't already force +mega, show BOTH formes so they can judge whether
  // popping mega is worth it. Same for the opponent's potential mega.
  const myCanMega = !mine.megaActive && !!mine.megaForme;
  const oppMegaOpts = getMegaOptions(opp.entry.species);
  // Only offer the opp-mega comparison when it could actually hold the stone
  // (oppCanMega rules out a known/inferred non-stone item).
  const oppMega = !opp.megaActive && oppMegaOpts.length > 0 && !opp.entry.megaUsed && oppCanMega(opp.entry);

  // All of MY moves vs this foe, base + (when available) the post-mega forme,
  // zipped by move name so each line can show "X-Y%  ⭢mega X-Y%".
  const myMoves = predictOffenseAll({
    attacker: mine.set, opponent: opp.entry, field,
    attackerGimmickActive: mine.megaActive, defenderGimmickActive: opp.megaActive,
  });
  // My mega is deterministic (the held stone), so a single forme.
  const myMegaByMove = new Map<string, { cell: MatchupCell; variant: string }>();
  if (myCanMega) {
    const myVariant = getMegaOptions(mine.set.species).find(o => o.forme === mine.megaForme)?.variant ?? '';
    for (const c of predictOffenseAll({
      attacker: mine.set, opponent: opp.entry, field,
      attackerGimmickActive: true, defenderGimmickActive: opp.megaActive,
    })) myMegaByMove.set(c.move, { cell: c, variant: myVariant });
  }

  // The opponent's EXPECTED moves vs me (revealed, else Pikalytics), base +
  // (when the opp could still mega) the post-mega forme.
  const oppThreats = predictThreatAll({
    opponent: opp.entry, defender: mine.set, field,
    attackerGimmickActive: opp.megaActive, defenderGimmickActive: mine.megaActive,
  });
  // We don't know WHICH stone the opp runs. For a dual-mega species (Charizard
  // X/Y) the formes can swing a move's damage in opposite directions, so take
  // the WORST-case forme per move (highest damage to me) and label it — never
  // assume the first option, which can badly understate the mega threat.
  const oppMegaByMove = new Map<string, { cell: MatchupCell; variant: string }>();
  if (oppMega) {
    const baseCands = opp.entry.candidates?.length ? opp.entry.candidates : [defaultOpponentSet(opp.entry, 50)];
    for (const optn of oppMegaOpts) {
      const megaEntry: OpponentEntry = { ...opp.entry, candidates: baseCands.map(c => ({ ...c, item: optn.stone })) };
      for (const c of predictThreatAll({
        opponent: megaEntry, defender: mine.set, field,
        attackerGimmickActive: true, defenderGimmickActive: mine.megaActive,
      })) {
        const prev = oppMegaByMove.get(c.move);
        if (!prev || c.maxPercent > prev.cell.maxPercent) oppMegaByMove.set(c.move, { cell: c, variant: optn.variant });
      }
    }
  }

  const verdictTxt = (v: SpeedVerdict) =>
    v === 'faster' ? '✓ outspeed' : v === 'slower' ? '✗ outsped' :
    v === 'tie' ? '≈ tie' : v === 'scarf-flag' ? '⚡ scarf risk' : '? unknown';
  const sp = speedVerdict({ mySet: mine.set, opp: opp.entry, field, myFormeOverride: mine.megaActive ? mine.megaForme ?? undefined : undefined });
  const spMega = myCanMega ? speedVerdict({ mySet: mine.set, opp: opp.entry, field, myFormeOverride: mine.megaForme ?? undefined }) : null;
  const speedLine = `speed: ${verdictTxt(sp)}${spMega ? `  · mega ${verdictTxt(spMega)}` : ''}`;

  // One formatted line per move: range + KO odds, a conditional caveat, and the
  // post-mega range when it differs.
  const line = (c: MatchupCell, megaBy: Map<string, { cell: MatchupCell; variant: string }>): string => {
    const base = `${c.move.padEnd(14)} ${c.minPercent.toFixed(0)}-${c.maxPercent.toFixed(0)}% (${c.koChance})${c.conditional ? ` ⚠ ${c.conditional}` : ''}`;
    const m = megaBy.get(c.move);
    if (!m) return base;
    const tag = m.variant ? `mega-${m.variant.toUpperCase()}` : 'mega';
    return `${base}  ⭢${tag} ${m.cell.minPercent.toFixed(0)}-${m.cell.maxPercent.toFixed(0)}%`;
  };

  const megaNote = myCanMega ? `  (mega → ${mine.megaForme})` : '';
  const out: string[] = [`${mine.label} vs ${opp.label}${megaNote}`, `  ${speedLine}`];
  out.push('  → my moves:');
  if (myMoves.length || mine.set.moves.some(Boolean)) {
    out.push(...myMoves.map(c => `     ${line(c, myMegaByMove)}`));
    // predictOffenseAll only returns DAMAGING, computable moves — so an immune
    // matchup (Psychic into a Dark type) or a status move (Will-O-Wisp) silently
    // vanishes. List them anyway, tagged, so the FULL moveset is always visible.
    const shown = new Set(myMoves.map(c => c.move));
    for (const m of mine.set.moves) {
      if (!m || shown.has(m)) continue;
      shown.add(m);
      const cat = (getMove(m) as { category?: string } | undefined)?.category;
      out.push(`     ${m.padEnd(14)} ${cat === 'Status' ? '(status move)' : 'no effect here (0%)'}`);
    }
  } else {
    out.push('     (no moveset — query a team slot like m1 for move data)');
  }
  out.push(`  ← ${opp.entry.megaForme ?? opp.entry.species} ${opp.entry.knownMoves.length ? 'moves' : 'likely moves'}:`);
  out.push(...(oppThreats.length ? oppThreats.map(c => `     ${line(c, oppMegaByMove)}`) : ['     (no known or expected moves)']));
  return out.join('\n');
}

interface AskSide {
  set: PokemonSet;
  entry: OpponentEntry;
  megaActive: boolean;
  megaForme?: string;
  label: string;
}
function resolveAskSide(
  raw: string,
  side: 'mine' | 'theirs',
  match: Match,
  activeIdx: { mine: [number | null, number | null]; theirs: [number | null, number | null] },
): AskSide | string {
  if (!raw) return 'missing token';
  const megaMatch = raw.match(/\+mega(?:[xy])?$/i);
  const megaActive = !!megaMatch;
  const token = megaActive ? raw.slice(0, megaMatch!.index).trim() : raw;

  // Slot ref: m1..m6 or o1..o6.
  const refMatch = token.match(/^([mo])([1-6])$/i);
  if (refMatch) {
    const refSide = refMatch[1]!.toLowerCase() === 'm' ? 'mine' : 'theirs';
    if (refSide !== side) return `${token} is on the ${refSide} side, not ${side}`;
    const n = parseInt(refMatch[2]!, 10) - 1;
    if (refSide === 'mine') {
      const set = match.myTeam[n];
      if (!set) return `m${n + 1} not in your team`;
      const stone = getMegaOptions(set.species).find(o => o.stone === set.item);
      return { set, entry: synthOppEntry(set), megaActive, megaForme: stone?.forme, label: `m${n + 1} ${stone && megaActive ? stone.forme : set.species}` };
    }
    const opp = match.opponentTeam[n];
    if (!opp) return `o${n + 1} not on opponent team`;
    const oppSet = opp.candidates?.[0] ?? defaultOpponentSet(opp, 50);
    return { set: oppSet, entry: opp, megaActive, label: `o${n + 1} ${opp.megaForme ?? opp.species}` };
  }

  // Species name. Strip any "-Mega"/"-Mega-X" suffix; the gimmick layer
  // re-resolves the forme via the held stone + megaActive flag.
  const speciesName = token.replace(/-Mega(?:-[XY])?$/i, '');
  const sp: any = getSpecies(speciesName);
  if (!sp?.exists) return `unknown species: ${token}`;
  // For mine-side raw species: synthesize a strong default set (max offence).
  // For opp-side: build a synthetic OpponentEntry.
  const stone = getMegaOptions(sp.name).find(o => o.variant === '' || token.toLowerCase().includes('-mega-' + o.variant));
  // Pick a reasonable item: if the user named a -Mega species, attach the
  // matching stone so resolveSpecies + megaActive resolves correctly.
  const item = megaActive && stone ? stone.stone : undefined;
  const synth: PokemonSet = {
    species: sp.name,
    level: 50,
    item,
    ability: sp.abilities ? Object.values(sp.abilities)[0] as string : undefined,
    nature: 'Hardy',
    evs: { hp: 0, atk: 252, def: 0, spa: 252, spd: 4, spe: 0 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    moves: [],
  };
  if (side === 'mine') {
    return { set: synth, entry: synthOppEntry(synth), megaActive, megaForme: stone?.forme, label: `${megaActive && stone ? stone.forme : sp.name}` };
  }
  const entry: OpponentEntry = { species: sp.name, knownMoves: [] };
  return { set: synth, entry, megaActive, megaForme: stone?.forme, label: `${megaActive && stone ? stone.forme : sp.name}` };
}

// predictThreat needs an OpponentEntry shape even for mine-side scouting.
// Synthesize from a PokemonSet by treating the set itself as the only
// candidate and copying the basic fields.
function synthOppEntry(set: PokemonSet): OpponentEntry {
  return {
    species: set.species,
    item: set.item ?? null,
    ability: set.ability ?? null,
    knownMoves: set.moves,
    candidates: [set],
  };
}

export function BattleScreen({ stores, match: initial, onEnd, spectator = false, spectatorLabel }: BattleScreenProps) {
  const [match, setMatch] = useState<Match>(initial);
  const [input, setInput] = useState('');
  const [draftActions, setDraftActions] = useState<MoveAction[]>([]);
  // Boost lines logged DURING a turn join the turn's ordered timeline (instead of
  // applying immediately), so they take effect at their input position — a defense
  // boost logged after a hit doesn't retroactively change that hit's inference, and
  // one logged before a hit does. Applied at finalize; shown in the turn display.
  const [draftBoostEvents, setDraftBoostEvents] = useState<{ order: number; update: StateUpdate; raw: string }[]>([]);
  const [activeIdx, setActiveIdx] = useState(() => initialActiveIndices(initial));

  // Spectator mode: the parent re-renders us with a fresh `match` prop on every
  // live WS frame. Mirror it into local state (and re-derive the active slots
  // from the full turn history) so the read-only render tracks the host. In
  // host mode this effect never runs, so the local-edit path is untouched.
  useEffect(() => {
    if (!spectator) return;
    setMatch(initial);
    setActiveIdx(deriveActiveIdx(initial) as ReturnType<typeof initialActiveIndices>);
  }, [spectator, initial]);
  const [message, setMessage] = useState<string>('');
  // Index in the in-progress autocomplete suggestion list.
  const [highlight, setHighlight] = useState(0);
  // Bash-style Tab cycling: snapshot the stem + suggestion list on the first Tab
  // so repeated Tabs cycle through the options (re-applied to the same stem)
  // instead of re-completing the just-applied value. Reset when the user types.
  const tabCycle = useRef<{ stem: string; kind: SuggestionKind; list: string[]; idx: number } | null>(null);
  // Incremented on Tab-apply so the TextInput remounts and its internal
  // cursor jumps to the end of the new value. Without this the cursor stays
  // mid-string and the next character types in the wrong place.
  const [inputKey, setInputKey] = useState(0);
  // When a mon faints (auto or manual) and its active slot is now empty,
  // we prompt for a replacement before letting the user log anything else.
  // Holds the first pending {side, slot}; cleared when the user picks.
  const [pendingReplacement, setPendingReplacement] = useState<{ side: 'mine' | 'theirs'; slot: 0 | 1 } | null>(null);
  // `i` opens an opp picker; selecting one sets this and renders the detail panel.
  const [infoPickerOpen, setInfoPickerOpen] = useState(false);
  const [infoOpenForOpp, setInfoOpenForOpp] = useState<number | null>(null);
  // `c` toggles a parallel offense-with-crit column on the matchup grid.
  const [showCrits, setShowCrits] = useState(false);
  // `a` expands the matchup grid to show ALL 4 of my moves per opp instead
  // of just the voted-best one. Off by default to keep the compact view.
  const [showAllMoves, setShowAllMoves] = useState(false);
  // `/help` overlay — full syntax cheat-sheet. Closes on Esc or the next
  // /help invocation.
  const [helpOpen, setHelpOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  // Moody reminder: Moody boosts a random stat every EOT (deterministic trigger,
  // random effect → we can't auto-apply it, but we CAN nudge you to log it).
  // `boostedThisTurn` keys (`side:teamIndex`) of mons that got a manual boost line
  // this turn, so the nudge suppresses once you've logged it; `moodyNagged` makes
  // the /next gate soft (warn once, then let the next /next through).
  const [boostedThisTurn, setBoostedThisTurn] = useState<Set<string>>(() => new Set());
  const [moodyNagged, setMoodyNagged] = useState(false);
  // `/pika` preview — toggles a standalone Pikachu sprite so the user can
  // confirm sixel rendering without firing the AI review.
  const [pikaPreview, setPikaPreview] = useState<'run' | 'idle' | null>(null);
  // `/export` overlay — shows the current team as a Showdown export so the
  // user can copy it without leaving the match. Esc closes.
  const [exportPanelText, setExportPanelText] = useState<string | null>(null);

  // /override — manual god-mode state editor overlay.
  const [overrideOpen, setOverrideOpen] = useState(false);
  // AI battle review (opt-in via `r`). Holds the rendered text and a busy flag.
  const [aiReview, setAiReview] = useState<string | null>(null);
  const [aiReviewBusy, setAiReviewBusy] = useState(false);
  // True while finalizeTurn is running — inference for off-meta opps can
  // take several seconds. We render a running-Pikachu spinner so the
  // user knows the app isn't stuck. Set via /next dispatch which schedules
  // the heavy work on the next tick so the spinner has a chance to paint.
  const [finalizing, setFinalizing] = useState(false);
  // Bump on each Pikalytics cache change so the UI re-derives suggestions /
  // OppRow content when a background fetch lands.
  const [pikTick, setPikTick] = useState(0);

  // Kick off background Pikalytics fetches for any opp species missing from
  // the cache, and subscribe to cache changes for re-renders.
  useEffect(() => {
    for (const opp of match.opponentTeam) {
      if (!stores.pikalytics.get(opp.species)) stores.pikalytics.fetchAndCache(opp.species);
    }
    return stores.pikalytics.onChange(() => setPikTick(t => t + 1));
  }, [match.opponentTeam, stores]);
  void pikTick; // exists only to trigger re-renders

  // Passive WebSocket reconciliation: when the backing store streams a newer
  // version of this match (e.g. another client wrote a turn), replace local
  // state. The httpStore subscribe forwards both the initial snapshot and
  // subsequent updates; fileStore.subscribe is a no-op so local mode is
  // unaffected. JSON-key comparison short-circuits the echo of our own saves.
  const lastAppliedKey = useRef<string>(JSON.stringify(initial));
  useEffect(() => {
    return stores.matches.subscribe(initial.id, incomingMatch => {
      const incomingKey = JSON.stringify(incomingMatch);
      if (incomingKey === lastAppliedKey.current) return;
      lastAppliedKey.current = incomingKey;
      setMatch(incomingMatch);
      setActiveIdx(deriveActiveIdx(incomingMatch));
    });
  }, [initial.id, stores]);

  const field: FieldState = match.field ?? NEUTRAL_FIELD;

  // Always-on background lookahead. Whenever the position changes, restart
  // iterative deepening (depth 1, 2, …) on a cooperative schedule — one depth
  // per macrotask so Ink stays responsive — and publish the improving best
  // play. Cancels on the next position change or unmount. See
  // docs/notes/endgame-search-plan.md.
  const [bestSearch, setBestSearch] = useState<SearchResult | null>(null);
  // The narrow+deep "work outwards" probe: a TENTATIVE read several plies past
  // what full breadth can afford on a wide board. Null in endgames (full is
  // already deep) or until the probe runs. Shown as a separate, clearly-tentative
  // line — never as the headline verdict.
  const [deepProbe, setDeepProbe] = useState<SearchResult | null>(null);
  // A cheap signature of everything the search depends on, so the effect only
  // re-runs when the board actually changes (not on every keystroke render).
  const posSig = useMemo(() => JSON.stringify([
    match.bring, match.opponentBrought, match.myCurrentHp, match.myFainted, match.myBoosts, match.myStatus,
    // Include inferred state — candidate count/spread + speed bounds + status —
    // so the search also re-runs when a damage/speed observation narrows the
    // belief without changing raw HP.
    match.opponentTeam.map(o => [
      o.species, o.currentHpPercent, o.fainted, o.status, o.speedFloor, o.speedCeiling,
      o.candidates?.length,
      o.candidates?.[0] && [o.candidates[0].evs.hp, o.candidates[0].evs.atk, o.candidates[0].evs.def, o.candidates[0].evs.spa, o.candidates[0].evs.spd, o.candidates[0].nature, o.candidates[0].item],
    ]),
    activeIdx, field.weather, field.terrain, field.trickRoom, field.myTailwind, field.theirTailwind,
    match.outcome,
  ]), [match, activeIdx, field]);
  useEffect(() => {
    if (match.outcome) { setBestSearch(null); setDeepProbe(null); return; }
    const input = searchInputFromMatch(match, activeIdx);
    const liveMine = input.mine.filter(m => m.hpPercent > 0).length;
    const liveOpp = input.opp.filter(o => o.hpPercent > 0).length;
    if (liveMine === 0 || liveOpp === 0) { setBestSearch(null); setDeepProbe(null); return; }

    // "Work outwards": step the widening schedule (endgame → one deep full pass;
    // wide board → fast full pass, then a narrow+deep probe). Each tier builds its
    // own matrices at its breadth and deepens cooperatively (one ply per macrotask
    // so Ink stays responsive). See wideningSchedule / endgame-search-plan.md.
    const tiers = wideningSchedule(liveMine + liveOpp);
    setDeepProbe(null);
    let cancelled = false;
    let ti = 0;
    let search = createSearch(input, tiers[0]!.breadth);
    let depth = 1;
    let prevVerdict: SearchResult['verdict'] | null = null;
    let stableFor = 0;
    let lastMs = 0, prevMs = 0;
    let tierStart = Date.now();
    const advanceTier = (): boolean => {
      if (++ti >= tiers.length) return false;
      search = createSearch(input, tiers[ti]!.breadth);
      depth = 1; prevVerdict = null; stableFor = 0; lastMs = 0; prevMs = 0;
      tierStart = Date.now();
      return true;
    };
    const step = () => {
      if (cancelled) return;
      const tier = tiers[ti]!;
      const t0 = Date.now();
      const res = search.toDepth(depth);
      if (cancelled) return;
      // Full-breadth pass = the authoritative verdict (may be `forced`); a restricted
      // pass = the tentative deep probe. Keep them in separate slots.
      if (res.breadth?.full) setBestSearch(res); else setDeepProbe(res);
      prevMs = lastMs; lastMs = Date.now() - t0;
      stableFor = res.verdict === prevVerdict ? stableFor + 1 : 0;
      prevVerdict = res.verdict;
      depth += 1;
      // A full-breadth FORCED outcome is the final word — no probe needed.
      if (res.forced) return;
      // A settled deep full verdict (held two plies past depth 5) ends the full tier.
      const settled = !!res.breadth?.full && depth > 5 && stableFor >= 2;
      // Affordability: full plies self-limit (depth grows the tree ~25×, so a check
      // against `lastMs` keeps us from launching a 60s ply); restricted probe plies
      // can still explode, so estimate the next from the observed growth ratio.
      const restricted = !res.breadth?.full;
      const ratio = prevMs > 0 ? Math.max(1, lastMs / prevMs) : 6;
      const estNext = restricted ? lastMs * ratio : lastMs;
      const tierElapsed = Date.now() - tierStart;
      const canDeepen = !settled && depth <= tier.maxDepth && tierElapsed + estNext <= tier.budgetMs;
      if (canDeepen) { setTimeout(step, 0); return; }
      if (advanceTier()) setTimeout(step, 0);   // tier exhausted → widen
    };
    const handle = setTimeout(step, 0);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [posSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const bringTeam = match.bring.map(i => match.myTeam[i]!);
  // Grows over the match — starts as the 2 leads, each opp switch may add
  // a new index up to a cap of 4 distinct mons.
  const oppBroughtIndices = match.opponentBrought ?? [];

  // Parser context that resolves m1/o2 to team indices via current active slots.
  const ctx: ParseContext = {
    myTeam: match.myTeam,
    opponentTeam: match.opponentTeam,
    myActiveTeamIndex: activeIdx.mine,
    theirActiveTeamIndex: activeIdx.theirs,
    myFainted: match.myFainted,
    myBring: match.bring,
  };

  // Apply the in-flight turn's switches to the active map so subsequent
  // actions can refer to the newly-switched mon by m1/o2.
  const ctxWithDraft: ParseContext = useMemo(() => {
    const m: [number | null, number | null] = [activeIdx.mine[0], activeIdx.mine[1]];
    const t: [number | null, number | null] = [activeIdx.theirs[0], activeIdx.theirs[1]];
    for (const a of draftActions) {
      if (a.kind !== 'switch' || a.targetTeamIndex == null) continue;
      if (a.side === 'mine') m[a.attackerSlot] = a.targetTeamIndex;
      else t[a.attackerSlot] = a.targetTeamIndex;
    }
    return { ...ctx, myActiveTeamIndex: m, theirActiveTeamIndex: t };
  }, [activeIdx, draftActions, match.myTeam, match.opponentTeam]);

  // ---------------- turn finalize ----------------

  const finalizeTurn = () => {
    if (draftActions.length === 0) {
      setMessage('No actions to log this turn.');
      return;
    }
    const turnIndex = match.turns.length + 1;
    const newTurn = { index: turnIndex, actions: draftActions, field };
    // Grow the brought set with any opp-side switches this turn (voluntary
    // or forced post-faint — both surface as a switch action in the log).
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
      myEncoreMove: { ...(match.myEncoreMove ?? {}) },
      myDisabledMove: { ...(match.myDisabledMove ?? {}) },
      myTaunted: [...(match.myTaunted ?? [])],
      myTauntTurns: { ...(match.myTauntTurns ?? {}) },
      myEncoreTurns: { ...(match.myEncoreTurns ?? {}) },
      myLeechSeeded: { ...(match.myLeechSeeded ?? {}) },
      myDisableTurns: { ...(match.myDisableTurns ?? {}) },
    };

    // Walk damaging actions in order, deriving each action's damageHpPercent
    // from previous-vs-remaining HP. Maintains per-target running HP across
    // multi-hit turns so e.g. two attacks on the same opp compute their
    // damages relative to each other. Final HP per target is committed to
    // opponentTeam / myCurrentHp afterwards.
    const oppHpSoFar = new Map<number, number>();
    const myHpSoFar = new Map<number, number>();
    const oppSubHpSoFar = new Map<number, number>();
    const mySubHpSoFar = new Map<number, number>();
    const hitSub = new Set<import('@pokechamps/core/domain/types.js').MoveAction>();
    const sortedActions = [...draftActions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const a of sortedActions) {
      if (a.kind === 'switch' || a.kind === 'mega') continue;
      if (typeof a.target !== 'object') continue;
      const tIdx = a.targetTeamIndex;
      if (tIdx == null) continue;
      const tSide = a.target.side;

      // Substitute: damage routes to sub HP. Sound moves bypass.
      const curSubHp = tSide === 'theirs'
        ? (oppSubHpSoFar.has(tIdx) ? oppSubHpSoFar.get(tIdx)! : next.opponentTeam[tIdx]?.substitute)
        : (mySubHpSoFar.has(tIdx) ? mySubHpSoFar.get(tIdx)! : next.myCurrentSub?.[tIdx]);
      if (curSubHp != null) {
        const mvFlags2 = getMove(a.move) as { flags?: Record<string, number> } | undefined;
        if (!mvFlags2?.flags?.sound) {
          hitSub.add(a);
          if (a.damageHpPercent != null) {
            const subAfter = Math.max(0, curSubHp - a.damageHpPercent);
            if (tSide === 'theirs') oppSubHpSoFar.set(tIdx, subAfter);
            else mySubHpSoFar.set(tIdx, subAfter);
          }
          continue;
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
        // Legacy: explicit damage-dealt
        newPct = Math.max(0, prevPct - a.damageHpPercent);
      } else if (a.damageRaw != null && tSide === 'mine') {
        const mySet = next.myTeam[tIdx];
        const max = mySet ? maxHpFor(mySet) : 0;
        const dmgPct = max > 0 ? (a.damageRaw / max) * 100 : 0;
        newPct = Math.max(0, prevPct - dmgPct);
      }
      if (newPct == null) continue;

      // Record the computed damageHpPercent so the inference pass below uses
      // the correct value (independent of how the user typed it). Captured
      // BEFORE any auto-trigger heal so inference sees the actual hit, not
      // the post-Sitrus residual.
      a.damageHpPercent = Math.max(0, prevPct - newPct);

      // HP-threshold item auto-trigger (Sitrus, pinch berries). My-side only:
      // opp items are usually unknown and auto-firing a guess would silently
      // corrupt downstream inference. Mirror of the engine.ts path.
      if (tSide === 'mine' && newPct > 0) {
        const consumed = next.myItemConsumed?.[tIdx];
        const held = consumed ? undefined : next.myTeam[tIdx]?.item;
        const trig = hpItemTriggerFor(held, prevPct, newPct);
        if (trig) {
          if (trig.healPercent != null) {
            newPct = Math.min(100, newPct + trig.healPercent);
          }
          if (trig.boost) {
            applyBoostsInto(next, 'mine', tIdx, { [trig.boost.stat]: trig.boost.amount });
          }
          next.myItemConsumed = { ...(next.myItemConsumed ?? {}), [tIdx]: trig.consumed };
        }
      }

      // Resist berry auto-consume (my side). Mirror of engine.ts.
      if (tSide === 'mine') {
        const consumed2 = next.myItemConsumed?.[tIdx];
        const held2 = consumed2 ? undefined : next.myTeam[tIdx]?.item;
        if (held2) {
          const moveDex2 = getMove(a.move) as { type?: string } | undefined;
          if (moveDex2?.type) {
            const heldId2 = toId(held2);
            const berryForType2 = resistBerryForType(moveDex2.type);
            if (heldId2 === 'chilanberry' && moveDex2.type === 'Normal') {
              next.myItemConsumed = { ...(next.myItemConsumed ?? {}), [tIdx]: held2 };
            } else if (berryForType2 && heldId2 === toId(berryForType2)) {
              const defTypes2 = speciesTypes(next.myTeam[tIdx]!.species);
              if (effectiveness(moveDex2.type, defTypes2) > 1) {
                next.myItemConsumed = { ...(next.myItemConsumed ?? {}), [tIdx]: held2 };
              }
            }
          }
        }
      }

      if (tSide === 'theirs') oppHpSoFar.set(tIdx, newPct);
      else myHpSoFar.set(tIdx, newPct);
    }

    // Commit final HP for everyone touched this turn.
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

    // Commit sub HP changes; clear broken subs.
    for (const [idx, subHp] of oppSubHpSoFar) {
      const o = next.opponentTeam[idx];
      if (o) o.substitute = subHp <= 0 ? undefined : subHp;
    }
    if (mySubHpSoFar.size > 0) {
      next.myCurrentSub = { ...(next.myCurrentSub ?? {}) };
      for (const [idx, subHp] of mySubHpSoFar) {
        if (subHp <= 0) delete next.myCurrentSub![idx];
        else next.myCurrentSub![idx] = subHp;
      }
    }

    // Resist berry auto-consume on opp side when item is KNOWN. Mirror of engine.ts.
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
      if (heldId === 'chilanberry' && moveDex.type === 'Normal') {
        o.itemConsumed = held;
      } else if (berryForType && heldId === toId(berryForType)) {
        const defTypes = speciesTypes(o.species);
        if (effectiveness(moveDex.type, defTypes) > 1) {
          o.itemConsumed = held;
        }
      }
    }

    // Update each opp's knownMoves with anything they did this turn.
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

    // Run damage inference + mega resolution. Mega actions resolve here so
    // species / ability / item swap from the base forme to the mega
    // forme; errors (ambiguous X/Y, no mega available) surface as notes.
    const inferenceNotes: string[] = [];
    for (const a of draftActions) {
      if (a.kind !== 'mega') continue;
      const err = applyMegaAction(next, a);
      if (err) inferenceNotes.push(err);
    }
    // Two-turn charge moves (Solar Beam, Electro Shot, etc.). No-damage
    // charge action → set charging flag; damage action by same mon →
    // clear it. Power Herb / sun / terrain skip the charge turn entirely,
    // in which case the user just logs damage normally and we never set
    // the flag in the first place.
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
          const { [idx]: _drop, ...rest } = cur;
          next.myCharging = rest;
        }
      }
    }
    // Field-clearing moves (Defog / Rapid Spin / Court Change / Tidy Up).
    for (const a of draftActions) {
      if (a.kind === 'switch' || a.kind === 'mega') continue;
      const clear = hazardClearEffect(a.move);
      if (!clear) continue;
      next.field = applyHazardClear(next.field ?? NEUTRAL_FIELD, a.side, clear.kind);
      if (a.attackerTeamIndex != null) {
        if (clear.userSpeedBoost) applyBoostsInto(next, a.side, a.attackerTeamIndex, { spe: clear.userSpeedBoost });
        if (clear.userAtkBoost) applyBoostsInto(next, a.side, a.attackerTeamIndex, { atk: clear.userAtkBoost });
      }
      inferenceNotes.push(`${a.move} cleared hazards`);
    }
    // Field-setting moves (weather / terrain / Trick Room / Tailwind / screens).
    for (const a of draftActions) {
      if (a.kind === 'switch' || a.kind === 'mega') continue;
      const fm = fieldMoveEffect(a.move);
      if (!fm) continue;
      // Setter's held item adjusts duration (Damp/Heat/Smooth/Icy Rock → 8t
      // weather; Light Clay → 8t screens). Mirror of engine.ts.
      let setterItem: string | null | undefined;
      if (a.attackerTeamIndex != null) {
        setterItem = a.side === 'mine'
          ? next.myTeam[a.attackerTeamIndex]?.item
          : next.opponentTeam[a.attackerTeamIndex]?.item;
      }
      next.field = applyFieldMove(next.field ?? NEUTRAL_FIELD, a.side, fm, setterItem);
      inferenceNotes.push(`${a.move} set field state`);
    }
    // Leech Seed: set the volatile on a foe target. Fails on Grass-types
    // (immune) and on already-seeded targets. Mirror of engine.ts. Cleared on
    // switch-out, drained + heals at EOT in endOfTurn.
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
    // Substitute: deduct 25% HP from the user; create sub at 25% HP. Mirror of engine.ts.
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
    // Combat −1 Def −1 SpD, …) auto-applied to the user when the move
    // connects. Contrary inverts. Mirror of engine.ts.
    for (const a of draftActions) {
      if (a.kind === 'switch' || a.kind === 'mega') continue;
      if (a.attackerTeamIndex == null) continue;
      if (a.damageHpPercent == null && a.damageRaw == null) continue;
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
      applyBoostsInto(next, a.side, a.attackerTeamIndex, applied);
    }

    // Drain moves (Giga Drain / Drain Punch / …): heal attacker by drain
    // fraction of damage dealt. Mirror of engine.ts.
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
      // Observed self-HP (`/ <hp>`) overrides the computed drain heal (ground truth).
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

    // Recoil damage for the attacker. Mirror of engine.ts recoil loop.
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
      // Observed self-HP (`/ <hp>`) is ground truth — apply it (recoil + any contact
      // chip already baked in) and skip the estimate.
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
        recoilPct = 50;
      } else {
        if (a.damageHpPercent == null) continue;
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

    // Rough Skin / Iron Barbs: contact move → attacker loses 1/8 max HP.
    // Mirror of engine.ts rough-skin loop.
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
      const atkAbilRS2 = a.side === 'mine'
        ? next.myTeam[a.attackerTeamIndex]?.ability
        : next.opponentTeam[a.attackerTeamIndex]?.ability;
      if (atkAbilRS2 && toId(atkAbilRS2) === 'magicguard') continue;
      const atkMax = maxHpOf(a.side, a.attackerTeamIndex);
      if (!atkMax) continue;
      const chip = 100 / 8;
      if (a.side === 'mine') {
        next.myCurrentHp = next.myCurrentHp ?? {};
        next.myCurrentHp[a.attackerTeamIndex] = Math.max(0, (next.myCurrentHp[a.attackerTeamIndex] ?? 100) - chip);
      } else {
        const o = next.opponentTeam[a.attackerTeamIndex];
        if (o) o.currentHpPercent = Math.max(0, (o.currentHpPercent ?? 100) - chip);
      }
    }

    // Spicy Spray (custom defender ability): when a damaging hit lands on the
    // holder, the attacker is burned (Fire-immune + non-volatile-statused skip).
    // Mirror of engine.ts.
    for (const a of draftActions) {
      if (a.kind === 'switch' || a.kind === 'mega') continue;
      if (a.attackerTeamIndex == null) continue;
      if (a.damageHpPercent == null && a.damageRaw == null) continue;
      if (typeof a.target !== 'object') continue;
      const tIdx = a.targetTeamIndex;
      if (tIdx == null) continue;
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
        applied = tryApplyMyStatusInto(next, aIdx, 'brn');
      } else {
        const o = next.opponentTeam[aIdx];
        if (!o || o.status) continue;
        applied = tryApplyOppStatusInto(o, 'brn');
      }
      const ref = `${aSide === 'mine' ? 'm' : 'o'}${aIdx + 1}`;
      inferenceNotes.push(applied
        ? `${ref} burned (Spicy Spray on ${defFormeName})`
        : `${ref} Rawst/Lum Berry cured the Spicy Spray burn`);
    }
    // Status-category moves auto-apply their status to the target.
    // Mirror of engine.ts status-moves loop.
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
      const st = sm.status as NonNullable<import('@pokechamps/core/domain/types.js').ActivePokemonState['status']>;
      if (tSide === 'mine') {
        if (next.myStatus?.[tIdx]) continue; // already non-volatile statused
        if (tryApplyMyStatusInto(next, tIdx, st)) {
          if (st === 'tox') next.myToxCounter = { ...(next.myToxCounter ?? {}), [tIdx]: 1 };
          if (st === 'slp') next.mySleepCounter = { ...(next.mySleepCounter ?? {}), [tIdx]: 3 };
        }
      } else {
        const o = next.opponentTeam[tIdx];
        if (!o || o.status) continue; // already non-volatile statused
        if (tryApplyOppStatusInto(o, st)) {
          if (st === 'tox') o.toxCounter = 1;
          if (st === 'slp') o.sleepCounter = 3;
        }
      }
    }
    // Explicitly-logged status from the turn line: a damaging move's secondary
    // (`o1 > Scald > o1 > 45 brn`) or a contact-ability status on the ATTACKER
    // (`m1 > Flare Blitz > o1 > 45 / 80 brn`). Mirror of engine.ts logged-status loop.
    for (const a of draftActions) {
      if (a.kind === 'switch' || a.kind === 'mega') continue;
      if (a.targetStatus && typeof a.target === 'object' && a.targetTeamIndex != null) {
        applyLoggedStatusInto(next, a.target.side, a.targetTeamIndex, a.targetStatus);
      }
      if (a.attackerStatus && a.attackerTeamIndex != null) {
        applyLoggedStatusInto(next, a.side, a.attackerTeamIndex, a.attackerStatus);
      }
    }
    // Setup self-boost moves (Swords Dance, Nasty Plot, etc.).
    // Mirror of engine.ts setup-boosts loop.
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
      applyBoostsInto(next, a.side, a.attackerTeamIndex, applied);
    }
    // Item-removing moves (Knock Off / Thief / Covet / berry-eaters).
    for (const a of draftActions) {
      if (a.kind === 'switch' || a.kind === 'mega') continue;
      if (!isItemRemovingMove(a.move)) continue;
      if (typeof a.target !== 'object') continue;
      const tIdx = a.targetTeamIndex;
      if (tIdx == null) continue;
      if (a.target.side === 'theirs') {
        const o = next.opponentTeam[tIdx];
        if (o && !o.itemConsumed) o.itemConsumed = `knocked off (${a.move})`;
      } else if (next.myItemConsumed?.[tIdx] == null) {
        const lost = next.myTeam[tIdx]?.item;
        next.myItemConsumed = { ...(next.myItemConsumed ?? {}), [tIdx]: lost ?? `knocked off (${a.move})` };
      }
    }
    // Item-swap moves (Trick / Switcheroo) — exchange held items. Mirror of
    // engine.ts. The opp item may be unknown (undefined); the swap still
    // records what we know on each side.
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
    }
    // Focus Sash (`... > o1 > N sash`): proc (1-sliver) → item consumed, alive,
    // skip inference; survived with HP to spare → item learned (held), damage
    // stands for inference.
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
        else o.item = 'Focus Sash';
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
      const tIdx2 = a.targetTeamIndex;
      if (tIdx2 == null) continue;
      const moveDex2 = getMove(a.move) as { type?: string } | undefined;
      const berryName2 = moveDex2?.type ? resistBerryForType(moveDex2.type) : undefined;
      if (!berryName2) continue;
      if (a.target.side === 'theirs') {
        const o2 = next.opponentTeam[tIdx2];
        if (!o2) continue;
        if (!o2.item) o2.item = berryName2;
        o2.itemConsumed = berryName2;
      } else {
        next.myItemConsumed = { ...(next.myItemConsumed ?? {}), [tIdx2]: berryName2 };
      }
    }
    // Positional boost context per damaging action (Helping Hand / Coaching / setup
    // / earlier-logged boost lines in effect at that point). Mirror of engine.ts.
    const boostCtx = computeActionBoostContexts({
      actions: draftActions,
      stateEvents: draftBoostEvents,
      myStartBoosts: match.myBoosts ?? {},
      oppStartBoosts: Object.fromEntries(match.opponentTeam.map((o, i) => [i, o.currentBoosts ?? {}])),
      myActive: [activeIdx.mine[0], activeIdx.mine[1]],
      oppActive: [activeIdx.theirs[0], activeIdx.theirs[1]],
    });
    for (const a of draftActions) {
      if (a.kind === 'switch' || a.kind === 'mega') continue;
      if (a.side !== 'mine') continue;
      if (sashProcced(a)) continue; // Sash-capped damage understates the move — skip inference
      if (hitSub.has(a)) continue;
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
          // Item permanence: gone if consumed BEFORE this turn (pre-turn state, so
          // a berry popping on THIS hit still applies). Mirror of engine.ts.
          itemKnownGone: !!match.opponentTeam[oppIdx]?.itemConsumed,
          // Skip the ~360k-candidate coarse-grid fallback when priors fail (it
          // blocks the UI for 10+ seconds). The Hybrid solver still returns a
          // best-effort, likelihood-ranked set (never empty).
          quickOnly: true,
        });
        const candidateSets = scored.map(s => ({
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
      } catch (e) {
        inferenceNotes.push(`${opp.species}: inference failed`);
      }
    }

    // Offensive inference: opp landed a damaging move on one of my known mons →
    // narrow their Atk/SpA (the defensive solver never touches those). Mirror of
    // engine.ts. Chains onto the candidates we already have.
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
        const candidateSets = scored.map(s => ({
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
    // opponent's max HP defense-independently → pin the HP EV(s). Mirror of engine.ts.
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
      if (opp.candidates?.length) {
        const seen = new Set<string>();
        const pinnedCands: typeof opp.candidates = [];
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

    // Joint reconcile: keep candidates consistent with the FULL observation
    // history on each mon (catches a nature promotion / Hybrid recovery that
    // contradicts an earlier fit). Mirror of engine.ts.
    for (let oi = 0; oi < next.opponentTeam.length; oi++) {
      const opp = next.opponentTeam[oi];
      if (!opp?.candidates?.length || (opp.observations?.length ?? 0) < 2) continue;
      const level = opp.candidates[0]!.level;
      const r = reconcileCandidates({
        oppSpecies: opp.species, oppLevel: level, knownMoves: opp.knownMoves,
        candidates: opp.candidates.map(c => ({ evs: c.evs, nature: c.nature, item: c.item, ability: c.ability })),
        likelihoods: opp.candidateLikelihoods, history: opp.observations!,
      });
      if (r.candidates.length === opp.candidates.length) continue;
      opp.candidates = r.candidates.map(c => ({
        species: opp.species, level, item: c.item, ability: c.ability, nature: c.nature,
        evs: c.evs, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, moves: opp.knownMoves,
      }));
      opp.candidateLikelihoods = r.likelihoods;
      inferenceNotes.push(`${opp.species}: reconciled to ${opp.candidates.length} spread(s)`);
    }

    // Speed inference uses the whole match history. Apply to opp team.
    const speeds = inferOpponentSpeeds(next, next.myTeam);
    applySpeedInference(next.opponentTeam, speeds);

    // Persist switches into the active-slot state for the next turn. Also
    // clear any slot whose occupant just fainted this turn (auto-deducted to 0).
    // Switching wipes the outgoing mon's boosts per standard battle rules.
    const nextActive = {
      mine: [activeIdx.mine[0], activeIdx.mine[1]] as [number | null, number | null],
      theirs: [activeIdx.theirs[0], activeIdx.theirs[1]] as [number | null, number | null],
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
          delete next.myBoosts[outgoing]; next.myTaunted = (next.myTaunted ?? []).filter(i => i !== outgoing); if (next.myEncoreMove) delete next.myEncoreMove[outgoing]; if (next.myDisabledMove) delete next.myDisabledMove[outgoing]; if (next.myTauntTurns) delete next.myTauntTurns[outgoing]; if (next.myEncoreTurns) delete next.myEncoreTurns[outgoing]; if (next.myDisableTurns) delete next.myDisableTurns[outgoing]; if (next.myLeechSeeded) delete next.myLeechSeeded[outgoing]; if (next.myCursed) delete next.myCursed[outgoing]; if (next.myPartialTrap) delete next.myPartialTrap[outgoing]; if (next.myNightmare) delete next.myNightmare[outgoing]; if (next.myCurrentSub) delete next.myCurrentSub[outgoing];
        }
        nextActive.mine[a.attackerSlot] = a.targetTeamIndex;
      } else {
        const outgoing = nextActive.theirs[a.attackerSlot];
        if (outgoing != null && next.opponentTeam[outgoing]) {
          const regen = next.opponentTeam[outgoing]!.ability && toId(next.opponentTeam[outgoing]!.ability!) === 'regenerator';
          const regenHp = regen ? Math.min(100, (next.opponentTeam[outgoing]!.currentHpPercent ?? 100) + 100 / 3) : undefined;
          next.opponentTeam[outgoing] = { ...next.opponentTeam[outgoing], currentBoosts: {}, taunted: undefined, encoreMove: undefined, disabledMove: undefined, tauntTurns: undefined, encoreTurns: undefined, disableTurns: undefined, leechSeeded: undefined, cursed: undefined, partialTrap: undefined, nightmare: undefined, substitute: undefined, ...(regenHp != null ? { currentHpPercent: regenHp } : {}) };
        }
        nextActive.theirs[a.attackerSlot] = a.targetTeamIndex;
      }
      // Switch-in hazards hit the new mon.
      applyHazardOnSwitchInto(next, a.side, a.targetTeamIndex);
      // Switch-in ability triggers (Intimidate / weather / terrain).
      inferenceNotes.push(...applySwitchInAbilityInto(next, a.side, a.targetTeamIndex, nextActive));
    }

    // Generalised end-of-turn: weather chip + status ticks (both sides) +
    // Leftovers / Black Sludge (mine only — opp items rarely confirmed).
    const eotResult = endOfTurn(next, field, nextActive);
    next = eotResult.match;
    const eotNote = eotResult.notes.length ? ` · EOT: ${eotResult.notes.join(', ')}` : '';
    void eotNote; // included in the status message below
    for (let i = 0; i < 2; i++) {
      const slot = i as 0 | 1;
      const mIdx = nextActive.mine[slot];
      if (mIdx != null && next.myFainted!.includes(mIdx)) nextActive.mine[slot] = null;
      const tIdx = nextActive.theirs[slot];
      if (tIdx != null && next.opponentTeam[tIdx]?.fainted) nextActive.theirs[slot] = null;
    }

    // Apply this turn's queued boost lines onto the FINAL state at their position
    // (sorted by order). They were held out of the inference so each hit was solved
    // against the boosts in effect at its point; now they land on the post-turn state.
    for (const ev of [...draftBoostEvents].sort((a, b) => a.order - b.order)) {
      const u = ev.update;
      if (!u.boosts) continue;
      const clampStage = (n: number) => Math.max(-6, Math.min(6, n));
      if (u.side === 'theirs') {
        const o = next.opponentTeam[u.teamIndex];
        if (o) { const cur = { ...(o.currentBoosts ?? {}) }; for (const [s, d] of Object.entries(u.boosts)) (cur as any)[s] = clampStage(((cur as any)[s] ?? 0) + (d ?? 0)); o.currentBoosts = cur; }
      } else {
        next.myBoosts = { ...(next.myBoosts ?? {}) };
        const cur = { ...(next.myBoosts[u.teamIndex] ?? {}) }; for (const [s, d] of Object.entries(u.boosts)) (cur as any)[s] = clampStage(((cur as any)[s] ?? 0) + (d ?? 0)); next.myBoosts[u.teamIndex] = cur;
      }
    }

    next.outcome = detectOutcome(next);
    setMatch(next);
    setActiveIdx(nextActive);
    setDraftActions([]);
    setDraftBoostEvents([]);
    setBoostedThisTurn(new Set());   // Moody nudge resets for the new turn
    setMoodyNagged(false);
    saveMatchAsync(stores, next, setMessage);
    setPendingReplacement(next.outcome ? null : findPendingReplacement(next, nextActive));
    setMessage(`Turn ${turnIndex} logged. ${inferenceNotes.join(' · ')}${eotNote}`);
  };

  // ---------------- hazard update (immediate, no turn entry) ----------------
  const applyHazardUpdate = (update: HazardUpdate) => {
    const nextField = { ...(match.field ?? NEUTRAL_FIELD) };
    if (update.side === 'mine') {
      nextField.myHazards = applyHazardVerb(nextField.myHazards, update.verb, update.arg);
    } else {
      nextField.theirHazards = applyHazardVerb(nextField.theirHazards, update.verb, update.arg);
    }
    const next: Match = { ...match, field: nextField };
    setMatch(next);
    saveMatchAsync(stores, next, setMessage);
    setMessage(`Hazard updated.`);
  };

  // ---------------- state update (immediate) ----------------

  const applyStateUpdate = (update: StateUpdate) => {
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
    };
    const nextActive = {
      mine: [activeIdx.mine[0], activeIdx.mine[1]] as [number | null, number | null],
      theirs: [activeIdx.theirs[0], activeIdx.theirs[1]] as [number | null, number | null],
    };

    const { side, teamIndex } = update;
    // Absolute HP set (m1 = 145 / o2 = 30). Auto-faints at 0 + clears the
    // active slot so the user gets prompted to switch in a replacement —
    // matches the damage-delta path's behaviour.
    const setAbsoluteHp = (pct: number) => {
      const clamped = Math.max(0, Math.min(100, pct));
      if (side === 'theirs') {
        const o = next.opponentTeam[teamIndex];
        if (!o) return;
        o.currentHpPercent = clamped;
        if (clamped === 0) {
          o.fainted = true;
          if (nextActive.theirs[0] === teamIndex) nextActive.theirs[0] = null;
          if (nextActive.theirs[1] === teamIndex) nextActive.theirs[1] = null;
        }
      } else {
        next.myCurrentHp![teamIndex] = clamped;
        if (clamped === 0) {
          if (!next.myFainted!.includes(teamIndex)) next.myFainted!.push(teamIndex);
          if (nextActive.mine[0] === teamIndex) nextActive.mine[0] = null;
          if (nextActive.mine[1] === teamIndex) nextActive.mine[1] = null;
        }
      }
    };
    if (update.hpPercent != null) setAbsoluteHp(update.hpPercent);
    if (update.hpRaw != null && side === 'mine') {
      const mySet = next.myTeam[teamIndex];
      const max = mySet ? maxHpFor(mySet) : 0;
      const pct = max > 0 ? (update.hpRaw / max) * 100 : 0;
      setAbsoluteHp(pct);
    }
    // Heals — additive, capped at 100% remaining. Don't un-faint a dead mon.
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
      // Sitrus berry restores 25% of max HP. Same value either side; resolved
      // here so the parser doesn't need species lookups.
      applyHealPct(25);
      if (side === 'theirs') {
        const o = next.opponentTeam[teamIndex];
        if (o) o.itemConsumed = 'Sitrus Berry';
      } else {
        next.myItemConsumed![teamIndex] = 'Sitrus Berry';
      }
    }
    if (update.namedHeal === 'leftovers') {
      // EOT Leftovers tick: +1/16 max HP. For the opp, also confirm the held item
      // so the lookahead models its recovery + inference locks it. Mirror of engine.ts.
      applyHealPct(100 / 16);
      if (side === 'theirs') {
        const o = next.opponentTeam[teamIndex];
        if (o) o.item = 'Leftovers';
      }
    }
    // Damage delta — clamps at 0, auto-faints if it hits 0.
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
    // Boost stage deltas, clamped to [-6, +6] per stat.
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
    // Named after-attack triggers: wp / sash / balloon. Each expands to a
    // small recipe of boosts / HP set / item-consumed marker.
    if (update.namedTrigger === 'wp') {
      // Weakness Policy: +2 atk +2 spa, item consumed.
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
      // Focus Sash: survive at 1 HP. Only meaningful if HP was about to hit 0;
      // we just set HP to 1 and mark item consumed (caller logs damage first).
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
        if (o && tryApplyOppStatusInto(o, update.status)) {
          if (update.status === 'tox') o.toxCounter = 1;
          // Sleep is 1-3 turns; default to 2 (mean). Caller can override
          // later if they observe an early wake or full duration.
          if (update.status === 'slp') o.sleepCounter = 2;
        }
      } else {
        if (tryApplyMyStatusInto(next, teamIndex, update.status)) {
          if (update.status === 'tox') next.myToxCounter![teamIndex] = 1;
          if (update.status === 'slp') next.mySleepCounter![teamIndex] = 2;
        }
      }
    }
    if (update.cureStatus) {
      if (side === 'theirs') {
        const o = next.opponentTeam[teamIndex];
        if (o) { o.status = undefined; o.toxCounter = undefined; o.sleepCounter = undefined; o.taunted = undefined; o.encoreMove = undefined; o.disabledMove = undefined; o.tauntTurns = undefined; o.encoreTurns = undefined; o.disableTurns = undefined; }
      } else {
        delete next.myStatus![teamIndex];
        delete next.myToxCounter![teamIndex];
        delete next.mySleepCounter?.[teamIndex];
        next.myTaunted = next.myTaunted!.filter(i => i !== teamIndex);
        delete next.myEncoreMove![teamIndex]; delete next.myDisabledMove![teamIndex];
        delete next.myTauntTurns![teamIndex]; delete next.myEncoreTurns![teamIndex]; delete next.myDisableTurns![teamIndex];
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
      else { next.mySaltCured = { ...(next.mySaltCured ?? {}) }; next.mySaltCured[teamIndex] = true; }
    }
    if (update.aquaRing) {
      if (side === 'theirs') { const o = next.opponentTeam[teamIndex]; if (o) o.aquaRing = true; }
      else { next.myAquaRing = { ...(next.myAquaRing ?? {}) }; next.myAquaRing[teamIndex] = true; }
    }
    if (update.ingrain) {
      if (side === 'theirs') { const o = next.opponentTeam[teamIndex]; if (o) o.ingrain = true; }
      else { next.myIngrain = { ...(next.myIngrain ?? {}) }; next.myIngrain[teamIndex] = true; }
    }
    if (update.curse) {
      if (side === 'theirs') { const o = next.opponentTeam[teamIndex]; if (o) o.cursed = true; }
      else { next.myCursed = { ...(next.myCursed ?? {}) }; next.myCursed[teamIndex] = true; }
    }
    if (update.partialTrap != null) {
      if (side === 'theirs') { const o = next.opponentTeam[teamIndex]; if (o) o.partialTrap = update.partialTrap; }
      else { next.myPartialTrap = { ...(next.myPartialTrap ?? {}) }; next.myPartialTrap[teamIndex] = update.partialTrap; }
    }
    if (update.nightmare) {
      if (side === 'theirs') { const o = next.opponentTeam[teamIndex]; if (o) o.nightmare = true; }
      else { next.myNightmare = { ...(next.myNightmare ?? {}) }; next.myNightmare[teamIndex] = true; }
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
      // Boosts on the OUTGOING active reset on switch-out (game mechanic). The
      // incoming mon starts with whatever boosts they already had stored —
      // typically none for a first appearance.
      if (side === 'mine') {
        const outgoing = nextActive.mine[update.bringIntoSlot];
        if (outgoing != null) {
          if (toId(next.myTeam[outgoing]?.ability ?? '') === 'regenerator') {
            next.myCurrentHp = next.myCurrentHp ?? {};
            next.myCurrentHp[outgoing] = Math.min(100, (next.myCurrentHp[outgoing] ?? 100) + 100 / 3);
          }
          delete next.myBoosts![outgoing]; next.myTaunted = (next.myTaunted ?? []).filter(i => i !== outgoing); if (next.myEncoreMove) delete next.myEncoreMove[outgoing]; if (next.myDisabledMove) delete next.myDisabledMove[outgoing]; if (next.myTauntTurns) delete next.myTauntTurns[outgoing]; if (next.myEncoreTurns) delete next.myEncoreTurns[outgoing]; if (next.myDisableTurns) delete next.myDisableTurns[outgoing]; if (next.myLeechSeeded) delete next.myLeechSeeded[outgoing]; if (next.myCursed) delete next.myCursed[outgoing]; if (next.myPartialTrap) delete next.myPartialTrap[outgoing]; if (next.myNightmare) delete next.myNightmare[outgoing];
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
            o.currentBoosts = {}; o.taunted = undefined; o.encoreMove = undefined; o.disabledMove = undefined; o.tauntTurns = undefined; o.encoreTurns = undefined; o.disableTurns = undefined; o.leechSeeded = undefined; o.cursed = undefined; o.partialTrap = undefined; o.nightmare = undefined; o.substitute = undefined;
          }
        }
        nextActive.theirs[update.bringIntoSlot] = teamIndex;
        const brought = new Set(next.opponentBrought ?? []);
        brought.add(teamIndex as any);
        next.opponentBrought = [...brought].sort((a, b) => a - b) as Match['opponentBrought'];
      }
      // Hazards on the incoming side's hazard pile hit them now.
      applyHazardOnSwitchInto(next, side, teamIndex);
      // Switch-in ability triggers (Intimidate / weather / terrain).
      applySwitchInAbilityInto(next, side, teamIndex, nextActive);
    }

    next.outcome = detectOutcome(next);
    setMatch(next);
    setActiveIdx(nextActive);
    saveMatchAsync(stores, next, setMessage);
    setPendingReplacement(next.outcome ? null : findPendingReplacement(next, nextActive));
    setMessage(
      update.hpPercent != null || update.hpRaw != null ? `HP set.` :
      update.healPercent != null || update.healRaw != null || update.namedHeal ? `Healed.` :
      update.damagePercent != null || update.damageRaw != null ? `Damage applied.` :
      update.boosts ? `Boosts applied.` :
      update.namedTrigger ? `${update.namedTrigger} triggered.` :
      update.status ? `Status: ${update.status}.` :
      update.cureStatus ? `Status cured.` :
      update.fainted ? `Marked fainted.` :
      update.bringIntoSlot != null ? `Replacement applied.` :
      'Updated.'
    );
  };

  // ---------------- suggestion derivation ----------------

  const sctx = useMemo(() => deriveSuggestionContext(input, ctxWithDraft), [input, ctxWithDraft]);
  const suggestions = useMemo(
    () => getSuggestions(sctx, { myTeam: match.myTeam, opponentTeam: match.opponentTeam, myFainted: match.myFainted, bring: match.bring }, 8),
    [sctx, match.myTeam, match.opponentTeam, match.myFainted],
  );
  // When the user is typing in the damage slot (4th `>`-segment), surface a
  // hint about which unit applies for the target side.
  const damageHintTargetSide: 'mine' | 'theirs' | null = useMemo(() => {
    const parts = input.split('>').filter(s => s.trim().length > 0);
    if (parts.length < 3) return null;
    const tgtTok = parts[2]!.trim().toLowerCase();
    const m = tgtTok.match(/^([mo])([12])$/);
    return m ? (m[1] === 'm' ? 'mine' : 'theirs') : null;
  }, [input]);
  // Reset the highlight whenever the suggestion list changes.
  useMemo(() => setHighlight(0), [suggestions.length, input]);

  // Active mons with the Moody ability (mine: always known; opp: only once the
  // ability is confirmed). Moody boosts a random stat every EOT, so while one is
  // out we nudge the user to log it — unless they already logged a boost this turn.
  const activeMoodyMons = useMemo(() => {
    const out: { key: string; ref: string; species: string }[] = [];
    const isMoody = (a?: string | null) => !!a && toId(a) === 'moody';
    activeIdx.mine.forEach((idx, slot) => {
      const set = idx == null ? null : match.myTeam[idx];
      if (idx != null && set && isMoody(set.ability) && !match.myFainted?.includes(idx)) out.push({ key: `mine:${idx}`, ref: `m${slot + 1}`, species: set.species });
    });
    activeIdx.theirs.forEach((idx, slot) => {
      const opp = idx == null ? null : match.opponentTeam[idx];
      if (idx != null && opp && isMoody(opp.ability) && !opp.fainted) out.push({ key: `theirs:${idx}`, ref: `o${slot + 1}`, species: opp.species });
    });
    return out;
  }, [activeIdx, match.myTeam, match.opponentTeam, match.myFainted]);
  const moodyPending = activeMoodyMons.filter(m => !boostedThisTurn.has(m.key));
  // Record manual boost lines logged this turn (so the Moody nudge suppresses) +
  // reset the soft /next nag so it can warn again next turn.
  const noteBoostLogged = (updates: { side: string; teamIndex: number; boosts?: unknown }[]) => {
    const keys = updates.filter(u => u.boosts).map(u => `${u.side}:${u.teamIndex}`);
    if (!keys.length) return;
    setBoostedThisTurn(s => { const n = new Set(s); for (const k of keys) n.add(k); return n; });
    setMoodyNagged(false);
  };

  // The turn as ONE ordered timeline: move actions + queued boost lines, sorted by
  // `order`. Single source of truth for the draft display AND /undo + /edit, so the
  // numbers the user sees always match what those commands act on. Each entry is
  // uniformly removable (drop from its backing list) and editable (its `line`).
  const turnTimeline = useMemo(() => {
    const items: { order: number; line: string; action?: MoveAction; ev?: { order: number; update: StateUpdate; raw: string } }[] = [
      ...draftActions.map((a, i) => ({ order: a.order ?? i + 1, line: actionToLine(a, match), action: a })),
      ...draftBoostEvents.map(ev => ({ order: ev.order, line: ev.raw, ev })),
    ];
    items.sort((x, y) => x.order - y.order);
    return items;
  }, [draftActions, draftBoostEvents, match]);
  const removeTimelineItem = (item: { action?: MoveAction; ev?: { order: number } }) => {
    if (item.action) setDraftActions(prev => prev.filter(a => a !== item.action));
    else if (item.ev) setDraftBoostEvents(prev => prev.filter(e => e !== item.ev));
  };
  // Next sequence number for a newly-logged turn event — max existing + 1 (NOT a
  // count, so removing a middle item via /undo never collides a later insert).
  const nextTurnOrder = () => {
    let mx = 0;
    for (const a of draftActions) mx = Math.max(mx, a.order ?? 0);
    for (const e of draftBoostEvents) mx = Math.max(mx, e.order);
    return mx + 1;
  };

  // ---------------- global hotkeys ----------------

  // Dispatch a parsed slash command. Returns true when handled (the caller
  // should clear the input box); false when the command was unknown or its
  // preconditions weren't met (e.g. /review with no turns yet).
  const runBattleCommand = (id: BattleCommandId, args = ''): boolean => {
    switch (id) {
      case 'ask': {
        const r = runAskCommand(args, match, activeIdx, field);
        setMessage(r);
        return true;
      }
      case 'quit': onEnd(); return true;
      case 'share': {
        // Remote-mode only — sharing needs the match to live on the server.
        if (!stores.matches.share || !stores.matches.unshare) {
          setMessage('Sharing needs remote mode — set a server in Server Settings and sign in.');
          return true;
        }
        if (args.trim().toLowerCase() === 'off') {
          void stores.matches.unshare(match.id)
            .then(() => setMessage('Live share revoked. Existing viewers will drop on reconnect.'))
            .catch(err => setMessage(`Couldn't revoke share: ${err?.message ?? err}`));
          return true;
        }
        void stores.matches.share(match.id)
          .then(({ url }) => setMessage(`Live share link (send to a friend): ${url}`))
          .catch(err => setMessage(`Couldn't create share: ${err?.message ?? err}`));
        return true;
      }
      case 'save':
        saveMatchAsync(stores, match, setMessage);
        setMessage(`Snapshot saved (${match.id}).`);
        return true;
      case 'next':
        // Schedule finalize on the next tick so React can paint the
        // 'finalizing' spinner BEFORE the heavy inference work blocks
        // the main thread. setTimeout(0) is enough — Ink picks up the
        // state change and renders before the timer fires.
        if (finalizing) return true;
        // Soft Moody gate: if a Moody mon is out and you haven't logged its EOT
        // boost, warn ONCE — a second /next goes through (you may not care this turn).
        if (moodyPending.length > 0 && !moodyNagged) {
          setMoodyNagged(true);
          setMessage(`⚠ Moody boost not logged: ${moodyPending.map(m => `${m.species} (${m.ref})`).join(', ')} — e.g. \`${moodyPending[0]!.ref} +2 spe -1 def\`, or /next again to skip.`);
          return true;
        }
        setFinalizing(true);
        setTimeout(() => {
          try { finalizeTurn(); } finally { setFinalizing(false); }
        }, 0);
        return true;
      case 'undo': {
        // Operates on the WHOLE turn timeline (moves + queued boost lines), so the
        // numbers match the draft list. `/undo` removes the last; `/undo N` the Nth.
        if (turnTimeline.length === 0) {
          setMessage('Nothing to undo — no events this turn.');
          return true;
        }
        const arg = args.trim();
        let idx = turnTimeline.length - 1;
        if (arg) {
          const n = parseInt(arg, 10);
          if (!Number.isInteger(n) || n < 1 || n > turnTimeline.length) {
            setMessage(`No turn event #${arg} — there are ${turnTimeline.length}.`);
            return true;
          }
          idx = n - 1;
        }
        const item = turnTimeline[idx]!;
        removeTimelineItem(item);
        setMessage(`Removed: ${item.line}`);
        return true;
      }
      case 'edit': {
        // `/edit N` removes turn event N (move OR boost line) and drops its line back
        // into the input box to tweak + re-submit (instead of remove + retype).
        if (turnTimeline.length === 0) {
          setMessage('Nothing to edit — no events this turn.');
          return true;
        }
        const n = parseInt(args.trim(), 10);
        if (!Number.isInteger(n) || n < 1 || n > turnTimeline.length) {
          setMessage(`Usage: /edit N (1-${turnTimeline.length}).`);
          return true;
        }
        const item = turnTimeline[n - 1]!;
        removeTimelineItem(item);
        setInput(item.line);
        setInputKey(k => k + 1);    // remount TextInput so the cursor lands at the end
        setMessage(`Editing #${n} — tweak the line and press Enter.`);
        return true;
      }
      case 'endgame': {
        const mine = activeIdx.mine
          .filter((idx): idx is number => idx != null)
          .map(idx => ({
            set: match.myTeam[idx]!,
            currentHpPercent: match.myCurrentHp?.[idx] ?? 100,
          }));
        const opp = activeIdx.theirs
          .filter((idx): idx is number => idx != null)
          .map(idx => ({
            entry: match.opponentTeam[idx]!,
            currentHpPercent: match.opponentTeam[idx]?.currentHpPercent ?? 100,
          }));
        const pos: EndgamePosition = { mine, opp, field };
        const { recommendations } = solveEndgame(pos);
        if (recommendations.length === 0) {
          setMessage('No endgame recommendation (no live actives).');
          return true;
        }
        const lines = recommendations.map(r => {
          if (!r.targetSpecies && !r.move) return `${r.mySpecies}: no live targets`;
          if (!r.move) return `${r.mySpecies} → ${r.targetSpecies}: no calculable move`;
          const koTag = r.likelyKo ? ' (KO!)' : ` (${(r.breakdown.offenseScore * 100).toFixed(0)}% · net ${r.netScore.toFixed(1)})`;
          return `${r.mySpecies} → ${r.targetSpecies}: ${r.move}${koTag}`;
        });
        setMessage(lines.join('\n'));
        return true;
      }
      case 'summary': setSummaryOpen(s => !s); return true;
      case 'override': setOverrideOpen(true); return true;
      case 'crit': setShowCrits(c => !c); return true;
      case 'allmoves': setShowAllMoves(a => !a); return true;
      case 'info': setInfoPickerOpen(true); return true;
      case 'help':
        setHelpOpen(h => !h);
        return true;
      case 'pika':
        // Cycle through: off → run → idle → off. Lets the user compare
        // both sprites and confirm sixel works.
        setPikaPreview(p => p == null ? 'run' : p === 'run' ? 'idle' : null);
        return true;
      case 'export':
        // Toggle the export overlay. Renders the current full team (not
        // just the brought 4) — same as TeamPicker's `x` does.
        setExportPanelText(t => t == null ? formatShowdownTeamSP(match.myTeam) : null);
        return true;
      case 'review': {
        if (match.turns.length === 0) {
          setMessage('/review needs at least one finalized turn.');
          return true;
        }
        if (!aiAvailable()) {
          setMessage('/review needs ANTHROPIC_API_KEY set.');
          return true;
        }
        if (aiReviewBusy) return true;
        const lastTurn = match.turns[match.turns.length - 1]!;
        const activeSummary = [
          activeIdx.mine[0] != null ? `m1 ${match.myTeam[activeIdx.mine[0]]!.species} HP ${(match.myCurrentHp?.[activeIdx.mine[0]] ?? 100).toFixed(0)}%` : 'm1 empty',
          activeIdx.mine[1] != null ? `m2 ${match.myTeam[activeIdx.mine[1]]!.species} HP ${(match.myCurrentHp?.[activeIdx.mine[1]] ?? 100).toFixed(0)}%` : 'm2 empty',
          activeIdx.theirs[0] != null ? `o1 ${match.opponentTeam[activeIdx.theirs[0]]!.species} HP ${(match.opponentTeam[activeIdx.theirs[0]]!.currentHpPercent ?? 100).toFixed(0)}%` : 'o1 empty',
          activeIdx.theirs[1] != null ? `o2 ${match.opponentTeam[activeIdx.theirs[1]]!.species} HP ${(match.opponentTeam[activeIdx.theirs[1]]!.currentHpPercent ?? 100).toFixed(0)}%` : 'o2 empty',
        ].join(' · ');
        const fieldSummary = [
          field.weather ?? 'no weather',
          field.terrain ?? 'no terrain',
          field.trickRoom ? 'TR' : null,
          field.myTailwind ? 'my TW' : null,
          field.theirTailwind ? 'opp TW' : null,
        ].filter(Boolean).join(' · ');
        setAiReviewBusy(true);
        reviewLastTurn({
          myTeam: match.myTeam,
          opponent: match.opponentTeam,
          lastTurn,
          activeSummary,
          fieldSummary,
        })
          .then(text => setAiReview(text))
          .catch(err => setAiReview(`Error: ${err.message}`))
          .finally(() => setAiReviewBusy(false));
        return true;
      }
    }
  };

  // Only non-printable / navigation keys remain on the global key listener,
  // since printable hotkeys collide with typing into the action input.
  // Slash commands cover the rest — see TextInput onSubmit below.
  useInput((_ch, key) => {
    // Spectator: the only interaction is Esc to leave. No drafting, no commands.
    if (spectator) {
      if (key.escape) onEnd();
      return;
    }
    // Match over: Esc exits; /save still works via the input.
    if (match.outcome) {
      if (key.escape) onEnd();
      return;
    }
    if (pendingReplacement) {
      if (key.escape) setPendingReplacement(null);
      return;
    }
    if (infoPickerOpen) {
      if (key.escape) setInfoPickerOpen(false);
      return;
    }
    if (infoOpenForOpp != null) {
      if (key.escape) setInfoOpenForOpp(null);
      return;
    }
    if (helpOpen) {
      if (key.escape) setHelpOpen(false);
      return;
    }
    if (summaryOpen) {
      if (key.escape) setSummaryOpen(false);
      return;
    }
    if (exportPanelText != null) {
      if (key.escape) setExportPanelText(null);
      return;
    }
    if (key.escape) onEnd();
    if (suggestions.length > 0) {
      if (key.upArrow) setHighlight(h => Math.max(0, h - 1));
      else if (key.downArrow) setHighlight(h => Math.min(suggestions.length - 1, h + 1));
      else if (key.tab && suggestions[highlight]) {
        // Tab cycles bash-style: continue an active cycle (input still equals what
        // we last applied) by advancing to the next snapshotted suggestion; else
        // start a fresh cycle from the (arrow-selected) highlight.
        const cyc = tabCycle.current;
        if (cyc && cyc.list.length > 0 && input === applySuggestion(cyc.stem, cyc.list[cyc.idx]!, cyc.kind)) {
          const idx = (cyc.idx + 1) % cyc.list.length;
          cyc.idx = idx;
          setInput(applySuggestion(cyc.stem, cyc.list[idx]!, cyc.kind));
        } else {
          const start = Math.min(highlight, suggestions.length - 1);
          tabCycle.current = { stem: input, kind: sctx.kind, list: suggestions.slice(), idx: start };
          setInput(applySuggestion(input, suggestions[start]!, sctx.kind));
        }
        setHighlight(0);
        // Force-remount TextInput so its internal cursor snaps to the end
        // of the newly-applied value (otherwise the next keystroke inserts
        // in the middle of "Close Combat").
        setInputKey(k => k + 1);
      }
    }
  }, { isActive: !overrideOpen });

  // ---------------- per-active matchup grid ----------------
  // For each of my 2 active slots, compute matchup rows against ALL 6 opps
  // (revealed and unrevealed). Each row carries my best move (offense), opp's
  // worst-case move (threat), and the speed verdict.

  const turnOrder = predictTurnOrder({
    myActives: [0, 1].map(s => {
      const idx = activeIdx.mine[s];
      return {
        slot: s as 0 | 1,
        set: idx != null ? match.myTeam[idx] ?? null : null,
        status: idx != null ? match.myStatus?.[idx] : undefined,
        // Already mega'd own mon → order at its mega forme's speed (matches the
        // matchup grid, which uses the mega forme for an active mega).
        formeOverride: idx != null && match.myMegaUsed?.includes(idx)
          ? match.myMegaForme?.[idx]
          : undefined,
      };
    }),
    oppActives: [0, 1].map(s => ({ slot: s as 0 | 1, entry: activeIdx.theirs[s] != null ? match.opponentTeam[activeIdx.theirs[s]!] ?? null : null })),
    field,
  });

  const matchups = activeIdx.mine.map((myIdx, slotPos) => {
    if (myIdx == null) return null;
    const mySet = match.myTeam[myIdx];
    if (!mySet) return null;
    // My OTHER active slot — used to surface a spread threat's collateral
    // (Rock Slide on m1 also chips m2). null in a 1-on-1 or when the other
    // slot is empty/fainted.
    const otherIdx = activeIdx.mine[1 - slotPos];
    const otherSet = otherIdx != null ? match.myTeam[otherIdx] ?? null : null;
    const otherCalcSet = otherSet
      ? (match.myItemConsumed?.[otherIdx!] ? { ...otherSet, item: undefined } : otherSet)
      : null;
    const otherMegaActive = otherIdx != null ? (match.myMegaUsed?.includes(otherIdx) ?? false) : false;
    const otherBoosts = otherIdx != null ? match.myBoosts?.[otherIdx] : undefined;
    const otherStatus = otherIdx != null ? match.myStatus?.[otherIdx] : undefined;
    // For damage calcs, drop my item once it's been consumed / knocked off.
    // Keep `mySet` itself intact for mega-stone detection + speed.
    const myCalcSet = match.myItemConsumed?.[myIdx] ? { ...mySet, item: undefined } : mySet;
    const myHp = match.myCurrentHp?.[myIdx] ?? 100;
    const myBoosts = match.myBoosts?.[myIdx];
    const myStatus = match.myStatus?.[myIdx];
    // Mega state: has this mon already mega-evolved? If not, do they hold a
    // legal mega stone — i.e. could they mega NEXT? Pre-mega + stone-held
    // means we render predictions BOTH ways: current base-forme stats AND
    // the post-mega forme stats so the user can see whether mega is worth
    // popping this turn.
    const myMegaActive = match.myMegaUsed?.includes(myIdx) ?? false;
    const myMegaOption = !myMegaActive
      ? getMegaOptions(mySet.species).find(o => o.stone === mySet.item) ?? null
      : null;
    const mySpeedBase = actualSpeed(mySet);
    const mySpeedMega = myMegaOption ? actualSpeed(mySet, myMegaOption.forme) : null;
    // Fake Out / First Impression / Mat Block only fire on the mon's first turn
    // out — drop them from my offense once this mon has acted since entering.
    const myFresh = firstTurnOut(match, 'mine', myIdx);
    // Common args for prediction calls — only the active flag flips when we
    // compute the "what if I mega'd" variant.
    const baseOpts = {
      attackerBoosts: myBoosts,
      defenderBoosts: undefined as Partial<Record<string, number>> | undefined,
      attackerStatus: myStatus,
      defenderStatus: undefined as string | undefined,
      attackerFirstTurnOut: myFresh,
    };
    return {
      mySet,
      myIdx,
      myHp,
      myBoosts,
      myStatus,
      mySpeed: myMegaActive && match.myMegaForme?.[myIdx]
        ? actualSpeed(mySet, match.myMegaForme[myIdx])
        : mySpeedBase,
      mySpeedMega,
      myMegaForme: myMegaOption?.forme ?? null,
      rows: match.opponentTeam.map((opp, oi) => {
        const oppActive = opp.megaUsed ?? false;
        const oppFresh = firstTurnOut(match, 'theirs', oi);
        const threat = predictThreat({
          opponent: opp, defender: myCalcSet, field,
          attackerGimmickActive: oppActive,
          defenderGimmickActive: myMegaActive,
          defenderCurrentHpPercent: myHp,
          attackerBoosts: opp.currentBoosts,
          defenderBoosts: myBoosts,
          attackerStatus: opp.status,
          defenderStatus: myStatus,
          attackerFirstTurnOut: oppFresh,
        });
        // Spread collateral: when the opp's worst move vs ME is a spread move,
        // it ALSO hits my other active. Recompute that same move against the
        // ally so the row can show "also chips m2 X-Y%".
        const threatSpread = threat && otherCalcSet && isSpreadMove(threat.move)
          ? (() => {
              const t = predictThreat({
                opponent: { ...opp, knownMoves: [threat.move] }, defender: otherCalcSet, field,
                attackerGimmickActive: oppActive,
                defenderGimmickActive: otherMegaActive,
                attackerBoosts: opp.currentBoosts,
                defenderBoosts: otherBoosts,
                attackerStatus: opp.status,
                defenderStatus: otherStatus,
                attackerFirstTurnOut: oppFresh,
              });
              return t ? { species: otherSet!.species, min: t.minPercent, max: t.maxPercent } : null;
            })()
          : null;
        const threatFlinch = threat ? moveFlinchChance(threat.move) : 0;
        return {
          opp,
          oppIdx: oi,
          threatSpread,
          threatFlinch,
          offense: predictOffense({
            attacker: myCalcSet, opponent: opp, field,
            attackerGimmickActive: myMegaActive,
            defenderGimmickActive: oppActive,
            defenderCurrentHpPercent: opp.currentHpPercent,
            ...baseOpts,
            defenderBoosts: opp.currentBoosts,
            defenderStatus: opp.status,
          }),
          offenseCrit: showCrits ? predictOffense({
            attacker: myCalcSet, opponent: opp, field,
            attackerGimmickActive: myMegaActive,
            defenderGimmickActive: oppActive,
            defenderCurrentHpPercent: opp.currentHpPercent,
            ...baseOpts,
            defenderBoosts: opp.currentBoosts,
            defenderStatus: opp.status,
            critical: true,
          }) : null,
          // `a` toggle: full per-move breakdown. When combined with `c` we also
          // compute the crit variant so each move line can show both ranges.
          allOffense: showAllMoves ? predictOffenseAll({
            attacker: myCalcSet, opponent: opp, field,
            attackerGimmickActive: myMegaActive,
            defenderGimmickActive: oppActive,
            defenderCurrentHpPercent: opp.currentHpPercent,
            ...baseOpts,
            defenderBoosts: opp.currentBoosts,
            defenderStatus: opp.status,
          }) : null,
          allOffenseCrit: showAllMoves && showCrits ? predictOffenseAll({
            attacker: myCalcSet, opponent: opp, field,
            attackerGimmickActive: myMegaActive,
            defenderGimmickActive: oppActive,
            defenderCurrentHpPercent: opp.currentHpPercent,
            ...baseOpts,
            defenderBoosts: opp.currentBoosts,
            defenderStatus: opp.status,
            critical: true,
          }) : null,
          threat,
          // Dual-forme: compute the same offense + threat using post-mega
          // stats, so the row can surface "⭢mega X-Y%" alongside the base
          // numbers.
          // offenseMega: my mega attacks the opp (only when I can still mega).
          // threatMega: OPP mega attacks me (only when the opp can still mega).
          // These are independent — one or both may be shown.
          offenseMega: myMegaOption ? predictOffense({
            attacker: myCalcSet, opponent: opp, field,
            attackerGimmickActive: true,
            defenderGimmickActive: oppActive,
            defenderCurrentHpPercent: opp.currentHpPercent,
            ...baseOpts,
            defenderBoosts: opp.currentBoosts,
            defenderStatus: opp.status,
          }) : null,
          threatMega: (() => {
            // Opp can mega only if it hasn't used the gimmick AND could still be
            // holding the stone (oppCanMega rules out a committed/inferred
            // non-stone item — e.g. an Absol on Scope Lens won't show a Mega
            // Absol threat). Build a synthetic entry with the stone attached so
            // resolveSpecies resolves the mega forme.
            if (opp.megaUsed || !oppCanMega(opp)) return null;
            const oppMegaOpts = getMegaOptions(opp.species);
            if (!oppMegaOpts.length) return null;
            const stone = oppMegaOpts[0]!.stone;
            const base = opp.candidates?.length ? opp.candidates : [defaultOpponentSet(opp, 50)];
            const megaOppEntry = { ...opp, candidates: base.map(c => ({ ...c, item: stone })) };
            return predictThreat({
              opponent: megaOppEntry, defender: myCalcSet, field,
              attackerGimmickActive: true,
              defenderGimmickActive: myMegaActive,
              defenderCurrentHpPercent: myHp,
              attackerBoosts: opp.currentBoosts,
              defenderBoosts: myBoosts,
              attackerStatus: opp.status,
              defenderStatus: myStatus,
              attackerFirstTurnOut: oppFresh,
            });
          })(),
          speed: speedVerdict({ mySet, opp, field, myFormeOverride: myMegaActive ? match.myMegaForme?.[myIdx] : undefined }),
          speedMega: myMegaOption ? speedVerdict({ mySet, opp, field, myFormeOverride: myMegaOption.forme }) : null,
        };
      }),
    };
  });

  // ---------------- render ----------------

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Battle — turn {match.turns.length + 1}{draftActions.length ? ' (composing)' : ''}</Text>
      {!match.outcome && bestSearch && bestSearch.plays.length > 0 && (() => {
        const v = bestSearch.verdict;
        // "forced" only when the search PROVED it (worst-case rolls, survival
        // items, all opp mons known). Otherwise a hedged, number-driven read.
        const wc = bestSearch.winChance;
        let vText: string;
        let vColor: string;
        if (bestSearch.forced) {
          vText = v === 'winning' ? 'forced win' : 'forced loss';
          vColor = v === 'winning' ? 'green' : 'red';
        } else if (wc != null) {
          vText = `~${Math.round(wc * 100)}% to win`;
          vColor = wc >= 0.6 ? 'green' : wc <= 0.35 ? 'red' : 'yellow';
        } else {
          vText = v === 'winning' ? 'likely win' : v === 'losing' ? 'likely loss' : 'even';
          vColor = v === 'winning' ? 'green' : v === 'losing' ? 'red' : 'yellow';
        }
        const turns = bestSearch.depth;
        // Confidence chip: turns ahead + an HONEST, scope-derived breadth report
        // (lines explored this ply, candidate spreads behind the cells, mega
        // combos, and the non-attack action kinds ACTUALLY in the tree — so it
        // never claims "switches" until they're real nodes).
        let conf = `${turns} turn${turns === 1 ? '' : 's'} ahead`;
        const ex = bestSearch.explored;
        if (ex) {
          const parts: string[] = [];
          const lines = ex.myActions * ex.oppActions;
          if (lines > 1) parts.push(`${lines} lines/ply`);
          if (ex.spreads > 1) parts.push(`${ex.spreads} spreads`);
          if (ex.megaBranches > 1) parts.push(`mega ×${ex.megaBranches}`);
          const extra = ex.actionClasses.filter(c => c !== 'attack');
          if (extra.length) parts.push(`incl ${extra.join('/')}`);
          if (parts.length) conf += ` · ${parts.join(' · ')}`;
        }
        const fmtPlays = (ps: typeof bestSearch.plays) => ps
          .map(p => p.self ? `${p.mySpecies}→${p.move}` : `${p.mySpecies}→${p.move || '—'}→${p.targetSpecies}`)
          .join(' · ');
        const plays = fmtPlays(bestSearch.plays);
        const mega = bestSearch.megaMon ? `mega ${bestSearch.megaMon} · ` : '';
        // Pivotal assumptions behind the verdict (e.g. contingent-speed outspeed).
        const whyText = (bestSearch.assumptions ?? []).map(a => a.text).join('; ');
        // Break-points: damage cutpoints to watch against the real roll this turn.
        const watchText = (bestSearch.breakpoints ?? []).map(b => {
          const pct = b.prob != null ? ` ~${Math.round(b.prob * 100)}%` : '';
          if (b.direction === 'ko') {
            return `${b.move} on ${b.subject}:${pct} to OHKO${b.spreadNote ? ` (${b.spreadNote})` : ''}`;
          }
          return `${b.move} on ${b.subject}:${pct} → ${b.thenNote}`;
        }).join(' · ');
        // "How they beat us" — the opponent's minimizing reply (rendered losing).
        const oppLineText = v === 'losing' && bestSearch.oppLine ? fmtPlays(bestSearch.oppLine) : '';
        // "1D chess" — the opponent's flat, obvious greedy play (always shown).
        const oneDChessText = bestSearch.obviousOppPlay ? fmtPlays(bestSearch.obviousOppPlay) : '';
        // Compact risk breakdown: "label NN%", joined — labels are self-explanatory.
        const riskText = bestSearch.risks
          .map(r => `${r.label}${r.prob != null ? ` ${Math.round(r.prob * 100)}%` : ''}`)
          .join(' · ');
        // Mechanics in this position the fast search only approximates — surfaced
        // so the verdict's blind spots are explicit (one example per class).
        const unmodeledText = (bestSearch.unmodeled ?? [])
          .map(u => `${u.label}${u.examples[0] ? ` (${u.examples[0]})` : ''}`)
          .join(' · ');
        // Hail Mary: dice rolls needed when verdict is losing but a win is possible.
        const hm = bestSearch.hailMary;
        let hmLine: string | null = null;
        if (hm) {
          if (hm.noRealisticOut) {
            hmLine = '~lost — no realistic out';
          } else {
            const outText = hm.outs.map(o => `${o.label} (${Math.round(o.prob * 100)}%)`).join(' + ');
            hmLine = `only out: ~${Math.round(hm.combined * 100)}% — ${outText}`;
          }
        }
        return (
          <>
            <Text>
              <Text color="magenta">⌁ best play </Text><Text dimColor>({conf})</Text><Text color="magenta">: </Text>
              {mega ? <Text color="cyan">{mega}</Text> : null}{plays}  <Text color={vColor}>— {vText}</Text>
            </Text>
            {watchText ? <Text dimColor>   watch: {watchText}</Text> : null}
            {whyText ? <Text dimColor>   why: {whyText}</Text> : null}
            {oppLineText ? <Text dimColor>   they win via: {oppLineText}</Text> : null}
            {oneDChessText ? <Text dimColor>   1D chess (opp likely): {oneDChessText}</Text> : null}
            {bestSearch.adapted ? <Text dimColor>   spread refined from observed damage</Text> : null}
            {riskText ? <Text dimColor>   risks: {riskText}</Text> : null}
            {unmodeledText ? <Text color="yellow">   ⚠ approximating: {unmodeledText}</Text> : null}
            {hmLine ? <Text dimColor>   {hmLine}</Text> : null}
          </>
        );
      })()}
      {/* "Work outwards" deep probe: a tentative narrow read several plies past what
          full breadth can afford. Only shown when it sees DEEPER than the verified
          verdict, so it adds information rather than repeating it. */}
      {!match.outcome && deepProbe && deepProbe.plays.length > 0 && (!bestSearch || deepProbe.depth > bestSearch.depth) && (() => {
        const v = deepProbe.verdict;
        const vColor = v === 'winning' ? 'green' : v === 'losing' ? 'red' : 'yellow';
        const plays = deepProbe.plays
          .map(p => p.self ? `${p.mySpecies}→${p.move}` : `${p.mySpecies}→${p.move || '—'}→${p.targetSpecies}`)
          .join(' · ');
        return (
          <Text dimColor>
            <Text color="blue">⌁ deep probe</Text> (depth {deepProbe.depth}, most-likely spread · tentative): {plays} <Text color={vColor}>— {v}</Text>
          </Text>
        );
      })()}
      {match.outcome && (
        <Box flexDirection="column" borderStyle="double" borderColor={match.outcome === 'victory' ? 'green' : match.outcome === 'defeat' ? 'red' : 'yellow'} paddingX={2} marginY={1}>
          <Text bold color={match.outcome === 'victory' ? 'green' : match.outcome === 'defeat' ? 'red' : 'yellow'}>
            {match.outcome === 'victory' ? '🏆 Victory!' : match.outcome === 'defeat' ? '💀 Defeat.' : '🤝 Tie.'}
          </Text>
          <MatchSummary match={match} />
          <SelectInput
            isFocused
            items={[
              { label: 'Save snapshot', value: 'save' },
              { label: 'Start a new match', value: 'new' },
              { label: 'Back to main menu', value: 'menu' },
            ]}
            onSelect={item => {
              if (item.value === 'save') {
                saveMatchAsync(stores, match, setMessage);
                setMessage(`Snapshot saved (${match.id}).`);
              } else if (item.value === 'new') {
                onEnd('new-match');
              } else {
                onEnd('menu');
              }
            }}
          />
        </Box>
      )}
      <Text dimColor>
        Type an action, or <Text color="white">/help</Text> for syntax + commands · ESC ends match
      </Text>

      <Box marginTop={1} flexDirection="row">
        {/* Left: bring + opp roster */}
        <Box flexDirection="column" width={42} marginRight={2}>
          <Text bold color="green">Me</Text>
          {bringTeam.map((m, i) => {
            const a0 = activeIdx.mine[0];
            const a1 = activeIdx.mine[1];
            const teamIdx = match.bring[i]!;
            const isActive = teamIdx === a0 || teamIdx === a1;
            // Active mons → slot ref (★m1/★m2). Benched → unambiguous team ref
            // (my1..my6) so the user can type "my4 in m1", "my4 = 120", etc.
            const slotMarker = teamIdx === a0 ? '★m1' : teamIdx === a1 ? '★m2' : `my${teamIdx + 1}`.padEnd(3);
            const fainted = match.myFainted?.includes(teamIdx) ?? false;
            const hp = match.myCurrentHp?.[teamIdx];
            const color = fainted ? 'gray' : isActive ? 'green' : undefined;
            const boosts = match.myBoosts?.[teamIdx];
            const consumed = match.myItemConsumed?.[teamIdx];
            const status = match.myStatus?.[teamIdx];
            return (
              <Box key={`m-${i}`} flexDirection="column">
                <Text color={color}>
                  {' '}{slotMarker} {shortName(m.species, 14)}
                  {hp != null && !fainted ? <Text dimColor> HP {hp.toFixed(0)}%</Text> : null}
                  {status ? <Text color={statusColor(status)}> {status.toUpperCase()}</Text> : null}
                  {fainted ? <Text color="gray"> KO</Text> : null}
                  {m.item ? <Text dimColor> @ {consumed ? <Text strikethrough>{consumed}</Text> : m.item}</Text> : null}
                </Text>
                {boosts && Object.keys(boosts).length > 0 && (
                  <Text color="yellow">      boosts: {formatBoosts(boosts)}</Text>
                )}
                {(match.myTaunted?.includes(teamIdx) || match.myEncoreMove?.[teamIdx] || match.myDisabledMove?.[teamIdx]) && (
                  <Text color="magenta">      {match.myTaunted?.includes(teamIdx) ? `🤬Taunt${match.myTauntTurns?.[teamIdx] ? `(${match.myTauntTurns[teamIdx]})` : ''} ` : ''}{match.myEncoreMove?.[teamIdx] ? `🔁Encore ${match.myEncoreMove[teamIdx]}${match.myEncoreTurns?.[teamIdx] ? `(${match.myEncoreTurns[teamIdx]})` : ''} ` : ''}{match.myDisabledMove?.[teamIdx] ? `🚫Disable ${match.myDisabledMove[teamIdx]}${match.myDisableTurns?.[teamIdx] ? `(${match.myDisableTurns[teamIdx]})` : ''}` : ''}</Text>
                )}
                {match.myCurrentSub?.[teamIdx] != null && (
                  <Text color="cyan">      [Sub {Math.round(match.myCurrentSub[teamIdx]!)}%]</Text>
                )}
                {match.myPerishCount?.[teamIdx] != null && (
                  <Text color="red">      ☠Perish {match.myPerishCount[teamIdx]}</Text>
                )}
                {match.mySaltCured?.[teamIdx] && (
                  <Text color="yellow">      ⬡Salt Cure</Text>
                )}
                {match.myPartialTrap?.[teamIdx] ? (
                  <Text color="yellow">      ⛓trapped({match.myPartialTrap[teamIdx]})</Text>
                ) : null}
                {isActive && m.moves.some(isFirstTurnMove) && !firstTurnOut(match, 'mine', teamIdx) && (
                  <Text dimColor>      {m.moves.filter(isFirstTurnMove).join('/')} spent (not first turn out)</Text>
                )}
              </Box>
            );
          })}

          <Box marginTop={1}><Text bold color="red">Opponent</Text></Box>
          {match.opponentTeam.map((o, i) => {
            const brought = oppBroughtIndices.includes(i as any);
            const a0 = activeIdx.theirs[0];
            const a1 = activeIdx.theirs[1];
            // Active → slot ref (★o1/★o2). Benched → unambiguous team ref
            // (op1..op6) so the user can target it: "op4 = 30%", "op4 in o1".
            const slotMarker = i === a0 ? '★o1' : i === a1 ? '★o2' : `op${i + 1}`.padEnd(3);
            const color = i === a0 || i === a1 ? 'red' : brought ? undefined : 'gray';
            return (
              <OppRow
                key={`o-${i}`}
                stores={stores}
                index={i}
                entry={o}
                marker={slotMarker}
                color={color}
                choiceLock={detectChoiceLock(match, i)}
              />
            );
          })}
          <Box marginTop={1}>
            <Text dimColor>★ = active slot (m1/m2 · o1/o2) · myN/opN = team ref, usable in any line (switch + edits) · gray = not yet brought</Text>
          </Box>
        </Box>

        {/* Right: matchup grid — both directions, all 6 opps */}
        <Box flexDirection="column" flexGrow={1}>
          {(field.weather || field.terrain || field.trickRoom || field.myTailwind || field.theirTailwind) && (
            <Text dimColor>
              Field — {[
                field.weather ? `${field.weather}${field.weatherTurns != null ? `(${field.weatherTurns})` : ''}` : null,
                field.terrain ? `${field.terrain} Terrain` : null,
                field.trickRoom ? `Trick Room${field.trickRoomTurns != null ? `(${field.trickRoomTurns})` : ''}` : null,
                field.myTailwind ? `my Tailwind${field.myTailwindTurns != null ? `(${field.myTailwindTurns})` : ''}` : null,
                field.theirTailwind ? `opp Tailwind${field.theirTailwindTurns != null ? `(${field.theirTailwindTurns})` : ''}` : null,
              ].filter(Boolean).join(' · ')}
            </Text>
          )}
          {(field.myHazards || field.theirHazards) && (
            <Text dimColor>
              Hazards — me: <Text color="white">{hazardGlyphs(field.myHazards) ?? '—'}</Text> · opp: <Text color="white">{hazardGlyphs(field.theirHazards) ?? '—'}</Text>
            </Text>
          )}
          {turnOrder.length > 0 && (
            <Text>
              <Text dimColor>Order: </Text>
              {turnOrder.map((row, i) => (
                <React.Fragment key={`ord-${row.label}`}>
                  {i > 0 ? <Text dimColor> → </Text> : null}
                  <Text color={row.label.startsWith('m') ? 'green' : 'red'}>{row.label}</Text>
                  <Text> {row.species} </Text>
                  <Text dimColor>
                    ({row.unknown
                      ? '?'
                      : row.speedMin === row.speedMax
                        ? `${row.speedMin}`
                        : `${row.speedMin}-${row.speedMax}`})
                  </Text>
                  {row.paralyzed ? <Text color="yellow"> PAR½</Text> : null}
                  {row.scarf ? <Text color="yellow">⚡</Text> : null}
                </React.Fragment>
              ))}
            </Text>
          )}
          <Text bold>Matchups</Text>
          {matchups.every(m => m == null) && (
            <Text dimColor>No active slots — pick leads to begin.</Text>
          )}
          {matchups.map((m, mi) => {
            if (!m) return null;
            return (
              <Box key={`mu-${mi}`} flexDirection="column" marginTop={mi === 0 ? 0 : 1}>
                <Text color="green">m{mi + 1} {match.myMegaForme?.[m.myIdx] ?? m.mySet.species} <Text dimColor>[HP {m.myHp.toFixed(0)}% · spd {m.mySpeed}{m.mySpeedMega != null ? ` (mega ${m.myMegaForme}: ${m.mySpeedMega})` : ''}]</Text>{match.myCharging?.[m.myIdx] ? <Text color="cyan"> ⚡charging {match.myCharging[m.myIdx]!.move}</Text> : null}</Text>
                {m.rows.map(row => {
                  const a0 = activeIdx.theirs[0];
                  const a1 = activeIdx.theirs[1];
                  const isActive = row.oppIdx === a0 || row.oppIdx === a1;
                  const isBrought = oppBroughtIndices.includes(row.oppIdx as any);
                  const marker = row.oppIdx === a0 ? '★o1' : row.oppIdx === a1 ? '★o2' : isBrought ? ' B ' : ' ? ';
                  const dim = !isActive && !isBrought;
                  return (
                    <MatchupRow
                      key={row.oppIdx}
                      marker={marker}
                      opp={row.opp}
                      offense={row.offense}
                      offenseCrit={row.offenseCrit}
                      allOffense={row.allOffense ?? null}
                      allOffenseCrit={row.allOffenseCrit ?? null}
                      threat={row.threat}
                      threatSpread={row.threatSpread}
                      threatFlinch={row.threatFlinch}
                      verdict={row.speed}
                      offenseMega={row.offenseMega ?? null}
                      threatMega={row.threatMega ?? null}
                      verdictMega={row.speedMega ?? null}
                      dim={dim}
                      active={isActive}
                    />
                  );
                })}
              </Box>
            );
          })}
        </Box>
      </Box>

      {/* Opp info picker — opens via `i`. Selecting an opp populates the
          detail panel below. */}
      {infoPickerOpen && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text bold color="cyan">Inspect opponent</Text>
          <Text dimColor>↑/↓ pick · Enter view · Esc cancel</Text>
          <SelectInput
            items={match.opponentTeam.map((o, i) => ({
              label: `o${i + 1} ${o.species}${o.fainted ? ' (KO)' : ''}`,
              value: i,
            }))}
            isFocused
            onSelect={item => {
              setInfoOpenForOpp(item.value as number);
              setInfoPickerOpen(false);
            }}
          />
        </Box>
      )}

      {/* Opp info detail panel — populated after the picker selects an opp. */}
      {infoOpenForOpp != null && (
        <OppInfoPanel stores={stores} index={infoOpenForOpp} entry={match.opponentTeam[infoOpenForOpp]!} />
      )}

      {/* /override — manual state editor. Owns its own input while open;
          the main useInput + TextInput are gated off via overrideOpen. */}
      {overrideOpen && (
        <OverridePanel
          match={match}
          activeIdx={activeIdx}
          onClose={() => setOverrideOpen(false)}
          onApply={(nextMatch, nextActive) => {
            setMatch(nextMatch);
            setActiveIdx(nextActive);
            saveMatchAsync(stores, nextMatch, setMessage);
            setOverrideOpen(false);
            setMessage('Override applied.');
          }}
        />
      )}

      {/* /help cheat-sheet — full syntax + slash command reference. Esc to close. */}
      {helpOpen && <HelpPanel />}
      {summaryOpen && <MatchSummaryPanel match={match} />}

      {/* /export overlay — current team's Showdown export, selectable via
          the terminal's normal selection mechanism. Esc closes. */}
      {exportPanelText != null && (
        <ExportPanel
          title="Showdown export — current team"
          body={exportPanelText}
          hint="Select with your terminal + copy · paste into play.pokemonshowdown.com → Teambuilder · Esc closes"
        />
      )}

      {/* /pika preview — forces SIXEL regardless of detection. If your
          terminal can't render sixel you'll see escape-sequence garbage
          instead of the sprite, which itself confirms the detection
          path. Toggles through run → idle → off. */}
      {pikaPreview && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            /pika preview · {pikaPreview} sprite · force=sixel ·
            {' '}TERM_PROGRAM={process.env.TERM_PROGRAM ?? '(unset)'} ·
            {' '}WT_SESSION={process.env.WT_SESSION ? 'yes' : 'no'} ·
            {' '}TERM={process.env.TERM ?? '(unset)'}
          </Text>
          <PikaSpinner
            sprite={pikaPreview}
            force="sixel"
            label={`(/pika again to switch to ${pikaPreview === 'run' ? 'idle' : pikaPreview === 'idle' ? 'off' : 'run'})`}
          />
        </Box>
      )}

      {/* Replacement picker — takes focus when an active slot is empty
          after a faint. Other input is paused until the user picks (or Esc). */}
      {pendingReplacement && (() => {
        const { side, slot } = pendingReplacement;
        const slotLabel = `${side === 'mine' ? '★m' : '★o'}${slot + 1}`;
        const opts = eligibleReplacements(side, slot, match, activeIdx);
        const items = opts.map(o => ({ label: o.species, value: o.teamIndex }));
        return (
          <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
            <Text bold color="yellow">
              {slotLabel} is empty — pick a replacement {side === 'mine' ? '(your turn to switch in)' : '(opp send-in)'}
            </Text>
            <Text dimColor>↑/↓ pick · Enter to send · Esc to skip (you can also type "X in Y" manually)</Text>
            <SelectInput
              items={items}
              isFocused
              onSelect={item => {
                applyStateUpdate({ side, teamIndex: item.value as number, bringIntoSlot: slot });
                // applyStateUpdate already calls setPendingReplacement based on
                // the post-update state, so the queue advances naturally.
              }}
            />
          </Box>
        );
      })()}

      {/* Spectator banner replaces the turn composer — read-only, no input. */}
      {spectator ? (
        <Box marginTop={1} borderStyle="round" paddingX={1} flexDirection="column">
          <Text color="green">{spectatorLabel ?? '● spectating'} · read-only</Text>
          <Text dimColor>Watching the host's live view. Press Esc to leave.</Text>
        </Box>
      ) : (
      <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
        <Text bold>Turn {match.turns.length + 1} in progress ({turnTimeline.length} event{turnTimeline.length === 1 ? '' : 's'})</Text>
        {moodyPending.length > 0 && (
          <Text color="yellow">⚠ Moody EOT boost — log for {moodyPending.map(m => `${m.species} (${m.ref})`).join(', ')}: e.g. <Text color="white">{moodyPending[0]!.ref} +2 spe -1 def</Text></Text>
        )}
        {turnTimeline.map((it, i) => it.ev
          ? <Text key={`e${i}`} color="yellow">  {i + 1}. {it.line}  <Text dimColor>(applies here, end of turn)</Text></Text>
          : <Text key={`a${i}`} dimColor>  {i + 1}. {it.line}{it.action!.kind !== 'switch' && it.action!.kind !== 'mega' && isPivotMove(it.action!.move) ? <Text color="cyan"> ⟲ pivot — log the switch-in next</Text> : null}</Text>)}
        <Box marginTop={turnTimeline.length > 0 ? 1 : 0}>
          <Text>{'> '}</Text>
          <TextInput
            key={inputKey}
            value={input}
            onChange={setInput}
            focus={!pendingReplacement && !match.outcome && !overrideOpen}
            onSubmit={value => {
              const trimmed = value.trim();
              if (!trimmed) return;
              // Slash commands take precedence over the action parser. They
              // never collide because action lines don't start with '/'.
              const cmd = parseCommand(trimmed, BATTLE_COMMANDS);
              if (cmd) {
                runBattleCommand(cmd.id, cmd.args);
                setInput('');
                return;
              }
              if (trimmed.startsWith('/')) {
                setMessage(`Unknown command: ${trimmed}. Type /help.`);
                setInput('');
                return;
              }
              const r = parseTurnLine(trimmed, ctxWithDraft, nextTurnOrder());
              if (!r.ok) {
                setMessage(`Couldn't parse: ${r.error}`);
                return;
              }
              if (r.kind === 'action') {
                setDraftActions(prev => [...prev, ...r.actions]);
                setInput('');
                setMessage('');
                return;
              }
              if (r.kind === 'hazard') {
                applyHazardUpdate(r.update);
                setInput('');
                return;
              }
              if (r.kind === 'states') {
                // Bulk HP update — apply each in turn. applyStateUpdate is
                // pure-ish (uses React's batched setState), so the final
                // render reflects the cumulative result.
                for (const u of r.updates) applyStateUpdate(u);
                noteBoostLogged(r.updates);
                setInput('');
                setMessage(`Applied ${r.updates.length} HP updates.`);
                return;
              }
              // r.kind === 'state'. A BOOST line logged DURING a turn joins the
              // turn's ordered timeline (applied at finalize at its input position);
              // everything else (HP / status / corrections) mutates immediately.
              if (r.update.boosts && draftActions.length > 0) {
                const order = nextTurnOrder();
                setDraftBoostEvents(prev => [...prev, { order, update: r.update, raw: trimmed }]);
                noteBoostLogged([r.update]);
                setMessage(`Queued: ${trimmed} (applies at this point in the turn)`);
              } else {
                applyStateUpdate(r.update);
                noteBoostLogged([r.update]);
              }
              setInput('');
            }}
          />
        </Box>
        {input.length > 0 && (
          <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
            {sctx.kind === 'none' && damageHintTargetSide ? (
              <Text dimColor>
                Damage: enter the target's REMAINING HP after the hit — {damageHintTargetSide === 'mine'
                  ? <Text color="white">raw HP value (e.g. 145)</Text>
                  : <Text color="white">% remaining (e.g. 33)</Text>}. To enter damage-dealt instead, use <Text color="white">N raw</Text> or <Text color="white">N%</Text>.
              </Text>
            ) : sctx.kind === 'none' ? (
              <Text dimColor>
                Autocomplete: type <Text color="white">{'m1 > '}</Text> (or m2/o1/o2) to start a move; <Text color="white">m1 &gt; switch &gt; </Text> for switches.
              </Text>
            ) : suggestions.length === 0 ? (
              <Text dimColor>
                Autocomplete ({sctx.kind === 'switch-target' ? 'switch target' : 'move'}): no matches for "{sctx.query}"
              </Text>
            ) : (
              <>
                <Text dimColor>↑/↓ pick · Tab cycle/apply ({
                  sctx.kind === 'switch-target' ? 'switch target' :
                  sctx.kind === 'state-verb' ? 'state verb' :
                  'move'}{sctx.query ? ` · "${sctx.query}"` : ''})</Text>
                {suggestions.map((name, i) => (
                  <Text key={`sug-${i}-${name}`} inverse={i === highlight} color={i === highlight ? 'green' : undefined}>
                    {i === highlight ? ' ▶ ' : '   '}{name}
                  </Text>
                ))}
              </>
            )}
          </Box>
        )}
      </Box>
      )}

      {/* Recent turn history */}
      {match.turns.length > 0 && (
        <Box flexDirection="column" marginTop={1} borderStyle="single" paddingX={1}>
          <Text bold>Recent turns</Text>
          {match.turns.slice(-3).map(t => (
            <Box key={t.index} flexDirection="column">
              <Text color="cyan">T{t.index}</Text>
              {t.actions.map((a, ai) => (
                <Text key={ai} dimColor>  {a.order ?? ai + 1}. {actionToLine(a, match)}</Text>
              ))}
            </Box>
          ))}
        </Box>
      )}

      {finalizing && (
        <Box marginTop={1}>
          <PikaSpinner sprite="run" label="Crunching the turn — narrowing opp spreads…" />
        </Box>
      )}
      {aiReviewBusy && <Box marginTop={1}><PikaSpinner label="Pikachu is reviewing the last turn…" /></Box>}
      {aiReview && !aiReviewBusy && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="magenta" paddingX={1}>
          <Text bold color="magenta">Claude's read on turn {match.turns.length}</Text>
          <Text>{aiReview}</Text>
        </Box>
      )}
      {message && <Box marginTop={1}><Text color="yellow">{message}</Text></Box>}
    </Box>
  );
}

// Pretty-print a MoveAction back to roughly the syntax that produced it,
// for display in the in-progress turn list and the history panel.
function actionToLine(a: MoveAction, match: Match): string {
  const mods = [
    a.mega ? '+mega' : '',
    a.critical ? '+crit' : '',
    a.quickClaw ? '+quick' : '',
  ].join('');
  const actor = `${a.side === 'mine' ? 'm' : 'o'}${a.attackerSlot + 1}${mods}`;
  if (a.kind === 'switch') {
    const team = a.side === 'mine' ? match.myTeam : match.opponentTeam;
    const incoming = a.targetTeamIndex != null
      ? (team[a.targetTeamIndex] as PokemonSet | OpponentEntry | undefined)?.species ?? `?${a.targetTeamIndex}`
      : '?';
    return `${actor} > switch > ${incoming}`;
  }
  if (a.kind === 'mega') {
    // Standalone mega declaration — minimal display, just the actor + verb.
    // The move field carries variant info ('mega', 'mega-x', 'mega-y') so
    // surfaces it as part of the verb.
    return `${actor} ${a.move}`;
  }
  const target = typeof a.target === 'object'
    ? `${a.target.side === 'mine' ? 'm' : 'o'}${a.target.slot + 1}`
    : a.target;
  // Damage / remaining-HP token: prefer the dealt-damage fields (set post-finalize),
  // else the remaining-HP a fresh draft still carries (side-aware unit).
  const dmgTok = a.damageHpPercent != null ? `${a.damageHpPercent}%`
    : a.damageRaw != null ? `${a.damageRaw} raw`
    : a.targetRemainingHpPercent != null ? `${a.targetRemainingHpPercent}`
    : a.targetRemainingHpRaw != null ? `${a.targetRemainingHpRaw}`
    : '';
  // Trailing target flags + status (`… > 45 brn`, `… > 1 sash`, `… > 80 (berry)`).
  const targetTrail = [dmgTok, a.sash ? 'sash' : '', a.berry ? '(berry)' : '', a.targetStatus ?? ''].filter(Boolean).join(' ');
  // The `/` self-clause: attacker's own HP + source + contact status (`… / 80 brn`).
  const selfNum = a.selfRemainingHpRaw != null ? `${a.selfRemainingHpRaw}`
    : a.selfRemainingHpPercent != null ? `${a.selfRemainingHpPercent}`
    : '';
  const selfTrail = [selfNum, a.selfHpSource ?? '', a.attackerStatus ?? ''].filter(Boolean).join(' ');
  const fourth = `${targetTrail}${selfTrail ? ` / ${selfTrail}` : ''}`.trim();
  return `${actor} > ${a.move} > ${target}${fourth ? ` > ${fourth}` : ''}`;
}

// Full syntax + commands cheat-sheet shown by /help. Lives in a bordered
// panel near the bottom of the screen. Esc closes it (see the keyboard
// handler higher up — helpOpen takes modal precedence over normal input).
// Match recap from the turn log: per-mon damage dealt / taken (each summed on its
// OWN HP bar, so percents are within-mon), KOs per side, and the MVP. Available any
// time via /summary; doubles as the match-end summary.
function MatchSummaryPanel({ match }: { match: Match }) {
  const myDealt: Record<number, number> = {}, myTaken: Record<number, number> = {};
  const oppDealt: Record<number, number> = {}, oppTaken: Record<number, number> = {};
  for (const turn of match.turns) for (const a of turn.actions) {
    const dmg = a.damageHpPercent ?? 0; if (dmg <= 0) continue;
    if (a.side === 'mine') {
      if (a.attackerTeamIndex != null) myDealt[a.attackerTeamIndex] = (myDealt[a.attackerTeamIndex] ?? 0) + dmg;
      if (a.targetTeamIndex != null) oppTaken[a.targetTeamIndex] = (oppTaken[a.targetTeamIndex] ?? 0) + dmg;
    } else if (a.side === 'theirs') {
      if (a.attackerTeamIndex != null) oppDealt[a.attackerTeamIndex] = (oppDealt[a.attackerTeamIndex] ?? 0) + dmg;
      if (a.targetTeamIndex != null) myTaken[a.targetTeamIndex] = (myTaken[a.targetTeamIndex] ?? 0) + dmg;
    }
  }
  const myFainted = new Set(match.myFainted ?? []);
  const myIdxs = match.bring && match.bring.length ? match.bring : match.myTeam.map((_, i) => i);
  const myRows = myIdxs.map(i => ({ name: match.myTeam[i]?.species ?? `#${i}`, dealt: myDealt[i] ?? 0, taken: myTaken[i] ?? 0, fainted: myFainted.has(i) }));
  const oppRows = match.opponentTeam
    .map((o, j) => ({ name: o.species, dealt: oppDealt[j] ?? 0, taken: oppTaken[j] ?? 0, fainted: !!o.fainted }))
    .filter(r => r.dealt > 0 || r.taken > 0 || r.fainted);
  const mvp = myRows.slice().sort((a, b) => b.dealt - a.dealt)[0];
  const myDown = myRows.filter(r => r.fainted).length;
  const oppDown = oppRows.filter(r => r.fainted).length;
  const row = (r: { name: string; dealt: number; taken: number; fainted: boolean }, key: string) => (
    <Text key={key} color={r.fainted ? 'red' : undefined}>
      {'  '}{r.name.padEnd(16)} {r.dealt.toFixed(0).padStart(4)}% dealt · {r.taken.toFixed(0).padStart(4)}% taken{r.fainted ? '  ✖ fainted' : ''}
    </Text>
  );
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">/summary — match recap ({match.turns.length} turn{match.turns.length === 1 ? '' : 's'})</Text>
      <Text dimColor>Mons down — you {myDown} · opp {oppDown}{mvp && mvp.dealt > 0 ? ` · MVP ${mvp.name} (${mvp.dealt.toFixed(0)}% dealt)` : ''}</Text>
      <Box marginTop={1}><Text bold>Your team</Text></Box>
      {myRows.map((r, i) => row(r, `my-${i}`))}
      <Box marginTop={1}><Text bold>Opponent</Text></Box>
      {oppRows.length === 0 ? <Text dimColor>  (no opponent damage logged yet)</Text> : oppRows.map((r, i) => row(r, `opp-${i}`))}
      <Box marginTop={1}><Text dimColor>Esc to close · damage is summed per mon on its own HP bar</Text></Box>
    </Box>
  );
}

function HelpPanel() {
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">/help — battle syntax + commands</Text>
      <Box marginTop={1}><Text bold>Actions</Text></Box>
      <Text>  <Text color="white">m1 &gt; Close Combat &gt; o1 &gt; 67</Text>      <Text dimColor>— attack; opp now at 67%</Text></Text>
      <Text>  <Text color="white">o1 &gt; Sucker Punch &gt; m1 &gt; 145</Text>     <Text dimColor>— opp attack; you now at 145 raw HP</Text></Text>
      <Text>  <Text color="white">m1 &gt; Sucker Punch &gt; o1 &gt; 41%</Text>     <Text dimColor>— explicit % override</Text></Text>
      <Text>  <Text color="white">m1 &gt; Close Combat &gt; o1 &gt; 80 raw</Text>  <Text dimColor>— damage-DEALT in raw HP</Text></Text>
      <Text>  <Text color="white">m1 &gt; Scald &gt; o1 &gt; 45 brn</Text>       <Text dimColor>— TARGET statused this hit (brn/par/psn/tox/slp/frz)</Text></Text>
      <Text>  <Text color="white">m1 &gt; Flare Blitz &gt; o1 &gt; 45 / 80 brn</Text> <Text dimColor>— `/` self-clause: my HP after recoil + I got burned (Flame Body)</Text></Text>
      <Text>  <Text color="white">m1+mega &gt; Flamethrower &gt; o2 &gt; 45</Text> <Text dimColor>— +mega / +crit / +tera&lt;type&gt; / +quick (Quick Claw)</Text></Text>
      <Text>  <Text color="white">m1 &gt; switch &gt; Kingambit</Text>           <Text dimColor>— switch by species (must be in brought 4)</Text></Text>
      <Box marginTop={1}><Text bold>State updates</Text></Box>
      <Text>  <Text color="white">o3 = 45</Text>          <Text dimColor>— opp HP set to 45%</Text></Text>
      <Text>  <Text color="white">m2 = 145</Text>         <Text dimColor>— my mon HP set to 145 raw</Text></Text>
      <Text>  <Text color="white">hp m1=45 o1=30%</Text>  <Text dimColor>— bulk HP update at end of turn</Text></Text>
      <Text>  <Text color="white">o2 ko</Text>            <Text dimColor>— mark fainted</Text></Text>
      <Text>  <Text color="white">o3 in o1</Text>         <Text dimColor>— bring teamIndex into active slot</Text></Text>
      <Text>  <Text color="white">m1 mega</Text>          <Text dimColor>— flag a mega evolution (log BEFORE the turn's moves)</Text></Text>
      <Text>  <Text color="white">o1 brn</Text> / <Text color="white">par</Text> / <Text color="white">psn</Text> / <Text color="white">tox</Text> / <Text color="white">slp</Text> / <Text color="white">frz</Text> / <Text color="white">cure</Text></Text>
      <Text>  <Text color="white">o1 +2 atk</Text>        <Text dimColor>— stat boost (or -1, multiple stats OK)</Text></Text>
      <Text>  <Text color="white">o1 wp</Text> / <Text color="white">sash</Text> / <Text color="white">balloon</Text>  <Text dimColor>— named item triggers</Text></Text>
      <Text>  <Text color="white">o2 leftovers</Text>    <Text dimColor>— EOT Leftovers tick (+6% / 1/16) + confirms the item</Text></Text>
      <Text>  <Text color="white">o1 sitrus</Text>       <Text dimColor>— Sitrus heal (+25%)</Text></Text>
      <Text>  <Text color="white">m rocks on</Text> · <Text color="white">o spikes 2</Text> · <Text color="white">o tspikes 1</Text> · <Text color="white">o web on</Text></Text>
      <Box marginTop={1}><Text bold>Slash commands</Text></Box>
      <Text>  <Text color="white">/next</Text> (/n)       <Text dimColor>finalize the turn</Text></Text>
      <Text>  <Text color="white">/undo</Text> (/u)       <Text dimColor>remove a drafted action (/undo or /undo N)</Text></Text>
      <Text>  <Text color="white">/edit</Text> (/e)       <Text dimColor>edit drafted action N back into the input box</Text></Text>
      <Text>  <Text color="white">/save</Text> (/s)       <Text dimColor>snapshot match to disk</Text></Text>
      <Text>  <Text color="white">/info</Text> (/i)       <Text dimColor>open opponent info picker</Text></Text>
      <Text>  <Text color="white">/crit</Text> (/c)       <Text dimColor>toggle crit damage column</Text></Text>
      <Text>  <Text color="white">/allmoves</Text> (/a)   <Text dimColor>show all my moves per opp</Text></Text>
      <Text>  <Text color="white">/review</Text> (/r)     <Text dimColor>ask Pikachu (Claude) to review last turn</Text></Text>
      <Text>  <Text color="white">/pika</Text> (/p)       <Text dimColor>toggle Pikachu sprite (sixel preview)</Text></Text>
      <Text>  <Text color="white">/export</Text> (/x)     <Text dimColor>show current team as Showdown export</Text></Text>
      <Text>  <Text color="white">/ask m1 vs o3</Text>    <Text dimColor>hypothetical matchup; "/ask Delphox-Mega vs Sneasler" works too</Text></Text>
      <Text>  <Text color="white">/help</Text> (/h, /?)   <Text dimColor>this panel</Text></Text>
      <Text>  <Text color="white">/quit</Text> (/q)       <Text dimColor>end match and return to menu</Text></Text>
      <Box marginTop={1}>
        <Text dimColor>Esc to close · Tab accepts the highlighted suggestion</Text>
      </Box>
    </Box>
  );
}

// One row of the opp roster: name, brought marker, types from Pikalytics
// items/abilities/moves/speed-bounds.
interface OppRowProps {
  stores: Stores;
  index: number;
  entry: OpponentEntry;
  marker: string;
  color?: string;
  choiceLock?: ChoiceLock | null;
}
function OppRow({ stores, entry, marker, color, choiceLock }: OppRowProps) {
  const pik = stores.pikalytics.get(entry.species);
  const fetching = !pik && stores.pikalytics.isFetching(entry.species);
  const topItem = pik?.items.find(i => i.name.toLowerCase() !== 'other');
  // Show the combined speed range (inferred → candidates → envelope) so the
  // user always sees a number rather than 'unknown' — and can watch it
  // tighten as turns are logged.
  const speedRange = effectiveSpeedRange(entry);
  const speed = speedRange
    ? speedRange.min === speedRange.max
      ? `${speedRange.min}`
      : `${speedRange.min}–${speedRange.max} (${speedRange.source})`
    : null;
  const inferred = entry.candidates?.length ? mostLikely(entry.candidates, entry.candidateLikelihoods) : null;
  const effectiveColor = entry.fainted ? 'gray' : color;
  return (
    <Box flexDirection="column">
      <Text color={effectiveColor as any}>
        {' '}{marker} {shortName(entry.megaForme ?? entry.species, 14)}
        {entry.currentHpPercent != null && !entry.fainted ? <Text dimColor> HP {entry.currentHpPercent.toFixed(0)}%</Text> : null}
        {entry.status ? <Text color={statusColor(entry.status)}> {entry.status.toUpperCase()}</Text> : null}
        {entry.fainted ? <Text color="gray"> KO</Text> : null}
        {entry.scarfChance != null && entry.scarfChance > 0 ? (
          <Text color={entry.scarfChance >= 50 ? 'yellow' : 'gray'}> ⚡scarf? {entry.scarfChance}%</Text>
        ) : null}
        {entry.megaUsed ? <Text color="magenta"> M</Text> : null}
        {entry.charging ? <Text color="cyan"> ⚡charging {entry.charging.move}</Text> : null}
        {choiceLock && !entry.fainted && !entry.itemConsumed ? <Text color="yellow"> 🔒{entry.scarfSuspected ? 'Choice Scarf?' : 'Choice?'} {choiceLock.move} ×{choiceLock.turns}</Text> : null}
        {entry.taunted ? <Text color="magenta"> 🤬Taunt{entry.tauntTurns ? `(${entry.tauntTurns})` : ''}</Text> : null}
        {entry.encoreMove ? <Text color="magenta"> 🔁Encore {entry.encoreMove}{entry.encoreTurns ? `(${entry.encoreTurns})` : ''}</Text> : null}
        {entry.disabledMove ? <Text color="magenta"> 🚫Disable {entry.disabledMove}{entry.disableTurns ? `(${entry.disableTurns})` : ''}</Text> : null}
        {entry.substitute != null ? <Text color="cyan"> [Sub {Math.round(entry.substitute)}%]</Text> : null}
        {entry.perishCount != null ? <Text color="red"> ☠Perish {entry.perishCount}</Text> : null}
        {entry.saltCured ? <Text color="yellow"> ⬡Salt Cure</Text> : null}
        {entry.partialTrap ? <Text color="yellow"> ⛓trapped({entry.partialTrap})</Text> : null}
      </Text>
      {fetching && (
        <Text dimColor>      (fetching Pikalytics…)</Text>
      )}
      {(topItem || inferred?.item) && (
        <Text dimColor>      item: {entry.itemConsumed
          ? <Text strikethrough>{entry.itemConsumed}</Text>
          : (inferred?.item ?? topItem?.name)
        }{topItem && !inferred?.item && !entry.itemConsumed ? ` ${topItem.pct.toFixed(0)}%` : ''}</Text>
      )}
      {entry.currentBoosts && Object.keys(entry.currentBoosts).length > 0 && (
        <Text color="yellow">      boosts: {formatBoosts(entry.currentBoosts)}</Text>
      )}
      {speed && <Text dimColor>      speed: {speed}</Text>}
      {entry.knownMoves.length > 0 && (
        <Text dimColor>      seen: {entry.knownMoves.join(', ')}</Text>
      )}
    </Box>
  );
}

function formatBoosts(b: Partial<Record<string, number>>): string {
  return Object.entries(b)
    .filter(([, v]) => v != null && v !== 0)
    .map(([k, v]) => `${(v as number) > 0 ? '+' : ''}${v} ${k}`)
    .join(' ');
}

function statusColor(s: 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz'): string {
  switch (s) {
    case 'brn': return 'red';
    case 'par': return 'yellow';
    case 'psn': case 'tox': return 'magenta';
    case 'slp': return 'gray';
    case 'frz': return 'cyan';
  }
}

// One row of the matchup grid for a given (my-active, opp) pair. Shows
// offense (I deal) → opp ← threat (I take), plus a speed glyph.
interface MatchupRowProps {
  marker: string;
  opp: OpponentEntry;
  offense: MatchupCell | null;
  offenseCrit?: MatchupCell | null;
  // When set (via the `a` toggle), render one line per move instead of a
  // single best-move line. allOffenseCrit (when set with allOffense) carries
  // the crit variant of each move, zipped by move name.
  allOffense?: MatchupCell[] | null;
  allOffenseCrit?: MatchupCell[] | null;
  threat: MatchupCell | null;
  // When the threat move is a spread move, its (spread-reduced) damage to my
  // OTHER active — so the row can show it hits both my mons at once.
  threatSpread?: { species: string; min: number; max: number } | null;
  // Flinch chance (0..1) of the threat move's secondary; 0 if it can't flinch.
  threatFlinch?: number;
  verdict: SpeedVerdict;
  // Post-mega variants — set only when the my-side mon holds an unused mega
  // stone. Surfaced inline as "(mega: X-Y%)" / "(mega ✓)" so the user can
  // compare both formes at a glance before deciding to pop mega.
  offenseMega?: MatchupCell | null;
  threatMega?: MatchupCell | null;
  verdictMega?: SpeedVerdict | null;
  dim: boolean;
  active: boolean;
}
function MatchupRow({ marker, opp, offense, offenseCrit, allOffense, allOffenseCrit, threat, threatSpread, threatFlinch, verdict, offenseMega, threatMega, verdictMega, dim, active }: MatchupRowProps) {
  const oppLabel = shortName(opp.species, 12).padEnd(12);
  if (opp.fainted) {
    return (
      <Text color="gray">
        {'  '}{marker} {oppLabel}  — KO —
      </Text>
    );
  }
  // Frozen / asleep mons can't act this turn under default rules. Surface
  // that visually so the user reads the row as "no immediate threat".
  const incap = opp.status === 'slp' || opp.status === 'frz';
  if (incap) {
    return (
      <Text dimColor>
        {'  '}{marker} {oppLabel}  — {opp.status!.toUpperCase()} (won't act) —
      </Text>
    );
  }
  const hpTag = opp.currentHpPercent != null ? ` [HP ${opp.currentHpPercent.toFixed(0)}%]` : '';
  // Honest envelope is the min-max range; the likely sub-range (most-likely /
  // least-invested spread) is appended with a confidence tag when inference has
  // pinned it AND it's tighter than the envelope.
  const confTag = (c?: Confidence) => (c === 'high' ? 'hi' : c === 'med' ? 'med' : 'lo');
  const likelyTxt = (cell?: MatchupCell | null) => {
    if (!cell || cell.likelyMinPercent == null || cell.likelyMaxPercent == null || !cell.confidence) return '';
    const tighter = cell.likelyMinPercent > cell.minPercent + 0.5 || cell.likelyMaxPercent < cell.maxPercent - 0.5;
    if (!tighter) return ` (${confTag(cell.confidence)})`;
    return ` · likely ${cell.likelyMinPercent.toFixed(0)}-${cell.likelyMaxPercent.toFixed(0)}% (${confTag(cell.confidence)})`;
  };
  const offTxt = offense
    ? `${offense.move} ${offense.minPercent.toFixed(0)}-${offense.maxPercent.toFixed(0)}% (${offense.koChance})${likelyTxt(offense)}${offense.conditional ? ` ⚠ ${offense.conditional}` : ''}`
    : 'n/a';
  const critTxt = offenseCrit
    ? ` / crit ${offenseCrit.minPercent.toFixed(0)}-${offenseCrit.maxPercent.toFixed(0)}%`
    : '';
  // Append "(mega: X-Y%)" when the post-mega prediction exists and differs
  // meaningfully from the base. If the move flips too (e.g. base coverage vs
  // mega STAB), include the move name; otherwise just the range.
  const offMegaTxt = offenseMega
    ? offenseMega.move === offense?.move
      ? ` ⭢mega ${offenseMega.minPercent.toFixed(0)}-${offenseMega.maxPercent.toFixed(0)}%`
      : ` ⭢mega ${offenseMega.move} ${offenseMega.minPercent.toFixed(0)}-${offenseMega.maxPercent.toFixed(0)}%`
    : '';
  const thrTxt = threat
    ? `${threat.move} ${threat.minPercent.toFixed(0)}-${threat.maxPercent.toFixed(0)}%${likelyTxt(threat)}`
    : 'n/a';
  const thrMegaTxt = threatMega
    ? threatMega.move === threat?.move
      ? ` ⭢mega ${threatMega.minPercent.toFixed(0)}-${threatMega.maxPercent.toFixed(0)}%`
      : ` ⭢mega ${threatMega.move} ${threatMega.minPercent.toFixed(0)}-${threatMega.maxPercent.toFixed(0)}%`
    : '';
  // Spread collateral (this move also hits my other active) + flinch chance.
  // Both are properties of the SAME threat move; surfaced inline so the user
  // sees a spread move's full impact without expanding anything.
  const thrSpreadTxt = threatSpread
    ? ` · spread→${shortName(threatSpread.species, 8)} ${threatSpread.min.toFixed(0)}-${threatSpread.max.toFixed(0)}%`
    : '';
  const thrFlinchTxt = threatFlinch ? ` · ${Math.round(threatFlinch * 100)}% flinch` : '';
  const thrSfx = `${thrSpreadTxt}${thrFlinchTxt}`;
  const glyphFor = (v: SpeedVerdict): { ch: string; color?: string } =>
    v === 'faster'     ? { ch: '✓', color: 'green' } :
    v === 'slower'     ? { ch: '✗', color: 'red' } :
    v === 'tie'        ? { ch: '≈', color: 'yellow' } :
    v === 'scarf-flag' ? { ch: '⚡', color: 'yellow' } :
                         { ch: '?', color: 'gray' };
  const glyph = glyphFor(verdict);
  const glyphMega = verdictMega ? glyphFor(verdictMega) : null;

  // When `a` is on we render the opp's header line (with threat + speed)
  // followed by one indented line per move in the attacker's pool. Each
  // line carries its damage range + KO odds, and when `c` is also on, a
  // ` / crit …` suffix using the per-move crit variant.
  if (allOffense && allOffense.length > 0) {
    const critByMove = new Map<string, { minPercent: number; maxPercent: number; koChance: string }>();
    for (const c of allOffenseCrit ?? []) critByMove.set(c.move, c);
    return (
      <Box flexDirection="column">
        <Text dimColor={dim}>
          {'  '}{marker} {oppLabel}{hpTag}  ← {thrTxt}{thrMegaTxt}{thrSfx}  {dim ? glyph.ch : <Text color={glyph.color as any}>{glyph.ch}</Text>}{glyphMega ? (dim ? `/${glyphMega.ch}` : <>/<Text color={glyphMega.color as any}>{glyphMega.ch}</Text></>) : null}
        </Text>
        {allOffense.map(m => {
          const crit = critByMove.get(m.move);
          const critSfx = crit
            ? ` / crit ${crit.minPercent.toFixed(0)}-${crit.maxPercent.toFixed(0)}%`
            : '';
          const line = `${m.move.padEnd(16)} ${m.minPercent.toFixed(0)}-${m.maxPercent.toFixed(0)}% (${m.koChance})${critSfx}`;
          return (
            <Text key={`${marker}-${m.move}`} dimColor={dim}>
              {'        → '}{line}
            </Text>
          );
        })}
      </Box>
    );
  }

  if (dim) {
    return (
      <Text dimColor>
        {'  '}{marker} {oppLabel}{hpTag}  → {offTxt}{critTxt}{offMegaTxt}  ← {thrTxt}{thrMegaTxt}{thrSfx}  {glyph.ch}{glyphMega ? `/${glyphMega.ch}` : ''}
      </Text>
    );
  }
  return (
    <Text color={active ? undefined : undefined}>
      {'  '}{marker} {oppLabel}{hpTag}  → {offTxt}{critTxt}{offMegaTxt}  ← {thrTxt}{thrMegaTxt}{thrSfx}  <Text color={glyph.color as any}>{glyph.ch}</Text>{glyphMega ? <><Text>/</Text><Text color={glyphMega.color as any}>{glyphMega.ch}</Text></> : null}
    </Text>
  );
}

// Detail panel for one opp — shows everything we know: Pikalytics top
// items/abilities/moves with %, observed knownMoves, the top inferred
// candidate spread, and base stats. Read-only; close via Esc/i.
interface OppInfoPanelProps { stores: Stores; index: number; entry: OpponentEntry }
function OppInfoPanel({ stores, index, entry }: OppInfoPanelProps) {
  const pik = stores.pikalytics.get(entry.species);
  // Active species name = mega forme if megaed, otherwise the base.
  // Pikalytics data is keyed by base (mega formes aren't in the cache),
  // but base stats + types switch to the mega forme post-evolution.
  const activeSpecies = entry.megaForme ?? entry.species;
  const species = getSpecies(activeSpecies) as any;
  const bs = species?.baseStats;
  const types = (species?.types as string[] | undefined) ?? [];
  const top = entry.candidates?.length ? mostLikely(entry.candidates, entry.candidateLikelihoods) : null;
  // effectiveSpeedRange walks the same priority chain as predictTurnOrder
  // (inferred bounds → candidates → bare envelope) so the panel always
  // surfaces a number and labels its source.
  const speedRange = effectiveSpeedRange(entry);
  const speed = speedRange
    ? speedRange.min === speedRange.max
      ? `${speedRange.min}`
      : `${speedRange.min}–${speedRange.max} (${speedRange.source})`
    : 'unknown';
  const fmtRow = (rows: { name: string; pct: number }[], n = 3) =>
    rows.filter(r => r.name.toLowerCase() !== 'other').slice(0, n)
      .map(r => `${r.name} ${r.pct.toFixed(0)}%`).join(' · ');
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        o{index + 1} {activeSpecies} <Text dimColor>[{types.join('/') || '?'}]</Text>
        {entry.currentHpPercent != null && !entry.fainted ? <Text> HP {entry.currentHpPercent.toFixed(0)}%</Text> : null}
        {entry.fainted ? <Text color="gray"> (KO)</Text> : null}
        <Text dimColor> · spd {speed}</Text>
        {entry.scarfChance != null && entry.scarfChance > 0 ? (
          <Text color={entry.scarfChance >= 50 ? 'yellow' : 'gray'}> ⚡scarf? {entry.scarfChance}%</Text>
        ) : null}
        {entry.megaUsed ? <Text color="magenta"> mega'd</Text> : null}
      </Text>
      {bs && (
        <Text dimColor>
          Base: HP {bs.hp} / Atk {bs.atk} / Def {bs.def} / SpA {bs.spa} / SpD {bs.spd} / Spe {bs.spe}
        </Text>
      )}
      {entry.knownMoves.length > 0 && (
        <Text>Seen this match: <Text color="white">{entry.knownMoves.join(', ')}</Text></Text>
      )}
      {pik?.items.length ? <Text dimColor>Pik items: {fmtRow(pik.items)}</Text> : null}
      {pik?.abilities.length ? <Text dimColor>Pik abilities: {fmtRow(pik.abilities)}</Text> : null}
      {pik?.moves.length ? <Text dimColor>Pik moves: {fmtRow(pik.moves, 4)}</Text> : null}
      {top && (
        <Text>
          Top inferred: <Text color="white">{top.nature}</Text>
          {top.item ? <Text> · item <Text color="white">{top.item}</Text></Text> : null}
          {top.ability ? <Text> · ability <Text color="white">{top.ability}</Text></Text> : null}
        </Text>
      )}
      {top && (
        <Text dimColor>
          EVs: HP {top.evs.hp} / Atk {top.evs.atk} / Def {top.evs.def} / SpA {top.evs.spa} / SpD {top.evs.spd} / Spe {top.evs.spe}
        </Text>
      )}
      {entry.candidates && entry.candidates.length > 1 && (
        <Text dimColor>...and {entry.candidates.length - 1} other spread(s) still consistent with observations</Text>
      )}
      <Text dimColor>──── [Esc / i] to close ────</Text>
    </Box>
  );
}
