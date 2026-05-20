import type { HazardState, PokemonSet, OpponentEntry } from './types.js';
import { getSpecies, getAbility, getItem } from './data.js';
import { effectiveness } from './typechart.js';

export interface HazardEffect {
  hpPctLoss: number;            // 0-100; subtract from currentHpPercent
  statusApplied?: 'psn' | 'tox';
  boostsApplied?: Partial<Record<'spe', number>>;
}

// Hazards applied on switch-in (or replacement send-in). Order:
//   Stealth Rock: 12.5% × Rock effectiveness vs incoming types.
//     Magic Guard / Heavy-Duty Boots negate.
//   Spikes: 1/8, 1/6, 1/4 by layers. Ground-immune (Flying type / Levitate) skip.
//     Heavy-Duty Boots negate.
//   Toxic Spikes: 1 layer poisons, 2 layers badly poisons. Poison-type absorbs
//     the spikes (clears them on entry); Steel-type/Flying/Levitate immune.
//     Heavy-Duty Boots negate.
//   Sticky Web: -1 Speed. Flying/Levitate immune; Heavy-Duty Boots negate.
//
// The signature is intentionally side-agnostic — caller decides which side's
// hazards apply (incoming mon hits the hazards on their OWN side).
export function applyHazardsToSwitchIn(
  hazards: HazardState | undefined,
  incoming: { species: string; ability?: string; item?: string },
): HazardEffect {
  const out: HazardEffect = { hpPctLoss: 0 };
  if (!hazards) return out;

  const species = getSpecies(incoming.species) as any;
  const types = (species?.types as string[] | undefined) ?? [];
  const abilityName = incoming.ability;
  const ability = abilityName ? (getAbility(abilityName) as any) : null;
  const itemName = incoming.item;
  const item = itemName ? (getItem(itemName) as any) : null;
  const isMagicGuard = ability?.name === 'Magic Guard';
  const isHeavyDutyBoots = item?.name === 'Heavy-Duty Boots';
  const isLevitate = ability?.name === 'Levitate';
  const isFlying = types.includes('Flying');
  const groundImmune = isLevitate || isFlying;

  // Stealth Rock
  if (hazards.rocks && !isMagicGuard && !isHeavyDutyBoots) {
    const eff = effectiveness('Rock', types); // 0.25 / 0.5 / 1 / 2 / 4
    out.hpPctLoss += 12.5 * eff;
  }

  // Spikes
  const sp = hazards.spikes ?? 0;
  if (sp > 0 && !isHeavyDutyBoots && !groundImmune) {
    const layers = { 1: 100 / 8, 2: 100 / 6, 3: 100 / 4 };
    out.hpPctLoss += layers[sp as 1 | 2 | 3];
  }

  // Toxic Spikes
  const ts = hazards.toxicSpikes ?? 0;
  if (ts > 0 && !isHeavyDutyBoots && !groundImmune) {
    if (types.includes('Steel')) {
      // Steel is immune to poison; no status applied (and they don't absorb).
    } else if (types.includes('Poison')) {
      // Poison-type absorbs the layers — caller should clear hazards.toxicSpikes
      // after applying. We don't mutate here.
    } else {
      out.statusApplied = ts >= 2 ? 'tox' : 'psn';
    }
  }

  // Sticky Web
  if (hazards.stickyWeb && !isHeavyDutyBoots && !groundImmune) {
    out.boostsApplied = { spe: -1 };
  }

  return out;
}

// Whether the incoming Poison-type absorbed the toxic spikes — caller uses
// to clear the layer count on the field after switch-in.
export function absorbsToxicSpikes(incoming: { species: string }): boolean {
  const species = getSpecies(incoming.species) as any;
  const types = (species?.types as string[] | undefined) ?? [];
  return types.includes('Poison');
}

// Compact glyph string for the field-state line. Returns null if there are
// no hazards on this side.
export function hazardGlyphs(h: HazardState | undefined): string | null {
  if (!h) return null;
  const parts: string[] = [];
  if (h.rocks) parts.push('▲SR');
  if (h.spikes) parts.push(`▲SP×${h.spikes}`);
  if (h.toxicSpikes) parts.push(`▲TS×${h.toxicSpikes}`);
  if (h.stickyWeb) parts.push('▲SW');
  return parts.length ? parts.join(' ') : null;
}

// Resolve the parser-friendly hazard verb to a HazardState mutation.
export function applyHazardVerb(
  prev: HazardState | undefined,
  verb: 'rocks' | 'spikes' | 'tspikes' | 'web',
  arg: 'on' | 'off' | number,
): HazardState {
  const next: HazardState = { ...(prev ?? {}) };
  if (verb === 'rocks') next.rocks = arg === 'on';
  else if (verb === 'web') next.stickyWeb = arg === 'on';
  else if (verb === 'spikes') {
    const n = typeof arg === 'number' ? arg : arg === 'on' ? 1 : 0;
    next.spikes = Math.max(0, Math.min(3, n)) as 0 | 1 | 2 | 3;
  } else if (verb === 'tspikes') {
    const n = typeof arg === 'number' ? arg : arg === 'on' ? 1 : 0;
    next.toxicSpikes = Math.max(0, Math.min(2, n)) as 0 | 1 | 2;
  }
  return next;
}
