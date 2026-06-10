// Ability inference from battle observations (Theme 3, backward half):
// landed damaging hits and explicitly-logged statuses PROVE abilities absent.
// The proof persists on OpponentEntry.abilitiesRuledOut, filters inference
// candidates, and collapses a 2-ability species to a CERTAIN ability.
import { describe, test, expect } from 'vitest';
import {
  abilitiesRuledOutByStatus,
  ruleOutAbilities,
  confirmAbility,
  attackerIgnoresAbilities,
} from '../src/domain/abilityInference.js';
import { certainAbility } from '../src/domain/abilities.js';
import { scoreSpread, type SpreadCandidate } from '../src/domain/inference.js';
import { finalizeTurn, applyStateUpdate, type ActiveIdx } from '../src/match/engine.js';
import type { Match, PokemonSet, OpponentEntry, MoveAction } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}

const garchomp = mon({
  species: 'Garchomp', ability: 'Rough Skin', nature: 'Adamant',
  evs: { ...ZERO_EVS, atk: 252, spe: 252 },
  moves: ['Earthquake', 'Dragon Claw', 'Stone Edge', 'Protect'],
});

function freshMatch(opts?: { myTeam?: PokemonSet[]; oppSpecies?: string[] }): Match {
  const myTeam = opts?.myTeam ?? [garchomp, mon({ species: 'Rillaboom', ability: 'Grassy Surge', moves: ['Grassy Glide'] })];
  const opponentTeam: OpponentEntry[] = (opts?.oppSpecies ?? ['Bronzong', 'Amoonguss']).map(species => ({ species, knownMoves: [] }));
  return {
    id: 'test-match', startedAt: '2026-06-10T00:00:00.000Z',
    myTeam, opponentTeam, bring: [0, 1], opponentBrought: [0, 1],
    turns: [], field: NEUTRAL_FIELD, active: { mine: [null, null], theirs: [null, null] },
  };
}
const startActive: ActiveIdx = { mine: [0, 1], theirs: [0, 1] };

describe('abilitiesRuledOutByStatus', () => {
  test('maps each status to its immunity abilities', () => {
    expect(abilitiesRuledOutByStatus('par').has('limber')).toBe(true);
    expect(abilitiesRuledOutByStatus('brn').has('waterveil')).toBe(true);
    expect(abilitiesRuledOutByStatus('brn').has('thermalexchange')).toBe(true);
    expect(abilitiesRuledOutByStatus('psn').has('immunity')).toBe(true);
    expect(abilitiesRuledOutByStatus('tox').has('immunity')).toBe(true);
    expect(abilitiesRuledOutByStatus('slp').has('insomnia')).toBe(true);
    expect(abilitiesRuledOutByStatus('slp').has('vitalspirit')).toBe(true);
    expect(abilitiesRuledOutByStatus('frz').has('magmaarmor')).toBe(true);
    // Purifying Salt blocks everything.
    for (const st of ['brn', 'par', 'psn', 'tox', 'slp', 'frz']) {
      expect(abilitiesRuledOutByStatus(st).has('purifyingsalt')).toBe(true);
    }
    // Poison Heal does NOT prevent poison — a poisoned mon may well have it.
    expect(abilitiesRuledOutByStatus('tox').has('poisonheal')).toBe(false);
    // Unknown status → nothing.
    expect(abilitiesRuledOutByStatus('confused').size).toBe(0);
  });

  test('Leaf Guard only ruled out when sun was active at the landing', () => {
    expect(abilitiesRuledOutByStatus('brn').has('leafguard')).toBe(false);
    expect(abilitiesRuledOutByStatus('brn', { weather: 'Sun' }).has('leafguard')).toBe(true);
    expect(abilitiesRuledOutByStatus('brn', { weather: 'Harsh Sunshine' }).has('leafguard')).toBe(true);
    expect(abilitiesRuledOutByStatus('brn', { weather: 'Rain' }).has('leafguard')).toBe(false);
  });

  test('an ability-piercing attacker suppresses every rule-out', () => {
    expect(attackerIgnoresAbilities('Mold Breaker')).toBe(true);
    expect(abilitiesRuledOutByStatus('par', { attackerAbility: 'Mold Breaker' }).size).toBe(0);
    expect(abilitiesRuledOutByStatus('par', { attackerAbility: 'Teravolt' }).size).toBe(0);
    expect(abilitiesRuledOutByStatus('par', { attackerAbility: 'Prankster' }).has('limber')).toBe(true);
  });
});

describe('ruleOutAbilities / confirmAbility entry mutators', () => {
  const cands = (): PokemonSet[] => [
    mon({ species: 'Bronzong', ability: 'Levitate', moves: [] }),
    mon({ species: 'Bronzong', ability: 'Heatproof', moves: [] }),
  ];

  test('persists ids and drops now-impossible candidates with their likelihoods', () => {
    const o: OpponentEntry = { species: 'Bronzong', knownMoves: [], candidates: cands(), candidateLikelihoods: [0.4, 0.6] };
    expect(ruleOutAbilities(o, ['levitate'])).toBe(true);
    expect(o.abilitiesRuledOut).toContain('levitate');
    expect(o.candidates!.map(c => c.ability)).toEqual(['Heatproof']);
    expect(o.candidateLikelihoods).toEqual([0.6]);
    // Re-asserting the same proof is a no-op.
    expect(ruleOutAbilities(o, ['levitate'])).toBe(false);
  });

  test('never empties the candidate set', () => {
    const o: OpponentEntry = { species: 'Bronzong', knownMoves: [], candidates: cands() };
    ruleOutAbilities(o, ['levitate', 'heatproof']);
    // Both proven absent (contradictory inputs) — rule-outs persist but the
    // candidate set is left intact rather than emptied.
    expect(o.abilitiesRuledOut).toEqual(expect.arrayContaining(['levitate', 'heatproof']));
    expect(o.candidates!.length).toBe(2);
  });

  test('confirmAbility prunes to the revealed ability and clears a stale rule-out', () => {
    const o: OpponentEntry = {
      species: 'Bronzong', knownMoves: [], candidates: cands(),
      abilitiesRuledOut: ['heatproof'],
    };
    confirmAbility(o, 'Heatproof'); // the reveal trumps the stale rule-out
    expect(o.abilitiesRuledOut).not.toContain('heatproof');
    expect(o.candidates!.every(c => c.ability === 'Heatproof')).toBe(true);
  });

  test('confirmAbility overwrites candidates when none carry the revealed ability', () => {
    const o: OpponentEntry = { species: 'Bronzong', knownMoves: [], candidates: cands() };
    confirmAbility(o, 'Friend Guard');
    expect(o.candidates!.length).toBe(2);
    expect(o.candidates!.every(c => c.ability === 'Friend Guard')).toBe(true);
  });
});

describe('certainAbility with rule-outs', () => {
  test('a 2-ability species collapses to certain when one is ruled out', () => {
    // Garchomp: Sand Veil / Rough Skin (H).
    expect(certainAbility({ species: 'Garchomp' })).toBeUndefined();
    expect(certainAbility({ species: 'Garchomp', ruledOut: ['sandveil'] })).toBe('Rough Skin');
    expect(certainAbility({ species: 'Garchomp', ruledOut: ['roughskin'] })).toBe('Sand Veil');
  });

  test('all abilities ruled out (contradiction) stays uncertain', () => {
    expect(certainAbility({ species: 'Garchomp', ruledOut: ['sandveil', 'roughskin'] })).toBeUndefined();
  });

  test('knownAbility always wins', () => {
    expect(certainAbility({ knownAbility: 'Sand Veil', species: 'Garchomp', ruledOut: ['sandveil'] })).toBe('Sand Veil');
  });
});

describe('scoreSpread honours persisted rule-outs', () => {
  test('ruledOutAbilities filters starting candidates even on an unrelated move type', () => {
    const starting: SpreadCandidate[] = [
      { evs: { ...ZERO_EVS, hp: 252 }, nature: 'Impish', ability: 'Levitate' },
      { evs: { ...ZERO_EVS, hp: 252 }, nature: 'Impish', ability: 'Heatproof' },
    ];
    // Dragon Claw carries no per-hit type rule-out — only the persisted proof
    // (from an earlier Ground hit) removes Levitate here.
    const scored = scoreSpread({
      defenderSpecies: 'Bronzong', defenderLevel: 50, knownDefenderMoves: [],
      attackerSet: garchomp,
      observation: {
        attackerSide: 'mine', attackerSpecies: 'Garchomp', defenderSide: 'theirs',
        defenderSpecies: 'Bronzong', move: 'Dragon Claw', field: NEUTRAL_FIELD, damageHpPercent: 20,
      },
      startingCandidates: starting,
      ruledOutAbilities: ['levitate'],
      quickOnly: true,
    });
    expect(scored.length).toBeGreaterThan(0);
    expect(scored.some(s => s.candidate.ability === 'Levitate')).toBe(false);
  });
});

describe('engine: landed-hit rule-outs persist on the entry', () => {
  test('a landed Earthquake proves not-Levitate and survives into later inference', () => {
    const match = freshMatch();
    // Pre-seed a small candidate set so inference chains it (off-meta species
    // would otherwise fall into the full coarse grid — slow, and not the point).
    match.opponentTeam[0]!.candidates = [
      mon({ species: 'Bronzong', ability: 'Levitate', evs: { ...ZERO_EVS, hp: 252 }, moves: [] }),
      mon({ species: 'Bronzong', ability: 'Heatproof', evs: { ...ZERO_EVS, hp: 252 }, moves: [] }),
    ];
    const action: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Earthquake', target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      targetRemainingHpPercent: 65, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [action], field: match.field }, activeIdx: startActive });
    const opp = r.match.opponentTeam[0]!;
    expect(opp.abilitiesRuledOut).toContain('levitate');
    // The surviving candidates never claim Levitate.
    expect((opp.candidates ?? []).some(c => c.ability && c.ability.toLowerCase().includes('levitate'))).toBe(false);
  });

  test('a Mold Breaker attacker proves nothing', () => {
    const excadrill = mon({
      species: 'Excadrill', ability: 'Mold Breaker', nature: 'Adamant',
      evs: { ...ZERO_EVS, atk: 252 }, moves: ['Earthquake', 'Iron Head'],
    });
    const match = freshMatch({ myTeam: [excadrill, garchomp] });
    match.opponentTeam[0]!.candidates = [
      mon({ species: 'Bronzong', ability: 'Levitate', evs: { ...ZERO_EVS, hp: 252 }, moves: [] }),
      mon({ species: 'Bronzong', ability: 'Heatproof', evs: { ...ZERO_EVS, hp: 252 }, moves: [] }),
    ];
    const action: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Earthquake', target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      targetRemainingHpPercent: 65, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [action], field: match.field }, activeIdx: startActive });
    expect(r.match.opponentTeam[0]!.abilitiesRuledOut ?? []).not.toContain('levitate');
  });
});

describe('engine: logged-status rule-outs', () => {
  test('a state-line paralysis rules out Limber (berry cure still counts)', () => {
    const match = freshMatch({ oppSpecies: ['Hawlucha', 'Amoonguss'] });
    match.opponentTeam[0]!.item = 'Cheri Berry'; // cures par — the landing still happened
    const r = applyStateUpdate({
      match, update: { side: 'theirs', teamIndex: 0, status: 'par' }, activeIdx: startActive,
    });
    const opp = r.match.opponentTeam[0]!;
    expect(opp.status).toBeUndefined();          // berry caught it
    expect(opp.itemConsumed).toBe('Cheri Berry');
    expect(opp.abilitiesRuledOut).toContain('limber');
  });

  test('a turn-line secondary status tag rules out the immunity abilities', () => {
    const match = freshMatch({ oppSpecies: ['Milotic', 'Amoonguss'] });
    match.opponentTeam[0]!.candidates = [
      mon({ species: 'Milotic', ability: 'Marvel Scale', evs: { ...ZERO_EVS, hp: 252 }, moves: [] }),
    ];
    const action: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Stone Edge', target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      targetRemainingHpPercent: 70, targetStatus: 'brn', order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [action], field: match.field }, activeIdx: startActive });
    const opp = r.match.opponentTeam[0]!;
    expect(opp.status).toBe('brn');
    expect(opp.abilitiesRuledOut).toContain('waterveil');
  });

  test('an ability reveal prunes candidates to the revealed ability', () => {
    const match = freshMatch({ oppSpecies: ['Bronzong', 'Amoonguss'] });
    match.opponentTeam[0]!.candidates = [
      mon({ species: 'Bronzong', ability: 'Levitate', moves: [] }),
      mon({ species: 'Bronzong', ability: 'Heatproof', moves: [] }),
    ];
    const r = applyStateUpdate({
      match, update: { side: 'theirs', teamIndex: 0, setAbility: 'Heatproof' }, activeIdx: startActive,
    });
    const opp = r.match.opponentTeam[0]!;
    expect(opp.ability).toBe('Heatproof');
    expect(opp.candidates!.every(c => c.ability === 'Heatproof')).toBe(true);
  });
});
