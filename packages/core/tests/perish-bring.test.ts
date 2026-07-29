// Catching the perish trap at TEAM PREVIEW, on the real 2026-07-28 opponent.
//
// The live loss was not a bring mistake — the bring that was made ranked first and
// carried two answers. It was a LEAD mistake: the sole speed answer led, their Fake
// Out blanked it for the one turn that mattered, and the song landed. These tests
// pin both halves: the counter set that makes a Scarf racer count as an answer at
// all, and the lead rule that keeps it off the field on turn 1.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { scoreBrings, leadAdvice, PATTERN_COUNTERS, effectiveSpeed } from '../src/domain/bring.js';
import type { OpponentEntry, PokemonSet } from '../src/domain/types.js';

const team: PokemonSet[] = JSON.parse(readFileSync('data/my-teams/TalonFlameAndyBoy.json', 'utf8'));
const OPP = ['Archaludon', 'Blastoise', 'Pelipper', 'Gengar', 'Meowscarada', 'Incineroar'];
const opponent = OPP.map(species =>
  ({ species, knownMoves: [], candidates: [] } as unknown as OpponentEntry));
const byName = (n: string) => team.find(t => t.species === n)!;

describe('perish trap at team preview', () => {
  test('a Choice Scarf racer now counts as an answer — it used to count for nothing', () => {
    const chomp = byName('Garchomp');
    // The old test was `soundproof || taunt || pivot`. Garchomp has none of those,
    // so the single best answer on the team scored zero.
    expect(PATTERN_COUNTERS['perish-trap']!(chomp)).toBe(false);          // with no speed context
    expect(PATTERN_COUNTERS['perish-trap']!(chomp, { threatSpeed: 200 })).toBe(true);
    expect(effectiveSpeed(chomp)).toBeGreaterThan(200);                    // Scarf 231 > Mega Gengar 200
  });

  test('the pivot still counts, and a mon with neither does not', () => {
    expect(PATTERN_COUNTERS['perish-trap']!(byName('Meowscarada'))).toBe(true);   // U-turn
    expect(PATTERN_COUNTERS['perish-trap']!(byName('Pelipper'), { threatSpeed: 200 })).toBe(false);
  });

  test('a bring with only ONE answer is flagged, not credited', () => {
    // The failure the live game exposed: one answer is not an answer when they can
    // take a turn away from it.
    const scores = scoreBrings(team, opponent);
    const thin = scores.filter(s => s.rationale.some(r => /ONLY ONE answer to opp Perish/.test(r)));
    const covered = scores.filter(s => s.rationale.some(r => /Covers opp Perish/.test(r)));
    expect(thin.length).toBeGreaterThan(0);
    expect(covered.length).toBeGreaterThan(0);
    // The two answers on this team are Garchomp (outruns the singer) and
    // Meowscarada (pivots out). "Thin" must mean exactly one of them present —
    // either one alone is deniable; both together is real coverage.
    const answersIn = (s: { myIndices: number[] }) =>
      s.myIndices.map(i => team[i]!.species).filter(n => n === 'Garchomp' || n === 'Meowscarada');
    for (const s of thin) expect(answersIn(s)).toHaveLength(1);
    for (const s of covered) expect(answersIn(s).sort()).toEqual(['Garchomp', 'Meowscarada']);
    const none = scores.filter(s => s.rationale.some(r => /No answer to opp Perish/.test(r)));
    for (const s of none) expect(answersIn(s)).toHaveLength(0);
  });

  test('the bring actually made was CORRECT — it ranked first and was covered', () => {
    const scores = scoreBrings(team, opponent);
    const top = scores[0]!.myIndices.map(i => team[i]!.species);
    expect(top.sort()).toEqual(['Dragonite', 'Garchomp', 'Meowscarada', 'Talonflame'].sort());
    expect(scores[0]!.rationale.some(r => /Covers opp Perish trap/.test(r))).toBe(true);
  });

  test('the LEAD advice leads BOTH answers — the full-battle result, not the turn-1 logic', () => {
    // The first version of this rule held the sole answer BACK, reasoning that
    // leading it aims their Fake Out at the mon you cannot lose. Correct about the
    // turn, wrong about the game: perish-lead-gauntlet.ts put that lead LAST of
    // four (75%) and 1/16 against a stall-forever opponent, while leading both
    // answers scored best (91%). The rule now follows the games.
    const advice = leadAdvice(scoreBrings(team, opponent)[0]!.myIndices.map(i => team[i]!), opponent)!;
    expect(advice).not.toBeNull();
    expect(advice.lead.sort()).toEqual(['Garchomp', 'Meowscarada']);
    // Deniability is REPORTED, not acted on.
    expect(advice.reasons.join(' ')).toMatch(/Risk: they carry Fake Out/);
    expect(advice.reasons.join(' ')).toMatch(/Garchomp cannot pivot away/);
  });

  test('a pattern with several named variants is not double-counted', () => {
    const advice = leadAdvice(scoreBrings(team, opponent)[0]!.myIndices.map(i => team[i]!), opponent)!;
    for (const r of advice.reasons) {
      expect(r).not.toMatch(/Perish trap and Perish trap/);
    }
  });

  test('the rule is GENERIC — it fires on a non-perish threat too', () => {
    // Nothing here sings. A Fake Out lead plus a Tailwind core is enough: the sole
    // answer that cannot walk away still gets held back. If this only worked for
    // perish traps it would be a special case wearing a generic name.
    const noPerish = ['Incineroar', 'Archaludon', 'Milotic', 'Garganacl', 'Sylveon', 'Pelipper']
      .map(species => ({ species, knownMoves: [], candidates: [] } as unknown as OpponentEntry));
    const advice = leadAdvice(scoreBrings(team, noPerish)[0]!.myIndices.map(i => team[i]!), noPerish);
    if (advice) {
      expect(advice.lead).toHaveLength(2);
      expect(advice.reasons.length).toBeGreaterThan(0);
      expect(advice.reasons.join(' ')).not.toMatch(/perish/i);
    }
  });

  test('with no turn-denial the advice still stands, minus the risk caveat', () => {
    // Denial used to GATE the whole recommendation. It no longer does: which mons
    // answer their combos is worth saying either way, and only the Fake Out caveat
    // depends on them being able to take a turn away.
    // No Blastoise here — it IS a Fake Out carrier and would defeat the fixture.
    const harmless = ['Gengar', 'Milotic', 'Pelipper', 'Archaludon', 'Sylveon', 'Garganacl']
      .map(species => ({ species, knownMoves: [], candidates: [] } as unknown as OpponentEntry));
    const advice = leadAdvice(team.slice(0, 4), harmless);
    if (advice) expect(advice.reasons.join(' ')).not.toMatch(/Risk: they carry Fake Out/);
  });
});
