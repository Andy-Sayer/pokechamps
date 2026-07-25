// Final Gambit: damage equal to the user's CURRENT HP, then the user faints.
// @smogon/calc already implements the move and the faint already worked, so the ONLY
// defect was that the cell never carried the attacker's current HP — the calc assumed
// full HP, and the search priced Final Gambit at full value however hurt the user was.
// The scaling test below is therefore the one that bites; the others are regression
// guards for behaviour that already worked and must keep working.
import { describe, test, expect } from 'vitest';
import { resolveOneTurn, type SearchInput, type TurnAction } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
const oppOf = (set: PokemonSet): OpponentEntry =>
  ({ species: set.species, knownMoves: set.moves, ability: set.ability, item: set.item, candidates: [set] });
const A = (a: TurnAction): Map<number, TurnAction> => new Map([[0, a]]);
const ATTACK = A({ kind: 'attack', target: 0 });

// Accelgor: frail, fast, and a real Final Gambit user. Its target is a bulky Snorlax so
// the trade is visible rather than an overkill.
const gambiteer = mon({ species: 'Accelgor', ability: 'Hydration', nature: 'Timid', evs: { ...ZERO_EVS, spe: 252 }, moves: ['Final Gambit'] });
const snorlax = mon({ species: 'Snorlax', ability: 'Thick Fat', nature: 'Careful', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Body Slam'] });
const gengar = mon({ species: 'Gengar', ability: 'Cursed Body', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Shadow Ball'] });

function input(my: PokemonSet, opp: PokemonSet, myHp = 100): SearchInput {
  return {
    mine: [{ set: my, hpPercent: myHp, active: true }],
    opp: [{ entry: oppOf(opp), hpPercent: 100, active: true }],
    field: { ...NEUTRAL_FIELD },
  };
}

describe('Final Gambit', () => {
  test('deals real damage and faints the user (regression guard — already worked)', () => {
    const r = resolveOneTurn(input(gambiteer, snorlax), ATTACK, ATTACK);
    expect(r.opp[0]!.hpPct).toBeLessThan(100);
    expect(r.mine[0]!.fainted).toBe(true);
  });

  // THE FIX. Before it, a half-HP Accelgor still read 58.1% into Snorlax — the same as
  // at full HP — so the search over-valued the trade precisely when it mattered.
  test('damage scales with the user’s CURRENT HP, not its max', () => {
    const full = resolveOneTurn(input(gambiteer, snorlax, 100), ATTACK, ATTACK).opp[0]!.hpPct;
    const half = resolveOneTurn(input(gambiteer, snorlax, 50), ATTACK, ATTACK).opp[0]!.hpPct;
    expect(100 - full).toBeGreaterThan(100 - half);          // full HP hurts more
    // …and by roughly the right ratio: half the HP, half the damage.
    expect((100 - half) / (100 - full)).toBeCloseTo(0.5, 1);
  });

  test('a Ghost defender is immune, and the user does NOT faint on a failed move', () => {
    const r = resolveOneTurn(input(gambiteer, gengar), ATTACK, ATTACK);
    expect(r.opp[0]!.hpPct).toBe(100);
    expect(r.mine[0]!.fainted).toBe(false);   // selfdestruct is 'ifHit' — no hit, no faint
  });

  test('the damage is in the TARGET’s HP units, so a frail user still dents a wall', () => {
    // Accelgor's max HP is far below Snorlax's, so the same raw HP is a smaller
    // PERCENTAGE of Snorlax — the conversion must go through both max-HP values.
    const dealt = 100 - resolveOneTurn(input(gambiteer, snorlax), ATTACK, ATTACK).opp[0]!.hpPct;
    expect(dealt).toBeGreaterThan(0);
    expect(dealt).toBeLessThan(100);   // a frail mon does NOT one-shot a Snorlax
  });
});
