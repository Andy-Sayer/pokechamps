// Torment forbids repeating your last move; Imprison seals every move the caster shares
// with the foes. Both restrict MOVES rather than targets, so they're enforced by
// substituting the best legal move at resolution rather than by pruning targets.
// M-B legality is wide: Torment 50 users, Imprison 39.
import { describe, test, expect } from 'vitest';
import { resolveOneTurn, type SearchInput, type TurnAction } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
const oppOf = (set: PokemonSet): OpponentEntry =>
  ({ species: set.species, knownMoves: set.moves, ability: set.ability, candidates: [set] });
const A = (a: TurnAction): Map<number, TurnAction> => new Map([[0, a]]);
const ATTACK = A({ kind: 'attack', target: 0 });

// A big move plus a clearly weaker one, so a forced substitution is visible in the damage.
const brute = mon({ species: 'Kingambit', ability: 'Defiant', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Kowtow Cleave', 'Iron Head'] });
const wall = mon({ species: 'Dondozo', ability: 'Unaware', nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Wave Crash'] });

function hit(opts: { tormented?: boolean; lastMove?: string }): number {
  const input: SearchInput = {
    mine: [{ set: brute, hpPercent: 100, active: true, tormented: opts.tormented, lastMove: opts.lastMove }],
    opp: [{ entry: oppOf(wall), hpPercent: 100, active: true }],
    field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
  };
  const r = resolveOneTurn(input, ATTACK, ATTACK);
  return 100 - r.opp[0]!.hpPct;
}

describe('Torment', () => {
  test('a tormented mon cannot repeat its last move — it drops to its next best', () => {
    const free = hit({});
    const forced = hit({ tormented: true, lastMove: 'Kowtow Cleave' });
    expect(free).toBeGreaterThan(0);
    expect(forced).toBeGreaterThan(0);           // it still attacks…
    expect(forced).toBeLessThan(free);           // …but with Iron Head, not Kowtow Cleave
  });

  test('without the flag, the same last move is reused freely (control)', () => {
    expect(hit({ lastMove: 'Kowtow Cleave' })).toBeCloseTo(hit({}), 5);
  });

  test('a tormented mon with nothing else legal loses its turn', () => {
    const oneTrick = mon({ species: 'Kingambit', ability: 'Defiant', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Kowtow Cleave'] });
    // A RECOIL-FREE defender: Dondozo's Wave Crash chips itself for ~8%, which would
    // otherwise look like damage I dealt (it did, in the first cut of this test).
    const cleanWall = mon({ species: 'Dondozo', ability: 'Unaware', nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Body Press'] });
    const input: SearchInput = {
      mine: [{ set: oneTrick, hpPercent: 100, active: true, tormented: true, lastMove: 'Kowtow Cleave' }],
      opp: [{ entry: oppOf(cleanWall), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    };
    expect(resolveOneTurn(input, ATTACK, ATTACK).opp[0]!.hpPct).toBe(100);
  });
});

describe('Imprison', () => {
  test('a FASTER imprisoner seals the shared move the same turn', () => {
    // Alakazam outspeeds Snorlax, so the seal lands before Body Slam would.
    const zam = mon({ species: 'Alakazam', ability: 'Magic Guard', nature: 'Timid', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Imprison', 'Body Slam'] });
    const lax = mon({ species: 'Snorlax', ability: 'Thick Fat', nature: 'Adamant', evs: { ...ZERO_EVS, hp: 252, atk: 252 }, moves: ['Body Slam'] });
    const input: SearchInput = {
      mine: [{ set: lax, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(zam), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    };
    const sealed = resolveOneTurn(input, ATTACK, A({ kind: 'imprison' }));
    const free = resolveOneTurn(input, ATTACK, ATTACK);
    expect(100 - free.opp[0]!.hpPct).toBeGreaterThan(0);
    expect(sealed.opp[0]!.hpPct).toBe(100);   // Body Slam sealed, nothing else to throw
  });
});
