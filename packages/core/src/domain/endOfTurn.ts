import type { Match, FieldState, OpponentEntry, PokemonSet } from './types.js';
import { maxHpFor } from './damage.js';
import { getSpecies } from './data.js';
import { defaultOpponentSet } from './bring.js';

// Returns a fresh Match with end-of-turn effects applied to the four actives:
//   - Weather chip (sandstorm/hail/snow), with type immunities
//   - Burn / poison / toxic damage
//   - Leftovers / Black Sludge healing on MINE side only (opp items usually
//     uncertain — surfacing wrong heals is worse than missing them)
//   - Tox counter ramps each turn it ticks
//
// Does NOT modify active-slot or `outcome` — caller (BattleScreen.finalizeTurn)
// runs `detectOutcome` afterwards and may clear empty slots.
export function endOfTurn(
  match: Match,
  field: FieldState,
  activeIdx: { mine: [number | null, number | null]; theirs: [number | null, number | null] },
): { match: Match; notes: string[] } {
  const notes: string[] = [];
  const next: Match = {
    ...match,
    opponentTeam: match.opponentTeam.map(o => ({ ...o })),
    myCurrentHp: { ...(match.myCurrentHp ?? {}) },
    myFainted: [...(match.myFainted ?? [])],
    myStatus: { ...(match.myStatus ?? {}) },
    myToxCounter: { ...(match.myToxCounter ?? {}) },
    mySleepCounter: { ...(match.mySleepCounter ?? {}) },
    myTaunted: [...(match.myTaunted ?? [])],
    myEncoreMove: { ...(match.myEncoreMove ?? {}) },
    myDisabledMove: { ...(match.myDisabledMove ?? {}) },
    myTauntTurns: { ...(match.myTauntTurns ?? {}) },
    myEncoreTurns: { ...(match.myEncoreTurns ?? {}) },
    myDisableTurns: { ...(match.myDisableTurns ?? {}) },
    field: { ...(match.field ?? field) },
  };

  // Apply per-active EOT effects. Order: weather → status → leftovers
  // (so leftovers can offset chip).
  const applyToOpp = (idx: number | null) => {
    if (idx == null) return;
    const o = next.opponentTeam[idx];
    if (!o || o.fainted) return;
    const types = (getSpecies(o.species) as any)?.types as string[] | undefined;
    // Weather chip
    const wChip = weatherChipPct(field.weather, types);
    if (wChip > 0) { o.currentHpPercent = clampHp((o.currentHpPercent ?? 100) - wChip); notes.push(`o${idx + 1} -${wChip.toFixed(0)}% (${field.weather})`); }
    // Status tick
    const statusChip = statusChipPct(o.status, o.toxCounter ?? 0);
    if (statusChip > 0) {
      o.currentHpPercent = clampHp((o.currentHpPercent ?? 100) - statusChip);
      notes.push(`o${idx + 1} -${statusChip.toFixed(0)}% (${o.status})`);
      if (o.status === 'tox') o.toxCounter = (o.toxCounter ?? 1) + 1;
    }
    // Sleep counter ticks down; status clears at 0.
    if (o.status === 'slp') {
      const c = (o.sleepCounter ?? 1) - 1;
      if (c <= 0) { o.status = undefined; o.sleepCounter = undefined; notes.push(`o${idx + 1} woke up`); }
      else o.sleepCounter = c;
    }
    // Toxic Orb / Flame Orb on opp side: only fire when the item is KNOWN
    // (revealed via inference). Otherwise we'd commit to a guess and corrupt
    // downstream prediction. Existing `itemConsumed` doesn't apply (orbs are
    // persistent), but a Trick/Knock Off-flavoured swap could have removed
    // it — respect that.
    if (!o.itemConsumed) {
      const oppOrbStatus = orbStatusFor(o.item, o.species, o.status ?? undefined);
      if (oppOrbStatus) {
        o.status = oppOrbStatus;
        if (oppOrbStatus === 'tox') o.toxCounter = 1;
        notes.push(`o${idx + 1} ${oppOrbStatus} (${o.item})`);
      }
    }
    if ((o.currentHpPercent ?? 100) === 0) o.fainted = true;
    // Move-restricting volatiles count down; clear at 0.
    if (o.tauntTurns != null) { o.tauntTurns -= 1; if (o.tauntTurns <= 0) { o.taunted = undefined; o.tauntTurns = undefined; notes.push(`o${idx + 1} Taunt ended`); } }
    if (o.encoreTurns != null) { o.encoreTurns -= 1; if (o.encoreTurns <= 0) { o.encoreMove = undefined; o.encoreTurns = undefined; notes.push(`o${idx + 1} Encore ended`); } }
    if (o.disableTurns != null) { o.disableTurns -= 1; if (o.disableTurns <= 0) { o.disabledMove = undefined; o.disableTurns = undefined; notes.push(`o${idx + 1} Disable ended`); } }
  };

  const applyToMine = (idx: number | null) => {
    if (idx == null) return;
    if (next.myFainted!.includes(idx)) return;
    const set = next.myTeam[idx];
    if (!set) return;
    const types = (getSpecies(set.species) as any)?.types as string[] | undefined;
    const wChip = weatherChipPct(field.weather, types);
    if (wChip > 0) { next.myCurrentHp![idx] = clampHp((next.myCurrentHp![idx] ?? 100) - wChip); notes.push(`m${idx + 1} -${wChip.toFixed(0)}% (${field.weather})`); }
    const statusChip = statusChipPct(next.myStatus?.[idx], next.myToxCounter?.[idx] ?? 0);
    if (statusChip > 0) {
      next.myCurrentHp![idx] = clampHp((next.myCurrentHp![idx] ?? 100) - statusChip);
      notes.push(`m${idx + 1} -${statusChip.toFixed(0)}% (${next.myStatus?.[idx]})`);
      if (next.myStatus?.[idx] === 'tox') next.myToxCounter![idx] = (next.myToxCounter![idx] ?? 1) + 1;
    }
    if (next.myStatus?.[idx] === 'slp') {
      const c = (next.mySleepCounter?.[idx] ?? 1) - 1;
      if (c <= 0) { delete next.myStatus[idx]; delete next.mySleepCounter?.[idx]; notes.push(`m${idx + 1} woke up`); }
      else next.mySleepCounter![idx] = c;
    }
    // Leftovers / Black Sludge — mine only.
    if (set.item === 'Leftovers' || set.item === 'Black Sludge') {
      const max = maxHpFor(set);
      const healPct = max > 0 ? (Math.floor(max / 16) / max) * 100 : 0;
      if (healPct > 0) {
        next.myCurrentHp![idx] = clampHp((next.myCurrentHp![idx] ?? 100) + healPct);
        notes.push(`m${idx + 1} +${healPct.toFixed(0)}% (${set.item})`);
      }
    }
    // Toxic Orb / Flame Orb — apply the orb's status at EOT to the holder if
    // they have no existing non-volatile status. Type immunities respected
    // (no brn on Fire types; no tox on Poison/Steel types). Item is NOT
    // consumed (orbs are persistent). The chip from this status starts ticking
    // on the NEXT EOT — the status was applied AFTER this turn's status chip.
    const heldOrbStatus = orbStatusFor(set.item, set.species, next.myStatus?.[idx]);
    if (heldOrbStatus) {
      next.myStatus![idx] = heldOrbStatus;
      if (heldOrbStatus === 'tox') next.myToxCounter![idx] = 1;
      notes.push(`m${idx + 1} ${heldOrbStatus} (${set.item})`);
    }
    if ((next.myCurrentHp![idx] ?? 100) === 0 && !next.myFainted!.includes(idx)) next.myFainted!.push(idx);
    // My-side volatiles count down; clear at 0.
    if (next.myTauntTurns![idx] != null) { const t = next.myTauntTurns![idx]! - 1; if (t <= 0) { next.myTaunted = next.myTaunted!.filter(i => i !== idx); delete next.myTauntTurns![idx]; notes.push(`m${idx + 1} Taunt ended`); } else next.myTauntTurns![idx] = t; }
    if (next.myEncoreTurns![idx] != null) { const t = next.myEncoreTurns![idx]! - 1; if (t <= 0) { delete next.myEncoreMove![idx]; delete next.myEncoreTurns![idx]; notes.push(`m${idx + 1} Encore ended`); } else next.myEncoreTurns![idx] = t; }
    if (next.myDisableTurns![idx] != null) { const t = next.myDisableTurns![idx]! - 1; if (t <= 0) { delete next.myDisabledMove![idx]; delete next.myDisableTurns![idx]; notes.push(`m${idx + 1} Disable ended`); } else next.myDisableTurns![idx] = t; }
  };

  applyToMine(activeIdx.mine[0]);
  applyToMine(activeIdx.mine[1]);
  applyToOpp(activeIdx.theirs[0]);
  applyToOpp(activeIdx.theirs[1]);

  // Leech Seed residual: drain 1/8 of the target's max HP, heal the seeder by
  // the same ABSOLUTE HP (converted to the seeder's % of max). If the seeder
  // has since switched out, the drain still hits but the heal is wasted.
  const maxHpForSide = (side: 'mine' | 'theirs', idx: number): number => {
    if (side === 'mine') return next.myTeam[idx] ? maxHpFor(next.myTeam[idx]!) : 0;
    const e = next.opponentTeam[idx];
    if (!e) return 0;
    const cand = e.candidates?.[0] as PokemonSet | undefined;
    return cand ? maxHpFor(cand) : maxHpFor(defaultOpponentSet(e, 50));
  };
  const applyLeechSeed = (side: 'mine' | 'theirs', idx: number | null) => {
    if (idx == null) return;
    const info = side === 'theirs' ? next.opponentTeam[idx]?.leechSeeded : next.myLeechSeeded?.[idx];
    if (!info) return;
    const targetMax = maxHpForSide(side, idx);
    if (!targetMax) return;
    const drainPct = 100 / 8; // 12.5% of target max
    // Apply drain.
    if (side === 'theirs') {
      const o = next.opponentTeam[idx];
      if (!o || o.fainted) return;
      const after = clampHp((o.currentHpPercent ?? 100) - drainPct);
      o.currentHpPercent = after;
      notes.push(`o${idx + 1} -${drainPct.toFixed(0)}% (Leech Seed)`);
      if (after === 0) o.fainted = true;
    } else {
      if (next.myFainted!.includes(idx)) return;
      const after = clampHp((next.myCurrentHp![idx] ?? 100) - drainPct);
      next.myCurrentHp![idx] = after;
      notes.push(`m${idx + 1} -${drainPct.toFixed(0)}% (Leech Seed)`);
      if (after === 0 && !next.myFainted!.includes(idx)) next.myFainted!.push(idx);
    }
    // Heal the seeder if still active in their slot and not fainted.
    const sActive = (info.seederSide === 'mine' ? activeIdx.mine : activeIdx.theirs).includes(info.seederIndex);
    if (!sActive) return;
    const seederMax = maxHpForSide(info.seederSide, info.seederIndex);
    if (!seederMax) return;
    const healPct = Math.min(100, ((drainPct / 100) * targetMax / seederMax) * 100);
    if (info.seederSide === 'theirs') {
      const so = next.opponentTeam[info.seederIndex];
      if (so && !so.fainted) {
        so.currentHpPercent = clampHp((so.currentHpPercent ?? 100) + healPct);
        notes.push(`o${info.seederIndex + 1} +${healPct.toFixed(0)}% (Leech Seed)`);
      }
    } else if (!next.myFainted!.includes(info.seederIndex)) {
      next.myCurrentHp![info.seederIndex] = clampHp((next.myCurrentHp![info.seederIndex] ?? 100) + healPct);
      notes.push(`m${info.seederIndex + 1} +${healPct.toFixed(0)}% (Leech Seed)`);
    }
  };
  applyLeechSeed('mine', activeIdx.mine[0]);
  applyLeechSeed('mine', activeIdx.mine[1]);
  applyLeechSeed('theirs', activeIdx.theirs[0]);
  applyLeechSeed('theirs', activeIdx.theirs[1]);

  // Field conditions count down on the persistent field; clear at 0.
  const f = next.field;
  if (f.weatherTurns != null) { f.weatherTurns -= 1; if (f.weatherTurns <= 0) { notes.push(`${f.weather ?? 'weather'} ended`); f.weather = null; f.weatherTurns = undefined; } }
  if (f.trickRoomTurns != null) { f.trickRoomTurns -= 1; if (f.trickRoomTurns <= 0) { notes.push('Trick Room ended'); f.trickRoom = false; f.trickRoomTurns = undefined; } }
  if (f.myTailwindTurns != null) { f.myTailwindTurns -= 1; if (f.myTailwindTurns <= 0) { notes.push('m Tailwind ended'); f.myTailwind = false; f.myTailwindTurns = undefined; } }
  if (f.theirTailwindTurns != null) { f.theirTailwindTurns -= 1; if (f.theirTailwindTurns <= 0) { notes.push('o Tailwind ended'); f.theirTailwind = false; f.theirTailwindTurns = undefined; } }
  if (f.myReflectTurns != null) { f.myReflectTurns -= 1; if (f.myReflectTurns <= 0) { notes.push('m Reflect ended'); f.myReflect = false; f.myReflectTurns = undefined; } }
  if (f.myLightScreenTurns != null) { f.myLightScreenTurns -= 1; if (f.myLightScreenTurns <= 0) { notes.push('m Light Screen ended'); f.myLightScreen = false; f.myLightScreenTurns = undefined; } }
  if (f.theirReflectTurns != null) { f.theirReflectTurns -= 1; if (f.theirReflectTurns <= 0) { notes.push('o Reflect ended'); f.theirReflect = false; f.theirReflectTurns = undefined; } }
  if (f.theirLightScreenTurns != null) { f.theirLightScreenTurns -= 1; if (f.theirLightScreenTurns <= 0) { notes.push('o Light Screen ended'); f.theirLightScreen = false; f.theirLightScreenTurns = undefined; } }

  return { match: next, notes };
}

function clampHp(v: number): number {
  return Math.max(0, Math.min(100, v));
}

// Weather chip damage as a % of max HP. Sandstorm hurts non-Rock/Ground/Steel
// types; Hail hurts non-Ice. Snow in modern gens is defensive-only and does
// nothing here. Sun/Rain are passive offence/defence modifiers, no chip.
function weatherChipPct(weather: FieldState['weather'], types: string[] | undefined): number {
  if (!weather) return 0;
  if (weather === 'Sand') {
    if (types && types.some(t => t === 'Rock' || t === 'Ground' || t === 'Steel')) return 0;
    return 100 / 16;
  }
  if (weather === 'Hail') {
    if (types && types.includes('Ice')) return 0;
    return 100 / 16;
  }
  return 0;
}

// Status chip damage as a % of max HP. Tox ramps via the counter.
function statusChipPct(status: OpponentEntry['status'] | undefined, toxCounter: number): number {
  if (!status) return 0;
  if (status === 'brn') return 100 / 16; // 1/16
  if (status === 'psn') return 100 / 8;  // 1/8
  if (status === 'tox') return (100 / 16) * Math.max(1, toxCounter);
  return 0;
}

// Returns the non-volatile status a Toxic/Flame Orb would inflict at EOT, or
// null if the holder is immune (type immunity or already statused).
function orbStatusFor(
  item: string | null | undefined,
  species: string,
  currentStatus: string | undefined | null,
): 'tox' | 'brn' | null {
  if (!item || (currentStatus != null && currentStatus !== '')) return null;
  const types = ((getSpecies(species) as { types?: string[] } | undefined)?.types) ?? [];
  if (item === 'Toxic Orb') {
    if (types.some(t => t === 'Poison' || t === 'Steel')) return null;
    return 'tox';
  }
  if (item === 'Flame Orb') {
    if (types.includes('Fire')) return null;
    return 'brn';
  }
  return null;
}

// Re-exports for tests
export { weatherChipPct, statusChipPct, orbStatusFor };
