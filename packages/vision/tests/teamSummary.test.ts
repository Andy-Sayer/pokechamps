// Team-summary importer: the pure logic (stat math, nature resolution, arrow colour
// detection, assembly + verification/repair). The OCR/region end is validated against
// the gitignored 1080p fixtures via scripts/read-team.ts (reads the rain-mb-final
// team back 6/6 exact).
import { describe, test, expect } from 'vitest';
import { computeStat, natureFor, detectArrow, assembleTeamSummary, type SummaryMovesCard, type SummaryStatsCard } from '../src/teamSummary.js';
import { evFromSp } from '@pokechamps/core/domain/pikalytics.js';

describe('computeStat (L50 Champions)', () => {
  test('matches the on-screen fixture values', () => {
    expect(computeStat('hp', 78, 31, evFromSp(2), 'Jolly')).toBe(155);     // Talonflame HP 155—2
    expect(computeStat('atk', 135, 31, evFromSp(32), 'Adamant')).toBe(205); // Kingambit Atk 205—32
    expect(computeStat('spe', 126, 31, evFromSp(32), 'Jolly')).toBe(195);  // Talonflame Spe 195—32
    expect(computeStat('spa', 74, 31, evFromSp(0), 'Jolly')).toBe(84);     // Talonflame SpA 84—0 (minus)
  });
});

describe('natureFor', () => {
  test('resolves plus/minus pairs via the data layer', () => {
    expect(natureFor('atk', 'spa')).toBe('Adamant');
    expect(natureFor('spe', 'spa')).toBe('Jolly');
    expect(natureFor('spa', 'atk')).toBe('Modest');
    expect(natureFor(null, null)).toBe('Serious');
    expect(natureFor('atk', 'atk')).toBeNull();
  });
});

describe('detectArrow', () => {
  const fill = (rgb: [number, number, number], n = 400) => {
    const data = new Uint8ClampedArray(n * 4);
    for (let p = 0; p < n; p++) { data[p * 4] = rgb[0]; data[p * 4 + 1] = rgb[1]; data[p * 4 + 2] = rgb[2]; data[p * 4 + 3] = 255; }
    return { data, width: 20, height: n / 20 };
  };
  test('pink-red = up, cyan = down; purple card bg and white text are neither', () => {
    expect(detectArrow(fill([235, 110, 145]))).toBe('up');
    expect(detectArrow(fill([150, 215, 230]))).toBe('down');
    expect(detectArrow(fill([130, 115, 190]))).toBeNull();   // card background (the old false-'down')
    expect(detectArrow(fill([255, 255, 255]))).toBeNull();   // label text
  });
});

describe('assembleTeamSummary — verification + repair', () => {
  const garchompMoves: SummaryMovesCard = {
    species: 'Garchomp', speciesRaw: 'Garchomp', ability: 'Rough Skin', item: 'Choice Scarf',
    moves: ['Rock Slide', 'Earthquake', 'Dragon Claw', 'Iron Head'],
  };
  // On-screen truth: 185/200/115/90/105/154, SP 2/32/0/0/0/32, Adamant.
  const garchompStats = (over: Partial<SummaryStatsCard> = {}): SummaryStatsCard => ({
    species: 'Garchomp', speciesRaw: 'Garchomp',
    stats: [185, 200, 115, 90, 105, 154],
    sp: [2, 32, 0, 0, 0, 32],
    arrows: [null, 'up', null, 'down', null, null],
    ...over,
  });

  test('a clean read verifies with no stat warnings', () => {
    const { team, warnings } = assembleTeamSummary([garchompMoves], [garchompStats()]);
    expect(team).toHaveLength(1);
    expect(team[0]).toMatchObject({ species: 'Garchomp', nature: 'Adamant', item: 'Choice Scarf' });
    expect(team[0]!.evs).toEqual({ hp: evFromSp(2), atk: evFromSp(32), def: 0, spa: 0, spd: 0, spe: evFromSp(32) });
    expect(warnings.filter(w => w.includes('does not match'))).toHaveLength(0);
  });

  test('an unreadable SP is solved back from the final stat', () => {
    const { team, warnings } = assembleTeamSummary([garchompMoves], [garchompStats({ sp: [2, null, 0, 0, 0, 32] })]);
    expect(team[0]!.evs.atk).toBe(evFromSp(32));               // 200 Atk pins SP 32 uniquely
    expect(warnings.some(w => w.includes('solved 32'))).toBe(true);
  });

  test('a misread SP is corrected when the final stat pins it', () => {
    const { team } = assembleTeamSummary([garchompMoves], [garchompStats({ sp: [2, 2, 0, 0, 0, 32] })]);
    expect(team[0]!.evs.atk).toBe(evFromSp(32));
  });

  test('failed arrows fall back to solving the nature from full stat consistency', () => {
    const { team } = assembleTeamSummary([garchompMoves], [garchompStats({ arrows: [null, null, null, null, null, null] })]);
    expect(team[0]!.nature).toBe('Adamant');                   // only nature fitting 200 Atk / 90 SpA
  });

  test('a tanked IV is detected from the final stat', () => {
    // Garchomp with IV0 Atk at 0 SP, neutral nature: (2*130+0+0)*.5=130 +5 = 135.
    const st = garchompStats({ stats: [185, 135, 115, 100, 105, 154], sp: [2, 0, 0, 0, 0, 32], arrows: [null, null, null, null, null, null] });
    const { team } = assembleTeamSummary([garchompMoves], [st]);
    expect(team[0]!.ivs.atk).toBe(0);
  });
});
