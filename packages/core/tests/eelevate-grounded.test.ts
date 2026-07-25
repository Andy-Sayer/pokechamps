// Eelevate (Eelektross-Mega) is "Levitate + Beast Boost". Every layer that tests the
// ability BY NAME must accept it, or the mega silently loses its defining Ground
// immunity — the calc alone gets it right because damage.ts aliases it to Levitate.
import { describe, test, expect } from 'vitest';
import { isLevitateAbility } from '../src/domain/data.js';
import { applyHazardsToSwitchIn } from '../src/domain/hazards.js';

describe('Eelevate counts as Levitate in every by-name check', () => {
  test('the shared predicate accepts both spellings', () => {
    expect(isLevitateAbility('Levitate')).toBe(true);
    expect(isLevitateAbility('Eelevate')).toBe(true);
    expect(isLevitateAbility('Overgrow')).toBe(false);
    expect(isLevitateAbility(null)).toBe(false);
  });

  test('an Eelevate mon floats over Spikes, exactly like a Levitate one', () => {
    const spikes = { spikes: 3 } as never;
    const float = applyHazardsToSwitchIn(spikes, { species: 'Eelektross', ability: 'Eelevate' });
    const levi = applyHazardsToSwitchIn(spikes, { species: 'Eelektross', ability: 'Levitate' });
    const grounded = applyHazardsToSwitchIn(spikes, { species: 'Eelektross', ability: 'Static' });
    expect(float.hpPctLoss).toBe(0);
    expect(float.hpPctLoss).toBe(levi.hpPctLoss);
    expect(grounded.hpPctLoss).toBeGreaterThan(0);   // control: it IS a grounded hazard
  });

  test('…and over Sticky Web and Toxic Spikes', () => {
    const both = { toxicSpikes: 2, stickyWeb: true } as never;
    const float = applyHazardsToSwitchIn(both, { species: 'Eelektross', ability: 'Eelevate' });
    expect(float.boostsApplied?.spe ?? 0).toBe(0);
    expect(float.statusApplied ?? null).toBeNull();
    // control: the same mon WITHOUT the ability is webbed and poisoned
    const grounded = applyHazardsToSwitchIn(both, { species: 'Eelektross', ability: 'Static' });
    expect(grounded.boostsApplied?.spe).toBe(-1);
    expect(grounded.statusApplied).toBe('tox');
  });
});
