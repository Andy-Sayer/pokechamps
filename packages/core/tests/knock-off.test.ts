// Knock Off (73 legal users in M-B), Thief, Covet and Corrosive Gas strip the target's
// item. What that changes is bounded by this format's small item list: Life Orb recoil,
// Leftovers healing, and the berry triggers. Damage SCALING stays baked into the cells —
// documented approximation, not an oversight.
//
// CONTROL DESIGN: every comparison keeps the attacker and its move IDENTICAL and varies
// only the DEFENDER's item. "knocked off X" must land exactly where "never held X" does;
// comparing against a different attacker would confound the item effect with a damage
// difference (which is exactly how the first cut of this file fooled itself).
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

// THIEF, not Knock Off, is the probe: Knock Off deals 1.5x when the target actually has
// a removable item (the calc models this correctly), so its damage DEPENDS on the item
// and would confound a with-item/without-item comparison — the first cut of this file
// failed by a constant 15.7% for exactly that reason. Thief removes without the boost,
// so damage is identical either way and any HP gap is the item's own doing.
const knocker = mon({ species: 'Incineroar', ability: 'Intimidate', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Thief'] });
const nonRemover = mon({ species: 'Incineroar', ability: 'Intimidate', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Flare Blitz'] });

/** Same attacker + move every time; only the defender's item varies. */
function endHp(attacker: PokemonSet, item: string, hp: number): number {
  const foe = mon({ species: 'Snorlax', ability: 'Thick Fat', item, nature: 'Careful', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Body Slam'] });
  const input: SearchInput = {
    mine: [{ set: attacker, hpPercent: 100, active: true }],
    opp: [{ entry: oppOf(foe), hpPercent: hp, active: true }],
    field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
  };
  return resolveOneTurn(input, ATTACK, ATTACK).opp[0]!.hpPct;
}

describe('item removal', () => {
  test('a stolen Leftovers heals exactly as much as no Leftovers at all', () => {
    expect(endHp(knocker, 'Leftovers', 60)).toBeCloseTo(endHp(knocker, '', 60), 5);
  });

  test('…and WITHOUT the theft, that same Leftovers does heal (control)', () => {
    // Same attacker species/EVs, a non-removing move: the item survives and ticks.
    expect(endHp(nonRemover, 'Leftovers', 60)).toBeGreaterThan(endHp(nonRemover, '', 60));
  });

  test('a stolen Sitrus Berry cannot trigger', () => {
    expect(endHp(knocker, 'Sitrus Berry', 55)).toBeCloseTo(endHp(knocker, '', 55), 5);
  });

  test('…while an un-stolen Sitrus does fire (control)', () => {
    expect(endHp(nonRemover, 'Sitrus Berry', 55)).toBeGreaterThan(endHp(nonRemover, '', 55));
  });

  test('a stolen Life Orb costs its SLOWER holder no recoil', () => {
    // Snorlax is slower than Incineroar, so the item is gone before it attacks.
    expect(endHp(knocker, 'Life Orb', 80)).toBeCloseTo(endHp(knocker, '', 80), 5);
  });
});

// Item SWAPS: Trick / Switcheroo exchange the two items, Bestow hands one over. Unlike a
// removal, both mons end up holding something, so the state is an override rather than a
// "gone" flag. Observed through Leftovers healing, which is the cleanest item effect to
// watch: whoever holds it at end of turn ticks up.
describe('item swapping', () => {
  // BOTH arms cast a STATUS move so neither deals damage — the only difference is
  // whether that move is Trick. (A damaging control confounds the comparison: the first
  // cut compared Trick against Foul Play and simply measured the damage.)
  const tricker = mon({ species: 'Klefki', ability: 'Prankster', item: '', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Trick', 'Foul Play'] });
  const twaver = mon({ species: 'Klefki', ability: 'Prankster', item: '', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Thunder Wave', 'Foul Play'] });
  const holder = mon({ species: 'Snorlax', ability: 'Thick Fat', item: 'Leftovers', nature: 'Careful', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Body Slam'] });
  const CAST: Map<number, TurnAction> = new Map([[0, { kind: 'itemswap', target: 0 }]]);
  const CTRL: Map<number, TurnAction> = new Map([[0, { kind: 'status', target: 0 }]]);

  function run(my: PokemonSet, act: Map<number, TurnAction>) {
    const input: SearchInput = {
      mine: [{ set: my, hpPercent: 70, active: true }],
      opp: [{ entry: oppOf(holder), hpPercent: 70, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    };
    return resolveOneTurn(input, act, new Map([[0, { kind: 'attack', target: 0 }]]));
  }

  test('Trick moves the Leftovers tick from the foe to me', () => {
    const tricked = run(tricker, CAST);
    const control = run(twaver, CTRL);
    expect(control.opp[0]!.hpPct).toBeGreaterThan(tricked.opp[0]!.hpPct);   // foe kept it and healed
    expect(tricked.mine[0]!.hpPct).toBeGreaterThan(control.mine[0]!.hpPct); // I now hold it
  });
});
