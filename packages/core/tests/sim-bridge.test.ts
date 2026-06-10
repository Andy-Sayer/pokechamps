// Validate the @pkmn/sim bridge against KNOWN game outcomes, so it can serve as
// ground truth for diffing our fast search. We assert structural facts (faints,
// status, weather, mid-state load) that don't depend on a specific damage roll.
import { describe, test, expect, beforeAll } from 'vitest';
import { buildBattle, stepTurn, readOutcome, ensureSimLoaded, type SimPosition } from '../src/domain/simBridge.js';

beforeAll(async () => {
  // @pkmn/sim is an optional dep loaded lazily; the dev install has it.
  expect(await ensureSimLoaded()).toBe(true);
});

const garchomp = { species: 'Garchomp', ability: 'Rough Skin', moves: ['earthquake', 'dragonclaw'], nature: 'Jolly', evs: { atk: 252, spe: 252 } };
const incin = { species: 'Incineroar', ability: 'Intimidate', moves: ['knockoff', 'flareblitz'], nature: 'Careful', evs: { hp: 252, spd: 252 } };
const amoon = { species: 'Amoonguss', ability: 'Regenerator', moves: ['spore', 'sludgebomb'], nature: 'Calm', evs: { hp: 252, spd: 252 } };
const pult = { species: 'Dragapult', ability: 'Clear Body', moves: ['dracometeor', 'shadowball'], nature: 'Timid', evs: { spa: 252, spe: 252 } };

const base = (over: Partial<SimPosition> = {}): SimPosition => ({
  p1team: [garchomp, incin], p2team: [amoon, pult],
  p1active: [0, 1], p2active: [0, 1], ...over,
});

describe('sim bridge: ground-truth turn resolution', () => {
  test('battle builds and sits at a move request with both leads out', () => {
    const b = buildBattle(base());
    const o = readOutcome(b);
    expect(o.p1[0]!.species).toBe('Garchomp');
    expect(o.p2[0]!.species).toBe('Amoonguss');
    expect(o.p1[0]!.fainted).toBe(false);
  });

  test('mid-battle HP load takes effect', () => {
    const b = buildBattle(base({ p1state: [{ hpPct: 40 }, undefined] }));
    expect(readOutcome(b).p1[0]!.hpPct).toBeCloseTo(40, 0);
  });

  test('Spore puts the targeted foe to sleep (a search GAP — proves the oracle sees it)', () => {
    const b = buildBattle(base());
    // p2 Amoonguss Spore -> p1 slot 1 (Garchomp); everyone else default.
    const o = stepTurn(b, 'move dragonclaw 1, move knockoff 1', 'move spore 1, move shadowball 1');
    expect(o.p1[0]!.status).toBe('slp');
  });

  test('Draco Meteor self-drops the user SpA -2 (secondary the fast search omits)', () => {
    const b = buildBattle(base());
    const o = stepTurn(b, 'move dragonclaw 1, move knockoff 1', 'move sludgebomb 1, move dracometeor 1');
    expect(o.p2[1]!.boosts.spa).toBe(-2);
  });

  test('weather load persists and chips a non-immune mon', () => {
    const b = buildBattle(base({ field: { weather: 'Sand' } }));
    const before = readOutcome(b).p2[1]!.hpPct;          // Dragapult — not Ground/Rock/Steel
    const o = stepTurn(b, 'move dragonclaw 1, move knockoff 1', 'move sludgebomb 1, move shadowball 1');
    expect(o.weather).toBe('sandstorm');
    expect(o.p2[1]!.hpPct).toBeLessThan(before);          // took sand chip
  });
});
