// Variable multi-hit (2-5) damage distribution: damageRange replaces the
// calc's flat 3-hit average with the true Gen-5+ hit-count weights
// (2/3 hits 35% each, 4/5 hits 15% each), Skill Link pins 5 hits, and
// Loaded Dice gives 4-5 at 50/50. Theme 3 (2/3).
import { describe, test, expect } from 'vitest';
import { damageRange } from '../src/domain/damage.js';
import type { PokemonSet } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}

// Cute Charm (not Technician) so the per-hit damage matches the Skill Link
// variant — Technician would boost ≤60 BP hits and skew the comparison.
const cinccino = mon({
  species: 'Cinccino', ability: 'Cute Charm', nature: 'Jolly',
  evs: { ...ZERO_EVS, atk: 252, spe: 252 },
  moves: ['Tail Slap', 'Bullet Seed', 'Rock Blast'],
});
const target = mon({
  species: 'Garchomp', ability: 'Rough Skin',
  evs: { ...ZERO_EVS, hp: 252 }, moves: [],
});

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function perHit(attacker: PokemonSet, move: string) {
  // Single-hit reference: same calc with the distribution unwound. We recover
  // the per-hit roll set from the variable result's smallest hit count (÷2 of
  // the first 16 entries, which are the 2-hit block).
  const r = damageRange({ attacker, defender: target, move, field: NEUTRAL_FIELD, attackerSide: 'mine' });
  return r;
}

describe('variable 2-5-hit distribution', () => {
  test('Bullet Seed spans the 2-hit min to the 5-hit max with 35/35/15/15 weights', () => {
    const r = perHit(cinccino, 'Bullet Seed');
    // 20 weighted copies of the 16-roll set.
    expect(r.rolls.length).toBe(16 * 20);
    // First block is the 2-hit totals; envelope = 2×min .. 5×max.
    const perHitRolls = r.rolls.slice(0, 16).map(x => x / 2);
    expect(r.min).toBe(2 * Math.min(...perHitRolls));
    expect(r.max).toBe(5 * Math.max(...perHitRolls));
    // Expected hit count = 2(.35)+3(.35)+4(.15)+5(.15) = 3.1 — the weighted
    // mean roll is exactly 3.1× the per-hit mean.
    expect(mean(r.rolls) / mean(perHitRolls)).toBeCloseTo(3.1, 10);
  });

  test('Skill Link pins 5 hits (fixed path, no distribution)', () => {
    const skillLink = { ...cinccino, ability: 'Skill Link' };
    const r = damageRange({ attacker: skillLink, defender: target, move: 'Bullet Seed', field: NEUTRAL_FIELD, attackerSide: 'mine' });
    // Fixed path: the calc emits a nested 16-roll array per hit (5×16),
    // each scaled to the 5-hit total.
    expect(r.rolls.length).toBe(16 * 5);
    expect(r.desc).toContain('(5 hits)');
    // 5× the per-hit rolls recovered from the unboosted variable calc.
    const base = perHit(cinccino, 'Bullet Seed');
    const perHitMax = Math.max(...base.rolls.slice(0, 16).map(x => x / 2));
    expect(r.max).toBe(5 * perHitMax);
    expect(r.min).toBeGreaterThan(base.min); // 5×min > 2×min
  });

  test('Loaded Dice gives 4-5 hits at 50/50', () => {
    const dice = { ...cinccino, item: 'Loaded Dice' };
    const r = damageRange({ attacker: dice, defender: target, move: 'Bullet Seed', field: NEUTRAL_FIELD, attackerSide: 'mine' });
    expect(r.rolls.length).toBe(16 * 2);
    const perHitRolls = r.rolls.slice(0, 16).map(x => x / 4);
    expect(r.min).toBe(4 * Math.min(...perHitRolls));
    expect(r.max).toBe(5 * Math.max(...perHitRolls));
    expect(mean(r.rolls) / mean(perHitRolls)).toBeCloseTo(4.5, 10);
  });

  test('fixed-count moves keep the flat scaling (Dual Wingbeat ×2)', () => {
    const aero = mon({
      species: 'Aerodactyl', ability: 'Pressure', nature: 'Jolly',
      evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Dual Wingbeat'],
    });
    const r = damageRange({ attacker: aero, defender: target, move: 'Dual Wingbeat', field: NEUTRAL_FIELD, attackerSide: 'mine' });
    expect(r.rolls.length).toBe(16 * 2); // per-hit nested arrays, each ×2
    expect(r.desc).toContain('(2 hits)');
  });

  test('single-hit moves are untouched', () => {
    const r = damageRange({ attacker: cinccino, defender: target, move: 'Hyper Voice', field: NEUTRAL_FIELD, attackerSide: 'mine' });
    expect(r.rolls.length).toBe(16);
  });
});
