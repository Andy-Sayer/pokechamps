// J.4 inference round-trip: generate a battle with FULLY KNOWN sets in the
// real Showdown engine, feed its own omniscient protocol log through our
// replay parser + production engine walk with inference enabled, and assert
// the TRUE spreads survive every observation's filter ("the true spread always
// satisfies the filter" — catches over-aggressive narrowing). Also locks in
// the scoreOffensiveSpread dedupe that killed the intra-turn geometric
// candidate growth.
import { describe, test, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSimLoaded, buildBattle, stepTurn } from '../src/domain/simBridge.js';
import { parseReplayLog } from '../src/domain/showdownReplay.js';
import { ingestTranscript } from '../src/domain/replayDriver.js';
import { scoreOffensiveSpread, type SpreadCandidate } from '../src/domain/inference.js';
import type { PokemonSet } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

let simReady = false;
beforeAll(async () => {
  simReady = await ensureSimLoaded();
  expect(simReady).toBe(true);
});

// All EVs on the inference coarse grid (evFromSp buckets: 0, 28, 60, …, 252)
// so exact membership is assertable. Moves chosen secondary-free so a proc
// can't shift damage outside what the logged actions describe.
const garchomp: PokemonSet = {
  species: 'Garchomp', level: 50, item: 'Leftovers', ability: 'Rough Skin', nature: 'Jolly',
  evs: { ...ZERO_EVS, atk: 252, spe: 252 }, ivs: { ...MAX_IVS }, moves: ['Dragon Claw', 'Earthquake'],
};
const blissey: PokemonSet = {
  species: 'Blissey', level: 50, item: '', ability: 'Natural Cure', nature: 'Calm',
  evs: { ...ZERO_EVS, hp: 252, spd: 252 }, ivs: { ...MAX_IVS }, moves: ['Seismic Toss'],
};
// Opp moves: legal (the J.2 learnset flag fires otherwise — customgame doesn't
// validate, our checker does) and secondary-free (a proc would change damage
// in ways the logged actions don't describe).
const bronzongTrue: PokemonSet = {
  species: 'Bronzong', level: 50, item: 'Leftovers', ability: 'Heatproof', nature: 'Sassy',
  evs: { ...ZERO_EVS, hp: 252, spd: 156 }, ivs: { ...MAX_IVS }, moves: ['Gyro Ball', 'Stored Power'],
};
const slowbroTrue: PokemonSet = {
  species: 'Slowbro', level: 50, item: undefined, ability: 'Own Tempo', nature: 'Bold',
  evs: { ...ZERO_EVS, hp: 252, def: 252 }, ivs: { ...MAX_IVS }, moves: ['Surf', 'Psyshock'],
};

const decoyFrail = (s: PokemonSet): PokemonSet =>
  ({ ...s, nature: 'Hardy', item: undefined, evs: { ...ZERO_EVS } });
const decoyWrongItem = (s: PokemonSet): PokemonSet =>
  ({ ...s, item: 'Assault Vest' });

function toSimMon(s: PokemonSet) {
  return {
    species: s.species, ability: s.ability, item: s.item ?? '',
    moves: s.moves, nature: s.nature, evs: s.evs, ivs: s.ivs, level: s.level,
  };
}

/** Play a deterministic 3-turn doubles game in the real engine; return its log. */
function playKnownBattle(): string {
  const b = buildBattle({
    p1team: [garchomp, blissey].map(toSimMon),
    p2team: [bronzongTrue, slowbroTrue].map(toSimMon),
    p1active: [0, 1], p2active: [0, 1], seed: [9, 8, 7, 6],
  });
  stepTurn(b, 'move dragonclaw 1, move seismictoss 2', 'move gyroball 1, move surf');
  stepTurn(b, 'move dragonclaw 1, move seismictoss 1', 'move storedpower 2, move psyshock 2');
  stepTurn(b, 'move dragonclaw 2, move seismictoss 2', 'move gyroball 1, move psyshock 2');
  return ((b as unknown as { log: string[] }).log).join('\n');
}

const sameSpread = (c: PokemonSet, truth: PokemonSet): boolean =>
  c.nature === truth.nature
  && (c.item ?? '') === (truth.item ?? '')
  && (['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const).every(k => c.evs[k] === truth.evs[k]);

describe('J.4 — sim-generated round-trip through the production pipeline', () => {
  // Built lazily — the sim loads in beforeAll.
  let t: ReturnType<typeof parseReplayLog>;
  beforeAll(() => { t = parseReplayLog(playKnownBattle()); });

  test('the omniscient log parses: splits collapsed, exact HP fractions kept', () => {
    expect(t.teams.p1).toHaveLength(2);
    expect(t.teams.p2).toHaveLength(2);
    expect(t.turns.length).toBeGreaterThanOrEqual(3);
    // Private lines carry raw HP (e.g. 142/174) → non-integer percents survive.
    const dmg = t.turns.flatMap(x => x.events).filter(e => e.kind === 'damage');
    expect(dmg.length).toBeGreaterThan(4);
    expect(dmg.some(d => (d as { hpPct: number }).hpPct % 1 !== 0)).toBe(true);
  });

  test('the TRUE spread survives every observation; a frail decoy does not', () => {
    const truths: Record<string, PokemonSet> = { Bronzong: bronzongTrue, Slowbro: slowbroTrue };
    const r = ingestTranscript(t, {
      inferSpreads: true,
      mySetFor: s => ({ Garchomp: garchomp, Blissey: blissey } as Record<string, PokemonSet>)[s],
      oppCandidatesFor: s => truths[s] ? [truths[s]!, decoyFrail(truths[s]!), decoyWrongItem(truths[s]!)] : undefined,
    });
    expect(r.flags).toEqual([]);
    // Sim ground truth must sit inside the J.3 envelopes too (cross-check).
    expect(r.damage.filter(d => d.verdict === 'out')).toEqual([]);

    for (const species of ['Bronzong', 'Slowbro']) {
      const entry = r.match.opponentTeam.find(o => o.species === species)!;
      const cands = entry.candidates ?? [];
      expect(cands.length).toBeGreaterThan(0);
      // THE round-trip property: the true spread is still in the posterior.
      expect(cands.some(c => sameSpread(c, truths[species]!))).toBe(true);
      // Growth bound: chained observations + the dedupe keep the set small.
      expect(cands.length).toBeLessThanOrEqual(40);
    }
    // Narrowing actually works: the 0-EV frail decoy can't explain Seismic
    // Toss's fixed 50 damage (different max-HP denominator) — it's gone.
    const zong = r.match.opponentTeam.find(o => o.species === 'Bronzong')!;
    expect((zong.candidates ?? []).some(c => sameSpread(c, decoyFrail(bronzongTrue)))).toBe(false);
  });
});

describe('scoreOffensiveSpread dedupe (the intra-turn growth fix)', () => {
  const defender: PokemonSet = {
    species: 'Garchomp', level: 50, ability: 'Rough Skin', nature: 'Jolly',
    evs: { ...ZERO_EVS, atk: 252, spe: 252 }, ivs: { ...MAX_IVS }, moves: [],
  };
  const obs = {
    attackerSide: 'theirs' as const, attackerSpecies: 'Slowbro', defenderSide: 'mine' as const,
    defenderSpecies: 'Garchomp', move: 'Surf', field: NEUTRAL_FIELD, damageHpPercent: 25,
  };
  const solveOnce = (starting: SpreadCandidate[]) => scoreOffensiveSpread({
    attackerSpecies: 'Slowbro', attackerLevel: 50, startingCandidates: starting,
    attackerMoves: ['Surf'], move: 'Surf', defenderSet: defender, observation: obs,
  });

  test('chaining the same observation does not grow the candidate set', () => {
    const first = solveOnce([{ evs: { ...ZERO_EVS, hp: 252, def: 252 }, nature: 'Bold', ability: 'Own Tempo' }]);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(9); // one spa sweep of one base
    const second = solveOnce(first.map(s => s.candidate));
    // Pre-dedupe this was first.length × first.length (geometric); now the
    // sweep's outputs collapse back onto the same distinct spreads.
    expect(second.length).toBe(first.length);
    const keys = new Set(second.map(s => JSON.stringify([s.candidate.evs, s.candidate.nature, s.candidate.item ?? ''])));
    expect(keys.size).toBe(second.length);
  });
});
