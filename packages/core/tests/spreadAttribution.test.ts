// Subset attribution for trimming a multi-mon spread optimizer result to its
// load-bearing changes. Pure logic (enumeration + selection); the piloted
// gauntlet supplies the scores in attribute-spread.ts.
import { describe, test, expect } from 'vitest';
import {
  changedIndices, allMasks, reducedMasks, teamForMask, maskSpecies, bitCount, pickBestMask,
} from '../src/domain/spreadAttribution.js';
import type { PokemonSet, Stats } from '../src/domain/types.js';

const E = (o: Partial<Stats>): Stats => ({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...o });
const mk = (species: string, nature: string, evs: Partial<Stats>): PokemonSet => ({
  species, level: 50, nature, ability: '', item: '', evs: E(evs),
  ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, moves: [],
});

describe('changedIndices', () => {
  const orig = [mk('A', 'Calm', { hp: 252 }), mk('B', 'Bold', { def: 252 }), mk('C', 'Jolly', { spe: 252 })];
  test('detects a nature-only change', () => {
    const opt = [mk('A', 'Modest', { hp: 252 }), orig[1]!, orig[2]!];
    expect(changedIndices(orig, opt)).toEqual([0]);
  });
  test('detects an EV-only change', () => {
    const opt = [orig[0]!, orig[1]!, mk('C', 'Jolly', { spe: 100, hp: 152 })];
    expect(changedIndices(orig, opt)).toEqual([2]);
  });
  test('identical teams -> no changes', () => {
    expect(changedIndices(orig, orig.map(s => ({ ...s })))).toEqual([]);
  });
});

describe('mask enumeration', () => {
  test('allMasks(3) = 0..7', () => expect(allMasks(3)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]));
  test('allMasks(k) has 2^k entries', () => expect(allMasks(4)).toHaveLength(16));
  test('reducedMasks(3) == allMasks(3) (full subset set already)', () => expect(reducedMasks(3)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]));
  test('reducedMasks(4) = empty + full + singles + leave-one-out', () => expect(reducedMasks(4)).toEqual([0, 1, 2, 4, 7, 8, 11, 13, 14, 15]));
  test('bitCount', () => { expect(bitCount(0)).toBe(0); expect(bitCount(5)).toBe(2); expect(bitCount(7)).toBe(3); });
});

describe('teamForMask + maskSpecies', () => {
  const orig = [mk('A', 'Calm', { hp: 252 }), mk('B', 'Bold', { def: 252 }), mk('C', 'Jolly', { spe: 252 })];
  const opt = [mk('A', 'Modest', { spa: 252 }), mk('B', 'Bold', { def: 252 }), mk('C', 'Timid', { spe: 252 })];
  const changed = changedIndices(orig, opt); // A (0) and C (2)
  test('mask 0 = original team', () => expect(teamForMask(orig, opt, changed, 0).map(s => s.nature)).toEqual(['Calm', 'Bold', 'Jolly']));
  test('mask 0b01 swaps only the first changed mon', () => {
    expect(teamForMask(orig, opt, changed, 1).map(s => s.nature)).toEqual(['Modest', 'Bold', 'Jolly']);
    expect(maskSpecies(opt, changed, 1)).toEqual(['A']);
  });
  test('mask 0b11 swaps both changed mons', () => {
    expect(teamForMask(orig, opt, changed, 3).map(s => s.nature)).toEqual(['Modest', 'Bold', 'Timid']);
    expect(maskSpecies(opt, changed, 3)).toEqual(['A', 'C']);
  });
});

describe('pickBestMask', () => {
  test('picks the highest-floor subset (the only-Archaludon scenario)', () => {
    const fits = [
      { mask: 0, floor: 0.25, avg: 0.85 }, // original
      { mask: 7, floor: 0.75, avg: 0.93 }, // full 3-change
      { mask: 1, floor: 0.88, avg: 0.98 }, // change 1 alone (load-bearing)
      { mask: 2, floor: 0.25, avg: 0.84 }, // change 2 alone (inert)
      { mask: 4, floor: 0.06, avg: 0.86 }, // change 3 alone (harmful)
    ];
    expect(pickBestMask(fits).mask).toBe(1);
  });
  test('ties on floor+avg -> fewest changes (minimality)', () => {
    expect(pickBestMask([{ mask: 7, floor: 0.8, avg: 0.9 }, { mask: 1, floor: 0.8, avg: 0.9 }]).mask).toBe(1);
  });
  test('higher avg breaks a floor tie', () => {
    expect(pickBestMask([{ mask: 1, floor: 0.8, avg: 0.9 }, { mask: 2, floor: 0.8, avg: 0.95 }]).mask).toBe(2);
  });
});
