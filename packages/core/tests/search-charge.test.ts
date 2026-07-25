// Two-turn charge moves in the lookahead — WEATHER-CONDITIONAL, which is the whole
// point: Solar Beam and Electro Shot are carried almost exclusively by sun and rain
// teams, where they fire in ONE turn. Modelling them as "always two turns" would be
// wrong for the common case; the gap only opens when their weather is absent or has
// been displaced (e.g. our rain over their Drought).
import { describe, test, expect } from 'vitest';
import { resolveOneTurn, type SearchInput, type TurnAction } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
const oppOf = (set: PokemonSet): OpponentEntry =>
  ({ species: set.species, knownMoves: set.moves, ability: set.ability, item: set.item, candidates: [set] });
function input1v1(my: PokemonSet, opp: PokemonSet, over: Partial<SearchInput> = {}): SearchInput {
  return {
    mine: [{ set: my, hpPercent: 100, active: true }],
    opp: [{ entry: oppOf(opp), hpPercent: 100, active: true }],
    field: { ...NEUTRAL_FIELD }, ...over,
  };
}
const A = (a: TurnAction): Map<number, TurnAction> => new Map([[0, a]]);
const ATTACK = A({ kind: 'attack', target: 0 });
const PROTECT_OPP = A({ kind: 'protect' } as TurnAction);

describe('two-turn charge — weather conditional', () => {
  const charizard = mon({ species: 'Charizard', ability: 'Blaze', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Solar Beam'] });
  const chomp = mon({ species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake'] });

  test('Solar Beam WITHOUT sun spends the turn charging — no damage', () => {
    const r = resolveOneTurn(input1v1(charizard, chomp), ATTACK, ATTACK);
    expect(r.opp[0]!.hpPct).toBe(100);
  });

  test('Solar Beam IN SUN fires the same turn — the common case stays correct', () => {
    const sunny = input1v1(charizard, chomp, { field: { ...NEUTRAL_FIELD, weather: 'Sun' } });
    const r = resolveOneTurn(sunny, ATTACK, ATTACK);
    expect(r.opp[0]!.hpPct).toBeLessThan(100);
  });

  test('Electro Shot fires in RAIN and charges without it', () => {
    const arch = mon({ species: 'Archaludon', ability: 'Stamina', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Electro Shot'] });
    // NOT Garchomp here — Ground is immune to Electric, so it would read 100% either way.
    const peli = mon({ species: 'Pelipper', ability: 'Drizzle', moves: ['Hurricane'] });
    const dry = resolveOneTurn(input1v1(arch, peli), ATTACK, ATTACK);
    const wet = resolveOneTurn(input1v1(arch, peli, { field: { ...NEUTRAL_FIELD, weather: 'Rain' } }), ATTACK, ATTACK);
    expect(dry.opp[0]!.hpPct).toBe(100);        // terrain/no-rain team → a real two-turn move
    expect(wet.opp[0]!.hpPct).toBeLessThan(100);
  });

  test('a move with no weather clause always charges (Meteor Beam)', () => {
    const avalugg = mon({ species: 'Avalugg-Hisui', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Meteor Beam'] });
    for (const weather of [undefined, 'Sun', 'Rain'] as const) {
      const inp = input1v1(avalugg, chomp, weather ? { field: { ...NEUTRAL_FIELD, weather } } : {});
      expect(resolveOneTurn(inp, ATTACK, ATTACK).opp[0]!.hpPct).toBe(100);
    }
  });

  test('the charge turn of a semi-invulnerable move dodges the foe (Phantom Force)', () => {
    const pult = mon({ species: 'Dragapult', ability: 'Clear Body', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Phantom Force'] });
    const r = resolveOneTurn(input1v1(pult, chomp), ATTACK, ATTACK);
    expect(r.opp[0]!.hpPct).toBe(100);   // charging → no damage dealt
    expect(r.mine[0]!.hpPct).toBe(100);  // …and off the field, so Earthquake missed it
  });
});

describe('two-turn charge — the commitment', () => {
  test('the charge turn RECORDS the move, so next turn is locked to firing it', () => {
    // The lost turn is only half the cost of a charge move; the other half is that the
    // mon can no longer choose — it must fire, and it cannot switch away. `charging`
    // carries that commitment into the next ply (jointActions narrows a charging mon's
    // options to the committed move, with switching removed).
    const charizard = mon({ species: 'Charizard', ability: 'Blaze', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Solar Beam'] });
    const chomp = mon({ species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake'] });
    const charged = resolveOneTurn(input1v1(charizard, chomp), ATTACK, ATTACK);
    expect(charged.mine[0]!.charging).toBe('Solar Beam');

    // …and in sun there is no commitment at all, because there was no charge turn.
    const sunny = resolveOneTurn(input1v1(charizard, chomp, { field: { ...NEUTRAL_FIELD, weather: 'Sun' } }), ATTACK, ATTACK);
    expect(sunny.mine[0]!.charging ?? null).toBeNull();
  });
});
