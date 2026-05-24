import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import type { Match, FieldState, DamageObservation, MoveAction, OpponentEntry, PokemonSet } from '@pokechamps/core/domain/types.js';
import { NEUTRAL_FIELD } from '@pokechamps/core/domain/types.js';
import { inferSpread, mostLikely } from '@pokechamps/core/domain/inference.js';
import { maxHpFor } from '@pokechamps/core/domain/damage.js';
import { endOfTurn } from '@pokechamps/core/domain/endOfTurn.js';
import { inferOpponentSpeeds, applySpeedInference, actualSpeed, predictTurnOrder, effectiveSpeedRange } from '@pokechamps/core/domain/speed.js';
import { reviewLastTurn } from '@pokechamps/core/ai/prompts.js';
import { isAvailable as aiAvailable } from '@pokechamps/core/ai/client.js';
import type { Stores } from '@pokechamps/core/storage/index.js';
import { getSpecies, isChargeMove, isPivotMove, isItemRemovingMove } from '@pokechamps/core/domain/data.js';
import { defaultOpponentSet } from '@pokechamps/core/domain/bring.js';
import { parseTurnLine, type ParseContext, type StateUpdate, type HazardUpdate } from '@pokechamps/core/domain/turnparser.js';
import { applyHazardVerb, applyHazardsToSwitchIn, absorbsToxicSpikes, hazardGlyphs, hazardClearEffect, applyHazardClear } from '@pokechamps/core/domain/hazards.js';
import { fieldMoveEffect, applyFieldMove } from '@pokechamps/core/domain/fieldMoves.js';
import { switchInAbilityEffect, intimidateReaction, certainAbility, type BoostMap } from '@pokechamps/core/domain/abilities.js';
import { deriveSuggestionContext, getSuggestions, applySuggestion } from '@pokechamps/core/domain/actionSuggest.js';
import { predictOffense, predictOffenseAll, predictThreat, speedVerdict, type SpeedVerdict } from '@pokechamps/core/domain/predictions.js';
import { PikaSpinner } from './PikaSpinner.js';
import { ExportPanel } from './ExportPanel.js';
import { OverridePanel } from './OverridePanel.js';
import { formatShowdownTeamSP } from '@pokechamps/core/domain/showdown.js';
import { BATTLE_COMMANDS, parseCommand, type BattleCommandId } from './slashCommands.js';
import { deriveActiveIdx } from '@pokechamps/core/match/engine.js';
import { applyMegaAction } from '@pokechamps/core/domain/megaResolve.js';
import { getMegaOptions } from '@pokechamps/core/domain/gimmicks/mega.js';

export interface BattleScreenProps {
  stores: Stores;
  match: Match;
  // Optional `intent` lets the user pick "new match" from the match-end
  // menu and have the parent route accordingly. Default behaviour is back
  // to main menu.
  onEnd: (intent?: 'menu' | 'new-match') => void;
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
  // Poison-type absorbs toxic spikes on entry.
  if (absorbsToxicSpikes({ species: incoming.species })) {
    if (side === 'mine' && match.field?.myHazards?.toxicSpikes) {
      match.field = { ...match.field, myHazards: { ...match.field.myHazards, toxicSpikes: 0 } };
    } else if (side === 'theirs' && match.field?.theirHazards?.toxicSpikes) {
      match.field = { ...match.field, theirHazards: { ...match.field.theirHazards, toxicSpikes: 0 } };
    }
  }
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
    if (effect.weather) { f.weather = effect.weather; notes.push(`${incoming.species}'s ${ability} set ${effect.weather}`); }
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
function runAskCommand(
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

  const off = predictOffense({
    attacker: mine.set, opponent: opp.entry, field,
    attackerGimmickActive: mine.megaActive,
    defenderGimmickActive: opp.megaActive,
  });
  const thr = predictThreat({
    opponent: opp.entry, defender: mine.set, field,
    attackerGimmickActive: opp.megaActive,
    defenderGimmickActive: mine.megaActive,
  });
  const sp = speedVerdict({
    mySet: mine.set, opp: opp.entry, field,
    myFormeOverride: mine.megaActive ? mine.megaForme ?? undefined : undefined,
  });
  const verdict = sp === 'faster' ? '✓ outspeed' : sp === 'slower' ? '✗ outsped' :
                  sp === 'tie' ? '≈ tie' : sp === 'scarf-flag' ? '⚡ scarf risk' :
                  '? unknown';
  const offTxt = off
    ? `${off.move} ${off.minPercent.toFixed(0)}-${off.maxPercent.toFixed(0)}% (${off.koChance})`
    : 'n/a';
  const thrTxt = thr
    ? `${thr.move} ${thr.minPercent.toFixed(0)}-${thr.maxPercent.toFixed(0)}% (${thr.koChance})`
    : 'n/a';
  return `${mine.label} vs ${opp.label}\n  → ${offTxt}\n  ← ${thrTxt}\n  speed: ${verdict}`;
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

export function BattleScreen({ stores, match: initial, onEnd }: BattleScreenProps) {
  const [match, setMatch] = useState<Match>(initial);
  const [input, setInput] = useState('');
  const [draftActions, setDraftActions] = useState<MoveAction[]>([]);
  const [activeIdx, setActiveIdx] = useState(() => initialActiveIndices(initial));
  const [message, setMessage] = useState<string>('');
  // Index in the in-progress autocomplete suggestion list.
  const [highlight, setHighlight] = useState(0);
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
    };

    // Walk damaging actions in order, deriving each action's damageHpPercent
    // from previous-vs-remaining HP. Maintains per-target running HP across
    // multi-hit turns so e.g. two attacks on the same opp compute their
    // damages relative to each other. Final HP per target is committed to
    // opponentTeam / myCurrentHp afterwards.
    const oppHpSoFar = new Map<number, number>();
    const myHpSoFar = new Map<number, number>();
    const sortedActions = [...draftActions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const a of sortedActions) {
      if (a.kind === 'switch' || a.kind === 'mega') continue;
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
      // the correct value (independent of how the user typed it).
      a.damageHpPercent = Math.max(0, prevPct - newPct);
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
      next.field = applyFieldMove(next.field ?? NEUTRAL_FIELD, a.side, fm);
      inferenceNotes.push(`${a.move} set field state`);
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
    for (const a of draftActions) {
      if (a.kind === 'switch' || a.kind === 'mega') continue;
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
        critical: a.critical,
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
          // Skip the ~360k-candidate coarse-grid fallback when priors fail.
          // It blocks the UI for 10+ seconds and is rarely useful — usually
          // the observation was mis-logged (e.g. wrong damage % or move).
          // We accept an empty candidate list and let the next observation
          // re-narrow from priors instead.
          quickOnly: true,
        });
        const candidateSets = candidates.map(c => ({
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
      } catch (e) {
        inferenceNotes.push(`${opp.species}: inference failed`);
      }
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
        if (outgoing != null) delete next.myBoosts[outgoing];
        nextActive.mine[a.attackerSlot] = a.targetTeamIndex;
      } else {
        const outgoing = nextActive.theirs[a.attackerSlot];
        if (outgoing != null && next.opponentTeam[outgoing]) {
          next.opponentTeam[outgoing] = { ...next.opponentTeam[outgoing], currentBoosts: {} };
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

    next.outcome = detectOutcome(next);
    setMatch(next);
    setActiveIdx(nextActive);
    setDraftActions([]);
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
        if (o) {
          o.status = update.status;
          if (update.status === 'tox') o.toxCounter = 1;
          // Sleep is 1-3 turns; default to 2 (mean). Caller can override
          // later if they observe an early wake or full duration.
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
    if (update.bringIntoSlot != null) {
      // Boosts on the OUTGOING active reset on switch-out (game mechanic). The
      // incoming mon starts with whatever boosts they already had stored —
      // typically none for a first appearance.
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
        setFinalizing(true);
        setTimeout(() => {
          try { finalizeTurn(); } finally { setFinalizing(false); }
        }, 0);
        return true;
      case 'undo':
        if (draftActions.length === 0) {
          setMessage('Nothing to undo — no drafted actions this turn.');
        } else {
          const last = draftActions[draftActions.length - 1]!;
          setDraftActions(prev => prev.slice(0, -1));
          setMessage(`Removed: ${actionToLine(last, match)}`);
        }
        return true;
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
    if (exportPanelText != null) {
      if (key.escape) setExportPanelText(null);
      return;
    }
    if (key.escape) onEnd();
    if (suggestions.length > 0) {
      if (key.upArrow) setHighlight(h => Math.max(0, h - 1));
      else if (key.downArrow) setHighlight(h => Math.min(suggestions.length - 1, h + 1));
      else if (key.tab && suggestions[highlight]) {
        setInput(applySuggestion(input, suggestions[highlight]!, sctx.kind));
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
      };
    }),
    oppActives: [0, 1].map(s => ({ slot: s as 0 | 1, entry: activeIdx.theirs[s] != null ? match.opponentTeam[activeIdx.theirs[s]!] ?? null : null })),
    field,
  });

  const matchups = activeIdx.mine.map(myIdx => {
    if (myIdx == null) return null;
    const mySet = match.myTeam[myIdx];
    if (!mySet) return null;
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
    // Common args for prediction calls — only the active flag flips when we
    // compute the "what if I mega'd" variant.
    const baseOpts = {
      attackerBoosts: myBoosts,
      defenderBoosts: undefined as Partial<Record<string, number>> | undefined,
      attackerStatus: myStatus,
      defenderStatus: undefined as string | undefined,
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
        return {
          opp,
          oppIdx: oi,
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
          threat: predictThreat({
            opponent: opp, defender: myCalcSet, field,
            attackerGimmickActive: oppActive,
            defenderGimmickActive: myMegaActive,
            defenderCurrentHpPercent: myHp,
            attackerBoosts: opp.currentBoosts,
            defenderBoosts: myBoosts,
            attackerStatus: opp.status,
            defenderStatus: myStatus,
          }),
          // Dual-forme: compute the same offense + threat using post-mega
          // stats, so the row can surface "(mega: X-Y%)" alongside the base
          // numbers. Only built when the mon could still mega.
          offenseMega: myMegaOption ? predictOffense({
            attacker: myCalcSet, opponent: opp, field,
            attackerGimmickActive: true,
            defenderGimmickActive: oppActive,
            defenderCurrentHpPercent: opp.currentHpPercent,
            ...baseOpts,
            defenderBoosts: opp.currentBoosts,
            defenderStatus: opp.status,
          }) : null,
          threatMega: myMegaOption ? predictThreat({
            opponent: opp, defender: myCalcSet, field,
            attackerGimmickActive: oppActive,
            defenderGimmickActive: true,
            defenderCurrentHpPercent: myHp,
            attackerBoosts: opp.currentBoosts,
            defenderBoosts: myBoosts,
            attackerStatus: opp.status,
            defenderStatus: myStatus,
          }) : null,
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
      {match.outcome && (
        <Box flexDirection="column" borderStyle="double" borderColor={match.outcome === 'victory' ? 'green' : match.outcome === 'defeat' ? 'red' : 'yellow'} paddingX={2} marginY={1}>
          <Text bold color={match.outcome === 'victory' ? 'green' : match.outcome === 'defeat' ? 'red' : 'yellow'}>
            {match.outcome === 'victory' ? '🏆 Victory!' : match.outcome === 'defeat' ? '💀 Defeat.' : '🤝 Tie.'}
          </Text>
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
            // Active mons → slot ref (★m1/★m2). Benched → team-index ref so the
            // user knows what to type for "m4 in m1", "m4 = 120", etc.
            const slotMarker = teamIdx === a0 ? '★m1' : teamIdx === a1 ? '★m2' : `m${teamIdx + 1}`.padEnd(3);
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
              </Box>
            );
          })}

          <Box marginTop={1}><Text bold color="red">Opponent</Text></Box>
          {match.opponentTeam.map((o, i) => {
            const brought = oppBroughtIndices.includes(i as any);
            const a0 = activeIdx.theirs[0];
            const a1 = activeIdx.theirs[1];
            // Active → slot ref (★o1/★o2). Benched → team-index ref (o3..o6)
            // so the user can target it: "o4 = 30%", "o4 in o1", etc.
            const slotMarker = i === a0 ? '★o1' : i === a1 ? '★o2' : `o${i + 1}`.padEnd(3);
            const color = i === a0 || i === a1 ? 'red' : brought ? undefined : 'gray';
            return (
              <OppRow
                key={`o-${i}`}
                stores={stores}
                index={i}
                entry={o}
                marker={slotMarker}
                color={color}
              />
            );
          })}
          <Box marginTop={1}>
            <Text dimColor>★ = active slot (m1/m2 · o1/o2) · plain mN/oN = that mon's ref for switches + edits · gray = not yet brought</Text>
          </Box>
        </Box>

        {/* Right: matchup grid — both directions, all 6 opps */}
        <Box flexDirection="column" flexGrow={1}>
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

      {/* Turn composer */}
      <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
        <Text bold>Turn {match.turns.length + 1} in progress ({draftActions.length} action{draftActions.length === 1 ? '' : 's'})</Text>
        {draftActions.map((a, i) => {
          const pivot = a.kind !== 'switch' && a.kind !== 'mega' && isPivotMove(a.move);
          return (
            <Text key={i} dimColor>  {i + 1}. {actionToLine(a, match)}{pivot ? <Text color="cyan"> ⟲ pivot — log the switch-in next</Text> : null}</Text>
          );
        })}
        <Box marginTop={draftActions.length > 0 ? 1 : 0}>
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
              const r = parseTurnLine(trimmed, ctxWithDraft, draftActions.length + 1);
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
                setInput('');
                setMessage(`Applied ${r.updates.length} HP updates.`);
                return;
              }
              // r.kind === 'state' — mutate immediately, no turn entry.
              applyStateUpdate(r.update);
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
                <Text dimColor>↑/↓ pick · Tab apply ({
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
  const dmg = a.damageHpPercent != null ? ` > ${a.damageHpPercent}%` : a.damageRaw != null ? ` > ${a.damageRaw} raw` : '';
  return `${actor} > ${a.move} > ${target}${dmg}`;
}

// Full syntax + commands cheat-sheet shown by /help. Lives in a bordered
// panel near the bottom of the screen. Esc closes it (see the keyboard
// handler higher up — helpOpen takes modal precedence over normal input).
function HelpPanel() {
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">/help — battle syntax + commands</Text>
      <Box marginTop={1}><Text bold>Actions</Text></Box>
      <Text>  <Text color="white">m1 &gt; Close Combat &gt; o1 &gt; 67</Text>      <Text dimColor>— attack; opp now at 67%</Text></Text>
      <Text>  <Text color="white">o1 &gt; Sucker Punch &gt; m1 &gt; 145</Text>     <Text dimColor>— opp attack; you now at 145 raw HP</Text></Text>
      <Text>  <Text color="white">m1 &gt; Sucker Punch &gt; o1 &gt; 41%</Text>     <Text dimColor>— explicit % override</Text></Text>
      <Text>  <Text color="white">m1 &gt; Close Combat &gt; o1 &gt; 80 raw</Text>  <Text dimColor>— damage-DEALT in raw HP</Text></Text>
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
      <Text>  <Text color="white">m rocks on</Text> · <Text color="white">o spikes 2</Text> · <Text color="white">o tspikes 1</Text> · <Text color="white">o web on</Text></Text>
      <Box marginTop={1}><Text bold>Slash commands</Text></Box>
      <Text>  <Text color="white">/next</Text> (/n)       <Text dimColor>finalize the turn</Text></Text>
      <Text>  <Text color="white">/undo</Text> (/u)       <Text dimColor>remove the last drafted action</Text></Text>
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
}
function OppRow({ stores, entry, marker, color }: OppRowProps) {
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
  const inferred = entry.candidates?.length ? mostLikely(entry.candidates) : null;
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
  offense: { move: string; minPercent: number; maxPercent: number; koChance: string; candidatesConsidered: number } | null;
  offenseCrit?: { move: string; minPercent: number; maxPercent: number; koChance: string; candidatesConsidered: number } | null;
  // When set (via the `a` toggle), render one line per move instead of a
  // single best-move line. allOffenseCrit (when set with allOffense) carries
  // the crit variant of each move, zipped by move name.
  allOffense?: Array<{ move: string; minPercent: number; maxPercent: number; koChance: string; candidatesConsidered: number }> | null;
  allOffenseCrit?: Array<{ move: string; minPercent: number; maxPercent: number; koChance: string; candidatesConsidered: number }> | null;
  threat: { move: string; minPercent: number; maxPercent: number; koChance: string; candidatesConsidered: number } | null;
  verdict: SpeedVerdict;
  // Post-mega variants — set only when the my-side mon holds an unused mega
  // stone. Surfaced inline as "(mega: X-Y%)" / "(mega ✓)" so the user can
  // compare both formes at a glance before deciding to pop mega.
  offenseMega?: { move: string; minPercent: number; maxPercent: number; koChance: string; candidatesConsidered: number } | null;
  threatMega?: { move: string; minPercent: number; maxPercent: number; koChance: string; candidatesConsidered: number } | null;
  verdictMega?: SpeedVerdict | null;
  dim: boolean;
  active: boolean;
}
function MatchupRow({ marker, opp, offense, offenseCrit, allOffense, allOffenseCrit, threat, verdict, offenseMega, threatMega, verdictMega, dim, active }: MatchupRowProps) {
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
  const offTxt = offense
    ? `${offense.move} ${offense.minPercent.toFixed(0)}-${offense.maxPercent.toFixed(0)}% (${offense.koChance})`
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
    ? `${threat.move} ${threat.minPercent.toFixed(0)}-${threat.maxPercent.toFixed(0)}%`
    : 'n/a';
  const thrMegaTxt = threatMega
    ? threatMega.move === threat?.move
      ? ` ⭢mega ${threatMega.minPercent.toFixed(0)}-${threatMega.maxPercent.toFixed(0)}%`
      : ` ⭢mega ${threatMega.move} ${threatMega.minPercent.toFixed(0)}-${threatMega.maxPercent.toFixed(0)}%`
    : '';
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
          {'  '}{marker} {oppLabel}{hpTag}  ← {thrTxt}{thrMegaTxt}  {dim ? glyph.ch : <Text color={glyph.color as any}>{glyph.ch}</Text>}{glyphMega ? (dim ? `/${glyphMega.ch}` : <>/<Text color={glyphMega.color as any}>{glyphMega.ch}</Text></>) : null}
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
        {'  '}{marker} {oppLabel}{hpTag}  → {offTxt}{critTxt}{offMegaTxt}  ← {thrTxt}{thrMegaTxt}  {glyph.ch}{glyphMega ? `/${glyphMega.ch}` : ''}
      </Text>
    );
  }
  return (
    <Text color={active ? undefined : undefined}>
      {'  '}{marker} {oppLabel}{hpTag}  → {offTxt}{critTxt}{offMegaTxt}  ← {thrTxt}{thrMegaTxt}  <Text color={glyph.color as any}>{glyph.ch}</Text>{glyphMega ? <><Text>/</Text><Text color={glyphMega.color as any}>{glyphMega.ch}</Text></> : null}
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
  const top = entry.candidates?.length ? mostLikely(entry.candidates) : null;
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
