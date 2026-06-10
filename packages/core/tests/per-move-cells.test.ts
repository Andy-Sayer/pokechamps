// Per-move damage cells (Theme 1 stage a). The single-pass predictOffenseCells /
// predictThreatCells must reproduce predictOffense / predictThreat EXACTLY —
// the search's off/thr cells are now DERIVED from them — and the search Tables
// must carry per-move grids whose chosen entry matches the legacy cell. These
// are LIVING equivalence tests: the single-cell functions stay exported (TUI
// consumers), so any future drift between the two paths fails here.
import { describe, test, expect } from 'vitest';
import { predictOffense, predictThreat, predictOffenseCells, predictThreatCells } from '../src/domain/predictions.js';
import { buildTablesForTest, type SearchInput } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
function oppOf(set: PokemonSet, extra: Partial<OpponentEntry> = {}): OpponentEntry {
  return { species: set.species, knownMoves: set.moves, candidates: [set], ...extra };
}

const garchomp = mon({
  species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly',
  evs: { ...ZERO_EVS, atk: 252, spe: 252 },
  moves: ['Earthquake', 'Dragon Claw', 'Stone Edge', 'Swords Dance'], // 3 damaging + 1 status
});
const incinBulky = mon({
  species: 'Incineroar', ability: 'Intimidate', nature: 'Careful',
  evs: { ...ZERO_EVS, hp: 252, spd: 252 }, moves: ['Knock Off', 'Flare Blitz'],
});
const incinFrail = mon({
  species: 'Incineroar', ability: 'Intimidate', nature: 'Adamant',
  evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Knock Off', 'Flare Blitz'],
});
const flutter = mon({
  species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid',
  evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Moonblast', 'Shadow Ball'],
});

// The chosen per-move cell must equal the single-cell function's output
// field-for-field (vitest toEqual treats undefined and missing as equal).
function expectOffenseEquivalence(args: Parameters<typeof predictOffense>[0]) {
  const single = predictOffense(args);
  const cells = predictOffenseCells(args);
  if (!single) {
    expect(cells.chosenMove).toBeNull();
    return;
  }
  expect(cells.chosenMove).toBe(single.move);
  const chosen = cells.all.find(c => c.move === cells.chosenMove);
  expect(chosen).toEqual(single);
}
function expectThreatEquivalence(args: Parameters<typeof predictThreat>[0]) {
  const single = predictThreat(args);
  const cells = predictThreatCells(args);
  if (!single) {
    expect(cells.chosenMove).toBeNull();
    return;
  }
  expect(cells.chosenMove).toBe(single.move);
  const chosen = cells.all.find(c => c.move === cells.chosenMove);
  expect(chosen).toEqual(single);
}

describe('predictOffenseCells ↔ predictOffense equivalence', () => {
  test('multi-candidate vote (bulky vs frail spreads)', () => {
    const opp: OpponentEntry = { species: 'Incineroar', knownMoves: ['Knock Off'], candidates: [incinBulky, incinFrail] };
    expectOffenseEquivalence({ attacker: garchomp, opponent: opp, field: { ...NEUTRAL_FIELD } });
  });

  test('default-prior opponent (no candidates yet)', () => {
    const opp: OpponentEntry = { species: 'Garganacl', knownMoves: [] };
    expectOffenseEquivalence({ attacker: garchomp, opponent: opp, field: { ...NEUTRAL_FIELD } });
  });

  test('itemConsumed strips the defender item in both paths', () => {
    const opp = oppOf(mon({ species: 'Incineroar', ability: 'Intimidate', nature: 'Careful', item: 'Sitrus Berry', evs: { ...ZERO_EVS, hp: 252 }, moves: ['Knock Off'] }), { itemConsumed: 'Sitrus Berry' });
    expectOffenseEquivalence({ attacker: garchomp, opponent: opp, field: { ...NEUTRAL_FIELD } });
  });

  test('mega-active attacker (Charizardite Y)', () => {
    const zard = mon({ species: 'Charizard', ability: 'Blaze', item: 'Charizardite Y', nature: 'Modest', evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Heat Wave', 'Air Slash', 'Solar Beam'] });
    expectOffenseEquivalence({ attacker: zard, opponent: oppOf(incinBulky), field: { ...NEUTRAL_FIELD }, attackerGimmickActive: true });
  });

  test('boosts + status + remaining-HP KO read', () => {
    expectOffenseEquivalence({
      attacker: garchomp, opponent: oppOf(incinBulky), field: { ...NEUTRAL_FIELD },
      attackerBoosts: { atk: 2 }, attackerStatus: 'brn', defenderBoosts: { def: 1 },
      defenderCurrentHpPercent: 55,
    });
  });

  test('first-turn gating drops Fake Out from the pool in both paths', () => {
    const fakeOuter = mon({ species: 'Incineroar', ability: 'Intimidate', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Fake Out', 'Knock Off'] });
    expectOffenseEquivalence({ attacker: fakeOuter, opponent: oppOf(flutter), field: { ...NEUTRAL_FIELD }, attackerFirstTurnOut: false });
  });
});

describe('predictThreatCells ↔ predictThreat equivalence', () => {
  test('known moves, multi-candidate worst-case selection', () => {
    const opp: OpponentEntry = { species: 'Incineroar', knownMoves: ['Knock Off', 'Flare Blitz'], candidates: [incinBulky, incinFrail] };
    expectThreatEquivalence({ opponent: opp, defender: flutter, field: { ...NEUTRAL_FIELD } });
  });

  test('Pikalytics fallback pool (no revealed moves)', () => {
    const opp: OpponentEntry = { species: 'Incineroar', knownMoves: [], candidates: [incinBulky] };
    expectThreatEquivalence({ opponent: opp, defender: flutter, field: { ...NEUTRAL_FIELD } });
  });

  test('Encore forces the single locked move', () => {
    const opp: OpponentEntry = { species: 'Incineroar', knownMoves: ['Knock Off', 'Flare Blitz'], candidates: [incinBulky], encoreMove: 'Knock Off' };
    expectThreatEquivalence({ opponent: opp, defender: flutter, field: { ...NEUTRAL_FIELD } });
    const cells = predictThreatCells({ opponent: opp, defender: flutter, field: { ...NEUTRAL_FIELD } });
    expect(cells.all).toHaveLength(1);
    expect(cells.chosenMove).toBe('Knock Off');
  });

  test('Disable removes the disabled move from the pool', () => {
    const opp: OpponentEntry = { species: 'Incineroar', knownMoves: ['Knock Off', 'Flare Blitz'], candidates: [incinBulky], disabledMove: 'Flare Blitz' };
    expectThreatEquivalence({ opponent: opp, defender: flutter, field: { ...NEUTRAL_FIELD } });
    const cells = predictThreatCells({ opponent: opp, defender: flutter, field: { ...NEUTRAL_FIELD } });
    expect(cells.all.some(c => c.move === 'Flare Blitz')).toBe(false);
  });

  test('remaining-HP KO read', () => {
    expectThreatEquivalence({ opponent: oppOf(incinFrail), defender: flutter, field: { ...NEUTRAL_FIELD }, defenderCurrentHpPercent: 40 });
  });
});

describe('per-move cell shape', () => {
  test('every damaging move gets a cell with pooled rolls, in move-list order', () => {
    const cells = predictOffenseCells({ attacker: garchomp, opponent: oppOf(incinBulky), field: { ...NEUTRAL_FIELD } });
    const names = cells.all.map(c => c.move);
    // The three damaging moves, in the attacker's move-list order.
    expect(names.slice(0, 3)).toEqual(['Earthquake', 'Dragon Claw', 'Stone Edge']);
    for (const c of cells.all) {
      expect(c.percentRolls && c.percentRolls.length).toBeTruthy();
      expect(c.maxPercent).toBeGreaterThanOrEqual(c.minPercent);
    }
    expect(cells.chosenMove && names.includes(cells.chosenMove)).toBe(true);
  });
});

describe('Tables: off/thr derived from offMoves/thrMoves', () => {
  const input: SearchInput = {
    mine: [
      { set: garchomp, hpPercent: 100, active: true },
      { set: flutter, hpPercent: 100, active: true },
    ],
    opp: [
      { entry: oppOf(incinBulky), hpPercent: 100, active: true },
      { entry: { species: 'Garganacl', knownMoves: ['Salt Cure', 'Rock Slide'] }, hpPercent: 100, active: true },
    ],
    field: { ...NEUTRAL_FIELD },
  };

  test('the legacy cell appears among the per-move cells with identical numbers', () => {
    const t = buildTablesForTest(input, { myMega: null, oppMega: null });
    for (let mi = 0; mi < t.myN; mi++) {
      for (let oj = 0; oj < t.oppN; oj++) {
        const cell = t.off[mi]![oj]!;
        if (!cell.move) continue; // zero cell — nothing calculable
        const pm = t.offMoves[mi]![oj]!.find(c => c.move === cell.move);
        expect(pm).toEqual(cell);
      }
    }
    for (let oj = 0; oj < t.oppN; oj++) {
      for (let mi = 0; mi < t.myN; mi++) {
        const cell = t.thr[oj]![mi]!;
        if (!cell.move) continue;
        const pm = t.thrMoves[oj]![mi]!.find(c => c.move === cell.move);
        expect(pm).toEqual(cell);
      }
    }
  });

  test('per-move grids cover the damaging movepool (my side)', () => {
    const t = buildTablesForTest(input, { myMega: null, oppMega: null });
    // Garchomp (mi 0) vs Incineroar (oj 0): all three damaging moves present.
    const names = t.offMoves[0]![0]!.map(c => c.move);
    for (const mv of ['Earthquake', 'Dragon Claw', 'Stone Edge']) {
      expect(names).toContain(mv);
    }
  });
});
