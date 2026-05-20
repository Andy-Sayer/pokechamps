import type { Match, FieldState, OpponentEntry, PokemonSet } from './types.js';
import { maxHpFor } from './damage.js';
import { getSpecies } from './data.js';

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
    if ((o.currentHpPercent ?? 100) === 0) o.fainted = true;
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
    if ((next.myCurrentHp![idx] ?? 100) === 0 && !next.myFainted!.includes(idx)) next.myFainted!.push(idx);
  };

  applyToMine(activeIdx.mine[0]);
  applyToMine(activeIdx.mine[1]);
  applyToOpp(activeIdx.theirs[0]);
  applyToOpp(activeIdx.theirs[1]);

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

// Re-exports for tests
export { weatherChipPct, statusChipPct };
