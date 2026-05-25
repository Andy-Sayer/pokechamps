/**
 * endgame.test.ts — unit tests for the 1-ply endgame solver.
 *
 * Fixture conventions (matching match-engine.test.ts and predictions.test.ts):
 *   - mon() builds a PokemonSet with sensible defaults.
 *   - OpponentEntry is minimal — only species + knownMoves + optionally
 *     candidates when we need a precise spread for damage assertions.
 *   - NEUTRAL_FIELD / ZERO_EVS / MAX_IVS from types.ts.
 */

import { describe, test, expect } from 'vitest';
import { solveEndgame } from '../src/domain/endgame.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';
import type { EndgamePosition } from '../src/domain/endgame.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return {
    level: 50,
    nature: 'Hardy',
    evs: { ...ZERO_EVS },
    ivs: MAX_IVS,
    ...p,
  };
}

// Sneasler — a strong attacker for structural tests
const sneasler = mon({
  species: 'Sneasler', ability: 'Unburden', nature: 'Jolly',
  evs: { ...ZERO_EVS, atk: 252, spe: 252 },
  moves: ['Close Combat', 'Dire Claw', 'Fake Out', 'Protect'],
});

// Calyrex-Shadow — strong SpA attacker, used alongside Sneasler
const calyrex = mon({
  species: 'Calyrex-Shadow', ability: 'As One (Spectrier)', nature: 'Timid',
  item: 'Choice Specs',
  evs: { ...ZERO_EVS, spa: 252, spe: 252 },
  moves: ['Astral Barrage', 'Protect'],
});

// A maximally-bulk Amoonguss used as a hard-to-OHKO target in damage tests.
// Sneasler's neutral moves will chip but not OHKO, making it a reliable
// "definitely not an OHKO" fixture (Amoonguss is Grass/Poison, Sneasler has
// Poison/Fighting/Normal moves — no super-effective OHKO available).
const amooSet = mon({
  species: 'Amoonguss', ability: 'Regenerator', nature: 'Sassy',
  evs: { ...ZERO_EVS, hp: 252, def: 252, spd: 4 },
  moves: ['Spore', 'Rage Powder', 'Protect', 'Giga Drain'],
});

// Bulky Hippowdon — Rock/Ground, Sneasler has no super-effective STAB move,
// so Close Combat (neutral) won't OHKO. Used in "non-KO attack" scenarios.
const hippoSet = mon({
  species: 'Hippowdon', ability: 'Sand Stream', nature: 'Impish',
  evs: { ...ZERO_EVS, hp: 252, def: 252, spd: 4 },
  moves: ['Earthquake', 'Rock Slide', 'Whirlwind', 'Protect'],
});

// Amoonguss entry — only status moves known; used to test "no-damage" cases
const amoongussEntry: OpponentEntry = {
  species: 'Amoonguss', knownMoves: ['Spore', 'Rage Powder'],
};

// Hippowdon entry backed by the known set (reliable damage range)
function hippoEntry(overrides?: Partial<OpponentEntry>): OpponentEntry {
  return {
    species: 'Hippowdon',
    knownMoves: ['Earthquake', 'Rock Slide', 'Whirlwind', 'Protect'],
    candidates: [hippoSet],
    ...overrides,
  };
}

// Amoonguss entry backed by the known set (guaranteed non-OHKO target)
function amooEntry(overrides?: Partial<OpponentEntry>): OpponentEntry {
  return {
    species: 'Amoonguss',
    knownMoves: ['Spore', 'Rage Powder', 'Giga Drain', 'Protect'],
    candidates: [amooSet],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('solveEndgame: basic structure', () => {
  test('returns one recommendation per live my mon', () => {
    const pos: EndgamePosition = {
      mine: [
        { set: sneasler, currentHpPercent: 100 },
        { set: calyrex,  currentHpPercent: 100 },
      ],
      opp: [{ entry: hippoEntry(), currentHpPercent: 100 }],
      field: NEUTRAL_FIELD,
    };
    const { recommendations: recs } = solveEndgame(pos);
    // Two live my mons → two recommendations
    expect(recs).toHaveLength(2);
    for (const r of recs) {
      expect(r.mySpecies).toBeTruthy();
      expect(r.targetSpecies).toBe('Hippowdon');
    }
  });

  test('recommendations are sorted best first (highest netScore first)', () => {
    const pos: EndgamePosition = {
      mine: [
        { set: sneasler, currentHpPercent: 100 },
        { set: calyrex,  currentHpPercent: 100 },
      ],
      opp: [{ entry: hippoEntry(), currentHpPercent: 100 }],
      field: NEUTRAL_FIELD,
    };
    const { recommendations: recs } = solveEndgame(pos);
    expect(recs.length).toBeGreaterThan(1);
    for (let i = 1; i < recs.length; i++) {
      const prev = recs[i - 1]!.netScore;
      const curr = recs[i]!.netScore;
      // Best first: each next score should be <= the previous.
      if (isFinite(prev) && isFinite(curr)) {
        expect(prev).toBeGreaterThanOrEqual(curr - 0.001);
      }
    }
  });

  test('breakdown fields are present and netScore = offenseScore - retaliationPenalty', () => {
    const pos: EndgamePosition = {
      mine: [{ set: sneasler, currentHpPercent: 100 }],
      opp: [{ entry: hippoEntry(), currentHpPercent: 100 }],
      field: NEUTRAL_FIELD,
    };
    const rec = solveEndgame(pos).recommendations[0]!;
    expect(rec.breakdown.offenseScore).toBeGreaterThanOrEqual(0);
    expect(rec.breakdown.retaliationPenalty).toBeGreaterThanOrEqual(0);
    // netScore = offenseScore - retaliationPenalty
    expect(rec.netScore).toBeCloseTo(
      rec.breakdown.offenseScore - rec.breakdown.retaliationPenalty,
      5,
    );
  });
});

describe('solveEndgame: KO preference', () => {
  test('likelyKo is true when target is nearly fainted', () => {
    // Sneasler at 1% HP is trivially a likely KO with any damaging move.
    const pos: EndgamePosition = {
      mine: [{ set: sneasler, currentHpPercent: 100 }],
      opp: [{ entry: hippoEntry(), currentHpPercent: 1 }],
      field: NEUTRAL_FIELD,
    };
    const rec = solveEndgame(pos).recommendations[0]!;
    expect(rec.likelyKo).toBe(true);
    // offenseScore = KO_BONUS = 10 when likelyKo
    expect(rec.breakdown.offenseScore).toBeGreaterThanOrEqual(1);
  });

  test('prefers targeting a nearly-fainted opp over a healthy one (same species)', () => {
    // Two Hippowdon: one at 1% HP (trivial KO), one at 100%.
    // The 1%-HP target gives KO_BONUS (10) and excludes itself from retaliation.
    // The 100%-HP target only gives fractional HP removed as offense score.
    // Even if both targets hit likelyKo=true due to identical species, the
    // attacker should always flag likelyKo for the low-HP target.
    const pos: EndgamePosition = {
      mine: [{ set: sneasler, currentHpPercent: 100 }],
      opp: [
        { entry: hippoEntry(), currentHpPercent: 1 },    // trivially dead
        { entry: hippoEntry(), currentHpPercent: 100 },  // healthy
      ],
      field: NEUTRAL_FIELD,
    };
    const rec = solveEndgame(pos).recommendations[0]!;
    // Must recommend a move (not a sentinel)
    expect(rec.move).not.toBe('');
    // likelyKo should be true for the low-HP target
    expect(rec.likelyKo).toBe(true);
  });

  test('KO scenario scores strictly higher than non-KO scenario (isolated, one opp)', () => {
    // Compare: Sneasler vs Hippowdon at 1% vs Hippowdon at 60%.
    // Hippowdon at 1% → trivial KO, offenseScore = 10, no retaliation (only opp KO'd).
    // Hippowdon at 60% → Sneasler's neutral Close Combat chips maybe 30-50% = 0.3-0.5
    //   offense score, plus retaliation penalty > 0.
    // Net 60% must be < 10.
    const koPos: EndgamePosition = {
      mine: [{ set: sneasler, currentHpPercent: 100 }],
      opp: [{ entry: hippoEntry(), currentHpPercent: 1 }],
      field: NEUTRAL_FIELD,
    };
    const nonKoPos: EndgamePosition = {
      mine: [{ set: sneasler, currentHpPercent: 100 }],
      opp: [{ entry: hippoEntry(), currentHpPercent: 60 }],
      field: NEUTRAL_FIELD,
    };

    const koRec    = solveEndgame(koPos).recommendations[0]!;
    const nonKoRec = solveEndgame(nonKoPos).recommendations[0]!;

    // The KO case must score better.
    expect(koRec.netScore).toBeGreaterThan(nonKoRec.netScore);
    expect(koRec.likelyKo).toBe(true);
    // 60% HP is realistically a non-KO with neutral-effectiveness moves
    expect(nonKoRec.likelyKo).toBe(false);
  });

  test('move selected is the best offensive option (Close Combat > Dire Claw for neutral targets)', () => {
    // Close Combat (120 BP physical) should beat Dire Claw (50 BP) vs Hippowdon.
    const pos: EndgamePosition = {
      mine: [{ set: sneasler, currentHpPercent: 100 }],
      opp: [{ entry: hippoEntry(), currentHpPercent: 1 }],
      field: NEUTRAL_FIELD,
    };
    const rec = solveEndgame(pos).recommendations[0]!;
    expect(rec.move).toBe('Close Combat');
  });
});

describe('solveEndgame: fainted / empty opp slots', () => {
  test('fainted opp is ignored — only live opp is targeted', () => {
    const faintedHippo: OpponentEntry = {
      ...hippoEntry(),
      fainted: true,
    };
    const pos: EndgamePosition = {
      mine: [{ set: sneasler, currentHpPercent: 100 }],
      opp: [
        { entry: faintedHippo, currentHpPercent: 0 },   // dead
        { entry: amooEntry(),   currentHpPercent: 60 },  // alive
      ],
      field: NEUTRAL_FIELD,
    };
    const rec = solveEndgame(pos).recommendations[0]!;
    // Only the live Amoonguss should be targeted.
    expect(rec.targetSpecies).toBe('Amoonguss');
  });

  test('opp with currentHpPercent === 0 is skipped even without fainted flag', () => {
    // An opp at 0 HP (state not yet propagated) should be treated as fainted.
    const pos: EndgamePosition = {
      mine: [{ set: sneasler, currentHpPercent: 100 }],
      opp: [
        { entry: hippoEntry(),    currentHpPercent: 0 },  // effectively fainted
        { entry: amoongussEntry,  currentHpPercent: 80 }, // alive
      ],
      field: NEUTRAL_FIELD,
    };
    const rec = solveEndgame(pos).recommendations[0]!;
    expect(rec.targetSpecies).toBe('Amoonguss');
  });

  test('no live opps → recommendation with empty move and zero score', () => {
    const fainted: OpponentEntry = { ...hippoEntry(), fainted: true };
    const pos: EndgamePosition = {
      mine: [{ set: sneasler, currentHpPercent: 100 }],
      opp: [{ entry: fainted, currentHpPercent: 0 }],
      field: NEUTRAL_FIELD,
    };
    const { recommendations: recs } = solveEndgame(pos);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.move).toBe('');
    expect(recs[0]!.netScore).toBe(0);
    expect(recs[0]!.likelyKo).toBe(false);
  });

  test('empty opp array → one no-op recommendation per my mon', () => {
    const pos: EndgamePosition = {
      mine: [
        { set: sneasler, currentHpPercent: 100 },
        { set: calyrex,  currentHpPercent: 100 },
      ],
      opp: [],
      field: NEUTRAL_FIELD,
    };
    const { recommendations: recs } = solveEndgame(pos);
    expect(recs).toHaveLength(2);
    for (const r of recs) {
      expect(r.move).toBe('');
      expect(r.netScore).toBe(0);
    }
  });

  test('fainted my mon is skipped — no recommendation emitted for it', () => {
    const pos: EndgamePosition = {
      mine: [
        { set: sneasler, currentHpPercent: 0 }, // fainted
        { set: calyrex,  currentHpPercent: 100 },
      ],
      opp: [{ entry: hippoEntry(), currentHpPercent: 50 }],
      field: NEUTRAL_FIELD,
    };
    const { recommendations: recs } = solveEndgame(pos);
    // Only Calyrex should produce a recommendation; Sneasler is dead.
    expect(recs).toHaveLength(1);
    expect(recs[0]!.mySpecies).toBe('Calyrex-Shadow');
  });
});

describe('solveEndgame: no damaging moves', () => {
  test('attacker with only non-damaging moves produces a sentinel recommendation', () => {
    // Amoonguss with Spore + Rage Powder + Protect only — no damaging moves.
    // predictOffense will return null for every target, triggering the sentinel.
    const statusOnly = mon({
      species: 'Amoonguss', ability: 'Regenerator', nature: 'Sassy',
      evs: { ...ZERO_EVS, hp: 252, spd: 252 },
      moves: ['Spore', 'Rage Powder', 'Protect'],
    });

    const pos: EndgamePosition = {
      mine: [{ set: statusOnly, currentHpPercent: 100 }],
      opp:  [{ entry: hippoEntry(), currentHpPercent: 80 }],
      field: NEUTRAL_FIELD,
    };
    const { recommendations: recs } = solveEndgame(pos);
    // Still returns a recommendation (sentinel), just with no useful move.
    expect(recs).toHaveLength(1);
    const r = recs[0]!;
    // Sentinel move is empty string
    expect(r.move).toBe('');
    expect(r.likelyKo).toBe(false);
    // netScore is -Infinity (pushed to back in sort), indicating no move found
    expect(isFinite(r.netScore)).toBe(false);
  });

  test('mon with one damaging move + status moves uses the damaging move', () => {
    // Amoonguss with Giga Drain (damaging) + status moves — must pick Giga Drain.
    const amooWithDmg = mon({
      species: 'Amoonguss', ability: 'Regenerator', nature: 'Sassy',
      evs: { ...ZERO_EVS, hp: 252, spd: 252 },
      moves: ['Spore', 'Giga Drain', 'Protect'],
    });

    const pos: EndgamePosition = {
      mine: [{ set: amooWithDmg, currentHpPercent: 100 }],
      opp:  [{ entry: hippoEntry(), currentHpPercent: 80 }],
      field: NEUTRAL_FIELD,
    };
    const rec = solveEndgame(pos).recommendations[0]!;
    // Giga Drain is the only calculable move → must be chosen
    expect(rec.move).toBe('Giga Drain');
    expect(rec.likelyKo).toBe(false); // Hippo has lots of bulk
  });
});

describe('solveEndgame: retaliation penalty', () => {
  test('when KO is secured, targeted opp does NOT contribute retaliation', () => {
    // Hippo at 1% HP — trivial KO, removed from retaliation set.
    // It's the only opp, so penalty should be 0.
    const pos: EndgamePosition = {
      mine: [{ set: sneasler, currentHpPercent: 100 }],
      opp: [{ entry: hippoEntry(), currentHpPercent: 1 }],
      field: NEUTRAL_FIELD,
    };
    const rec = solveEndgame(pos).recommendations[0]!;
    expect(rec.likelyKo).toBe(true);
    // KO'd opp is excluded → only opp gone → penalty = 0
    expect(rec.breakdown.retaliationPenalty).toBe(0);
  });

  test('surviving opp contributes retaliation penalty', () => {
    // Two Hippowdon: one at 1% HP (we KO it) and one healthy (survives,
    // retaliates). The healthy Hippo can use Earthquake vs Sneasler → penalty > 0.
    const pos: EndgamePosition = {
      mine: [{ set: sneasler, currentHpPercent: 100 }],
      opp: [
        { entry: hippoEntry(), currentHpPercent: 1 },   // KO'd
        { entry: hippoEntry(), currentHpPercent: 100 }, // survives
      ],
      field: NEUTRAL_FIELD,
    };
    const rec = solveEndgame(pos).recommendations[0]!;
    // We KO the first target — but the healthy Hippo retaliates.
    expect(rec.likelyKo).toBe(true);
    // Surviving Hippowdon deals Earthquake → should produce a non-zero penalty.
    expect(rec.breakdown.retaliationPenalty).toBeGreaterThan(0);
    // Net score is still below raw offense score.
    expect(rec.netScore).toBeLessThan(rec.breakdown.offenseScore);
  });
});
