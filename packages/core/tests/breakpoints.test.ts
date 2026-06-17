import { describe, test, expect } from 'vitest';
import { candidateSpreads, requiredSpeedSP, speedBreakpoints, SP_MAX } from '../src/domain/breakpoints.js';
import { evFromSp } from '../src/domain/pikalytics.js';
import type { PokemonSet } from '../src/domain/types.js';
import { MAX_IVS } from '../src/domain/types.js';

const ZERO_EVS = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };

function mon(partial: Partial<PokemonSet> & { species: string }): PokemonSet {
  return {
    level: 50,
    nature: 'Hardy',
    evs: { ...ZERO_EVS },
    ivs: MAX_IVS,
    moves: ['Tackle'],
    ...partial,
  };
}

// An all-faster gauntlet slice. A fast cleaner needs Speed EVs to win the
// contested tier (the opposing Jolly Garchomp it speed-creeps); a min-Speed mon
// outspeeds nothing here, so its Speed is genuinely free to reallocate. There is
// deliberately NO slow mirror, so the slow-mon floor is a clean 0.
const FAST: PokemonSet[] = [
  mon({ species: 'Garchomp', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 } }),
  mon({ species: 'Sneasler', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 } }),
  mon({ species: 'Incineroar', nature: 'Adamant', evs: { ...ZERO_EVS, hp: 252, atk: 252 } }),
];

describe('requiredSpeedSP — the no-Tailwind Speed floor', () => {
  test('Choice Scarf pins Speed to the max — a Scarf is a Speed item', () => {
    const scarf = mon({ species: 'Garchomp', item: 'Choice Scarf', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 } });
    expect(requiredSpeedSP(scarf, FAST)).toBe(SP_MAX);
  });

  test('a cleaner with a contested outspeed has a positive floor at/below max', () => {
    // My Jolly Sneasler must invest to outspeed the opposing Jolly Garchomp
    // (it can't at 0 EVs) — that contested outspeed sets a real floor.
    const fast = mon({ species: 'Sneasler', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 } });
    const floor = requiredSpeedSP(fast, FAST);
    expect(floor).toBeGreaterThan(0);            // must keep enough Speed to hold the contested outspeed
    expect(floor).toBeLessThanOrEqual(SP_MAX);
    // The floor equals the hardest required-outspeed breakpoint.
    expect(floor).toBe(Math.max(...speedBreakpoints(fast, FAST)));
  });

  test('a min-Speed mon that outspeeds nothing has floor 0 (Speed is free to reallocate)', () => {
    const slow = mon({ species: 'Torkoal', nature: 'Quiet', evs: { ...ZERO_EVS, hp: 252 }, moves: ['Lava Plume'] });
    // Torkoal (base 20 Spe, −Speed nature) outspeeds none of FAST — no mirror to creep.
    expect(speedBreakpoints(slow, FAST)).toHaveLength(0);
    expect(requiredSpeedSP(slow, FAST)).toBe(0);
  });
});

describe('candidateSpreads honours the Speed floor', () => {
  test('a Choice Scarf mon never gets a sub-max Speed candidate', () => {
    const scarf = mon({ species: 'Garchomp', item: 'Choice Scarf', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Earthquake', 'Dragon Claw'] });
    const cands = candidateSpreads(scarf, FAST, FAST, false);
    expect(cands.length).toBeGreaterThan(1);
    // Every candidate keeps max Speed EVs — the optimizer can only free Atk/bulk.
    for (const c of cands) expect(c.set.evs.spe).toBe(evFromSp(SP_MAX));
  });

  test('a contested cleaner never gets a 0-Speed candidate; all stay at/above the floor', () => {
    const fast = mon({ species: 'Sneasler', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Close Combat', 'Dire Claw'] });
    const floor = requiredSpeedSP(fast, FAST);
    const minEvs = evFromSp(floor);
    const cands = candidateSpreads(fast, FAST, FAST, false);
    expect(cands.length).toBeGreaterThan(1);
    for (const c of cands) {
      expect(c.set.evs.spe).toBeGreaterThan(0);       // no incoherent Speed-strip
      expect(c.set.evs.spe).toBeGreaterThanOrEqual(minEvs);
    }
  });

  test('a min-Speed mon CAN dump Speed into bulk (a 0-Speed candidate is offered)', () => {
    const slow = mon({ species: 'Torkoal', nature: 'Quiet', evs: { ...ZERO_EVS, hp: 252 }, moves: ['Eruption', 'Earth Power'] });
    const cands = candidateSpreads(slow, FAST, FAST, false);
    expect(cands.some(c => c.set.evs.spe === 0)).toBe(true);
  });
});
