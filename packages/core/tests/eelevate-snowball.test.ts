// Eelevate (Eelektross-Mega) = Levitate + Beast Boost. The Levitate half is in
// damage.ts; the Beast Boost SNOWBALL (KO → +1 highest stat) is a search effect.
// koBoostForSet resolves the MEGA forme's ability + stats from the held stone (the
// team set carries the BASE ability), then maps Eelevate → Beast Boost.
import { describe, test, expect } from 'vitest';
import { koBoostForSet } from '../src/domain/endgameSearch.js';
import type { PokemonSet } from '../src/domain/types.js';
import { MAX_IVS, ZERO_EVS } from '../src/domain/types.js';

const mon = (p: Partial<PokemonSet> & { species: string }): PokemonSet =>
  ({ level: 50, nature: 'Modest', evs: { ...ZERO_EVS }, ivs: { ...MAX_IVS }, moves: [], ...p });

describe('koBoostForSet — Eelevate Beast Boost snowball', () => {
  test('Mega Eelektross (Eelevate) snowballs its highest mega stat on a KO', () => {
    const boost = koBoostForSet(mon({ species: 'Eelektross', item: 'Eelektrossite', ability: 'Levitate', evs: { ...ZERO_EVS, spa: 252 } }));
    expect(boost).not.toBeNull();
    const keys = Object.keys(boost!);
    expect(keys).toHaveLength(1);                 // exactly one stat (the highest)
    expect(['atk', 'def', 'spa', 'spd', 'spe']).toContain(keys[0]);
    expect(boost![keys[0] as keyof typeof boost]).toBe(1);
  });

  test('base Eelektross (Levitate, no stone) does NOT snowball', () => {
    // The stone is what makes it Eelektross-Mega/Eelevate; without it, plain
    // Levitate has no KO boost.
    expect(koBoostForSet(mon({ species: 'Eelektross', ability: 'Levitate' }))).toBeNull();
  });

  test('Mega Pyroar (Fire Mane) does NOT snowball — only Eelevate does', () => {
    expect(koBoostForSet(mon({ species: 'Pyroar', item: 'Pyroarite', ability: 'Unnerve', evs: { ...ZERO_EVS, spa: 252 } }))).toBeNull();
  });

  test('Moxie still maps to +Atk (existing behaviour intact)', () => {
    expect(koBoostForSet(mon({ species: 'Krookodile', ability: 'Moxie', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 } }))).toEqual({ atk: 1 });
  });
});
