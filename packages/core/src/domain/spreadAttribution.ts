// Pure helpers for attributing a multi-mon spread change to its load-bearing
// subset. A wide static optimizer (optimize-spreads) proposes changes on a fast
// but miscalibrated metric; some help in real playouts, some are inert or
// harmful. These functions enumerate the subsets of proposed changes so the
// PILOTED gauntlet can pick the best one to actually adopt — turning "adopt only
// the load-bearing changes" into a mechanical step. Kept pure (no pool/IO) so
// the enumeration + selection are unit-tested; the script supplies the scores.
import type { PokemonSet } from './types.js';

const EV_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
const evStr = (e: PokemonSet) => EV_KEYS.map(k => e.evs[k] || 0).join('/');

/** Indices where `opt` differs from `orig` (by nature or EV spread). */
export function changedIndices(orig: PokemonSet[], opt: PokemonSet[]): number[] {
  return orig.map((_, i) => i).filter(i => orig[i]!.nature !== opt[i]!.nature || evStr(orig[i]!) !== evStr(opt[i]!));
}

/** popcount — number of changes a mask turns on. */
export function bitCount(mask: number): number {
  let c = 0;
  for (let m = mask; m; m >>= 1) c += m & 1;
  return c;
}

/** All 2^k subset masks over k changes. Guard with a cap before calling for large k. */
export function allMasks(k: number): number[] {
  return Array.from({ length: 1 << k }, (_, m) => m);
}

/** Reduced set for large k: empty, full, each single change, each leave-one-out. */
export function reducedMasks(k: number): number[] {
  const full = (1 << k) - 1;
  const masks = new Set<number>([0, full]);
  for (let b = 0; b < k; b++) {
    masks.add(1 << b);          // single
    masks.add(full ^ (1 << b)); // leave-one-out
  }
  return [...masks].sort((a, b) => a - b);
}

/** The team for a subset mask: `orig`, with the changed mons selected by `mask` swapped to `opt`. */
export function teamForMask(orig: PokemonSet[], opt: PokemonSet[], changed: number[], mask: number): PokemonSet[] {
  const on = new Set(changed.filter((_, b) => mask & (1 << b)));
  return orig.map((s, i) => (on.has(i) ? opt[i]! : s));
}

/** The opt species turned on by a mask (for labels). */
export function maskSpecies(opt: PokemonSet[], changed: number[], mask: number): string[] {
  return changed.filter((_, b) => mask & (1 << b)).map(i => opt[i]!.species);
}

export interface MaskFit { mask: number; floor: number; avg: number }

/**
 * Best subset to adopt: highest floor, then highest average, then FEWEST changes
 * (minimality — never adopt a change that doesn't earn its place). This is why a
 * single load-bearing change beats the full proposal when they tie, and why an
 * inert change is dropped rather than carried.
 */
export function pickBestMask(fits: MaskFit[]): MaskFit {
  return fits.slice().sort((a, b) =>
    (b.floor - a.floor) || (b.avg - a.avg) || (bitCount(a.mask) - bitCount(b.mask)),
  )[0]!;
}
