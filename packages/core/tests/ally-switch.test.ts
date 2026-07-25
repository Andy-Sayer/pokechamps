// Ally Switch swaps the two actives, so a single-target move aimed at one hits the
// other. Long listed as needing a POSITION model the slot-less search doesn't have —
// but with exactly two actives a position swap is only observable through TARGETING,
// which is a two-element remap, i.e. what `redirect` already does for switch-ins.
// 41 legal users in M-B.
import { describe, test, expect } from 'vitest';
import { resolveOneTurn, type SearchInput, type TurnAction } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
const oppOf = (set: PokemonSet): OpponentEntry =>
  ({ species: set.species, knownMoves: set.moves, ability: set.ability, candidates: [set] });

// My side: a FAST Ally Switch user + a frail partner the foe wants dead.
const zam = mon({ species: 'Alakazam', ability: 'Magic Guard', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Ally Switch', 'Psychic'] });
// NOT a Ghost — Body Slam is Normal, and a Ghost partner would be immune, which is how
// the first draft of this test managed to have nobody take damage at all.
const frail = mon({ species: 'Whimsicott', ability: 'Prankster', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Moonblast'] });
// A SLOWER attacker, so the swap resolves before its move.
const slowHitter = mon({ species: 'Snorlax', ability: 'Thick Fat', nature: 'Brave', evs: { ...ZERO_EVS, hp: 252, atk: 252 }, moves: ['Body Slam'] });

const field = { ...NEUTRAL_FIELD };
const input = (): SearchInput => ({
  mine: [
    { set: zam, hpPercent: 100, active: true },
    { set: frail, hpPercent: 100, active: true },
  ],
  opp: [{ entry: oppOf(slowHitter), hpPercent: 100, active: true }],
  field, allOppRevealed: true,
});
// The foe aims at my SECOND mon (search index 1).
const OPP_HITS_PARTNER: Map<number, TurnAction> = new Map([[0, { kind: 'attack', target: 1 }]]);

describe('Ally Switch', () => {
  test('a slower attacker aiming at my partner hits the SWITCHER instead', () => {
    const swapped = resolveOneTurn(input(), new Map([[0, { kind: 'allyswitch' }]]), OPP_HITS_PARTNER);
    expect(swapped.mine[1]!.hpPct).toBe(100);          // the intended victim is untouched
    expect(swapped.mine[0]!.hpPct).toBeLessThan(100);  // the switcher took it instead
  });

  test('without it, the intended target takes the hit (control)', () => {
    const normal = resolveOneTurn(input(), new Map([[0, { kind: 'attack', target: 0 }]]), OPP_HITS_PARTNER);
    expect(normal.mine[1]!.hpPct).toBeLessThan(100);
    expect(normal.mine[0]!.hpPct).toBe(100);
  });
});
