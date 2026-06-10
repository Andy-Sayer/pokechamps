// The opt-in /exact oracle: map a recommended SearchPlay line to Showdown
// choices, resolve it through the real @pkmn/sim engine over many seeds, and
// aggregate the outcome distribution. Theme 4 first half.
import { describe, test, expect, beforeAll } from 'vitest';
import { runExactOracle, formatOracleResult, type OracleSuccess } from '../src/domain/simOracle.js';
import { ensureSimLoaded } from '../src/domain/simBridge.js';
import type { SearchInput } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

beforeAll(async () => {
  expect(await ensureSimLoaded()).toBe(true);
});

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
function oppOf(set: PokemonSet): OpponentEntry {
  return { species: set.species, knownMoves: set.moves, candidates: [set] };
}

const garchomp = mon({
  species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly',
  evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Earthquake', 'Dragon Claw', 'Protect'],
});
const blissey = mon({
  species: 'Blissey', ability: 'Natural Cure', nature: 'Calm',
  evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Seismic Toss', 'Protect'],
});

function input2v2(myHp = [100, 100], oppHp = [100, 100]): SearchInput {
  return {
    mine: [
      { set: garchomp, hpPercent: myHp[0]!, active: true },
      { set: blissey, hpPercent: myHp[1]!, active: true },
    ],
    opp: [
      { entry: oppOf(mon({ species: 'Bronzong', ability: 'Heatproof', nature: 'Sassy', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Gyro Ball', 'Protect'] })), hpPercent: oppHp[0]!, active: true },
      { entry: oppOf(mon({ species: 'Slowbro', ability: 'Own Tempo', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Body Press', 'Protect'] })), hpPercent: oppHp[1]!, active: true },
    ],
    field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
  };
}

describe('runExactOracle', () => {
  test('resolves a plain attack line and reports per-mon distributions', async () => {
    const r = await runExactOracle(input2v2(), {
      plays: [
        { mySpecies: 'Garchomp', move: 'Dragon Claw', targetSpecies: 'Bronzong' },
        { mySpecies: 'Blissey', move: 'Seismic Toss', targetSpecies: 'Slowbro' },
      ],
      // Soft trade both ways (Gyro Ball on slow Blissey is weak; Body Press on
      // Garchomp is neutral chip) so nobody faints and the envelope is clean.
      oppLine: [
        { mySpecies: 'Bronzong', move: 'Gyro Ball', targetSpecies: 'Blissey' },
        { mySpecies: 'Slowbro', move: 'Body Press', targetSpecies: 'Garchomp' },
      ],
    }, { seeds: 8 });
    expect(r.ok).toBe(true);
    const s = r as OracleSuccess;
    expect(s.seeds).toBe(8);
    expect(s.myChoice).toBe('move dragonclaw 1, move seismictoss 2');
    expect(s.oppChoice).toBe('move gyroball 2, move bodypress 1');
    // All four actives reported, nobody faints in this bulky trade.
    expect(s.mons).toHaveLength(4);
    expect(s.mons.every(m => m.faintRate === 0)).toBe(true);
    // Bronzong took Dragon Claw damage: ends below 100 with a sane envelope.
    const zong = s.mons.find(m => m.species === 'Bronzong')!;
    expect(zong.side).toBe('opp');
    expect(zong.hpMax).toBeLessThan(100);
    expect(zong.hpMin).toBeLessThanOrEqual(zong.hpMean);
    expect(zong.hpMean).toBeLessThanOrEqual(zong.hpMax);
    // Seismic Toss is fixed 100 damage → Slowbro's envelope is a single point.
    const bro = s.mons.find(m => m.species === 'Slowbro')!;
    expect(bro.hpMin).toBeCloseTo(bro.hpMax, 5);
    // Formatting smoke: header + one line per mon.
    const lines = formatOracleResult(s);
    expect(lines[0]).toContain('exact sim (8 seeds');
    expect(lines.length).toBeGreaterThanOrEqual(5);
  });

  test('a guaranteed-KO line reports faintRate 1', async () => {
    // Slowbro at 5% takes Seismic Toss (fixed 100 ≥ any 5% HP) — faints every seed.
    const r = await runExactOracle(input2v2([100, 100], [100, 5]), {
      plays: [
        { mySpecies: 'Garchomp', move: 'Protect', targetSpecies: 'Garchomp', self: true },
        { mySpecies: 'Blissey', move: 'Seismic Toss', targetSpecies: 'Slowbro' },
      ],
    }, { seeds: 6 });
    expect(r.ok).toBe(true);
    const s = r as OracleSuccess;
    const bro = s.mons.find(m => m.species === 'Slowbro')!;
    expect(bro.faintRate).toBe(1);
    expect(bro.hpMax).toBe(0);
    // No oppLine → engine default for them.
    expect(s.oppChoice).toBe('default');
  });

  test('probabilistic secondaries show up as a status RATE (the whole point)', async () => {
    // Scald has a 30% burn chance the fast search never auto-applies — the
    // oracle reports it as a seed-fraction on the defender.
    const input: SearchInput = {
      mine: [{
        set: mon({ species: 'Slowbro', ability: 'Own Tempo', nature: 'Bold', evs: { ...ZERO_EVS, hp: 252, spa: 252 }, moves: ['Scald'] }),
        hpPercent: 100, active: true,
      }],
      opp: [{
        // Soft-Boiled (not Protect) so the engine default can't dodge the hit.
        entry: oppOf(mon({ species: 'Blissey', ability: 'Natural Cure', nature: 'Calm', evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Soft-Boiled'] })),
        hpPercent: 100, active: true,
      }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    };
    const r = await runExactOracle(input, {
      plays: [{ mySpecies: 'Slowbro', move: 'Scald', targetSpecies: 'Blissey' }],
    }, { seeds: 32 });
    expect(r.ok).toBe(true);
    const s = r as OracleSuccess;
    const bliss = s.mons.find(m => m.species === 'Blissey')!;
    // The oracle's seeds are DETERMINISTIC, so this is a stable assertion, not
    // a flaky one: a 30% burn over 32 independent seeds lands some but not all.
    const burnRate = bliss.statusRates['brn'] ?? 0;
    expect(burnRate).toBeGreaterThan(0);
    expect(burnRate).toBeLessThan(1);
  });

  test('an unmappable play fails soft with a clear error', async () => {
    const r = await runExactOracle(input2v2(), {
      plays: [
        { mySpecies: 'Garchomp', move: 'Dragon Claw', targetSpecies: 'Bronzong' },
        // Blissey has no play at all → can't map my side.
      ],
    }, { seeds: 2 });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('Blissey');
  });

  test('a sim-illegal move is rejected by the choice probe, not silently defaulted', async () => {
    const r = await runExactOracle(input2v2(), {
      plays: [
        { mySpecies: 'Garchomp', move: 'Hyper Beam', targetSpecies: 'Bronzong' }, // not in moveset
        { mySpecies: 'Blissey', move: 'Seismic Toss', targetSpecies: 'Slowbro' },
      ],
    }, { seeds: 2 });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/rejected/i);
  });
});
