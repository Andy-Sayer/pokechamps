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

describe('two-turn charge — Mega Sol carries its own sun', () => {
  // Meganium-Mega's Champions ability makes its OWN moves resolve as though Sunny Day
  // were up, whatever the field says (damage.ts already forces sun for its offensive
  // calc). So its Solar Beam must fire in one turn even under a foe's rain — reading the
  // field weather alone would wrongly make the meta's one Grass mega lose a turn exactly
  // when it's being countered. Meganium + Meganiumite are both M-B legal and it learns
  // Solar Beam AND Solar Blade, so this is a reachable position, not a curiosity.
  const megan = mon({ species: 'Meganium-Mega', ability: 'Mega Sol', item: 'Meganiumite', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Solar Beam'] });
  const chomp = mon({ species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake'] });

  test('Solar Beam fires in ONE turn under rain, not two', () => {
    const rainy = input1v1(megan, chomp, { field: { ...NEUTRAL_FIELD, weather: 'Rain' } });
    const r = resolveOneTurn(rainy, ATTACK, ATTACK);
    expect(r.opp[0]!.hpPct).toBeLessThan(100);
    expect(r.mine[0]!.charging ?? null).toBeNull();   // never committed to a charge turn
  });

  test('…and in no weather at all', () => {
    const r = resolveOneTurn(input1v1(megan, chomp), ATTACK, ATTACK);
    expect(r.opp[0]!.hpPct).toBeLessThan(100);
  });

  test('its personal sun is SUN only — it does not skip a rain charge', () => {
    // Guard against "personal weather" being read as a blanket skip: Electro Shot needs
    // RAIN, and Mega Sol emulating sun must not satisfy it.
    const solElectro = mon({ species: 'Meganium-Mega', ability: 'Mega Sol', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252 }, moves: ['Electro Shot'] });
    const peli = mon({ species: 'Pelipper', ability: 'Drizzle', moves: ['Hurricane'] });
    const r = resolveOneTurn(input1v1(solElectro, peli), ATTACK, ATTACK);
    expect(r.opp[0]!.hpPct).toBe(100);                 // still a two-turn move
    expect(r.mine[0]!.charging).toBe('Electro Shot');
  });
});

describe('Sky Drop takes its victim off the field too', () => {
  // A FAST Sky Drop user against a SLOW victim: the drop resolves first, so the victim
  // loses its action outright. (Against a faster victim it would already have moved —
  // that ordering falls out of the single speed-ordered resolution loop.)
  // NB the victim must weigh under 200kg — Sky Drop simply fails above that, which the
  // calc enforces: an early draft of this test used Snorlax (460kg) and the move produced
  // no cell at all.
  const aero = mon({ species: 'Aerodactyl', ability: 'Pressure', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Sky Drop'] });
  const shroom = mon({ species: 'Amoonguss', ability: 'Regenerator', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Sludge Bomb'] });

  test('the charge turn deals no damage AND the victim loses its move', () => {
    const r = resolveOneTurn(input1v1(aero, shroom), ATTACK, ATTACK);
    expect(r.opp[0]!.hpPct).toBe(100);   // charging → no damage dealt
    expect(r.mine[0]!.hpPct).toBe(100);  // Sludge Bomb never happened: Amoonguss was carried up
  });

  // The pair that isolates it: SAME victim, SAME action (heal itself), only the charge
  // move differs. Sky Drop silences it; Phantom Force — which hides the user alone —
  // does not. Using a self-heal avoids confounding "did it act" with "could it reach the
  // hidden attacker", since a semi-invulnerable mon can't be targeted either way.
  const clef = mon({ species: 'Clefable', ability: 'Unaware', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Soft-Boiled', 'Moonblast'] });
  const RECOVER: Map<number, TurnAction> = new Map([[0, { kind: 'recover' }]]);
  const hurt = (my: PokemonSet): SearchInput => ({
    mine: [{ set: my, hpPercent: 100, active: true }],
    opp: [{ entry: oppOf(clef), hpPercent: 60, active: true }],
    field: { ...NEUTRAL_FIELD },
  });

  test('Sky Drop stops the victim healing; Phantom Force does not (control pair)', () => {
    const pult2 = mon({ species: 'Dragapult', ability: 'Clear Body', nature: 'Jolly', evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Phantom Force'] });
    const dropped = resolveOneTurn(hurt(aero), ATTACK, RECOVER).opp[0]!.hpPct;
    const free = resolveOneTurn(hurt(pult2), ATTACK, RECOVER).opp[0]!.hpPct;
    expect(free).toBeGreaterThan(60);    // Phantom Force: Clefable still heals
    expect(dropped).toBe(60);            // Sky Drop: carried up, no heal
  });
});
