// Opponent-foresight model (SearchBreadth.oppForesight): the user-tunable
// "how far ahead does the opponent look" knob. Contract under test:
//   1. foresight ≥ remaining depth ⇒ EXACTLY the full maximin (same score, plays)
//   2. a foresight-limited opponent can never make my value WORSE than maximin
//   3. a win proved against a limited opponent is never claimed `forced`
//   4. even a 1-ply opponent escapes a lethal Perish clock (the faint is in the
//      1-ply child via resolveTurn's end-of-turn tick, so "switch" wins their
//      chooser) — the trap is not scored as a free win against a dumb model.
import { describe, test, expect } from 'vitest';
import { createSearch, searchToDepth, type SearchInput } from '../src/domain/endgameSearch.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
function oppOf(set: PokemonSet): OpponentEntry {
  return { species: set.species, knownMoves: set.moves, candidates: [set] };
}

const flutter = mon({
  species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid',
  evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 }, moves: ['Moonblast', 'Shadow Ball'],
});
const garchomp = mon({
  species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly',
  evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 }, moves: ['Earthquake', 'Dragon Claw'],
});
const incin = mon({
  species: 'Incineroar', ability: 'Intimidate', nature: 'Careful',
  evs: { hp: 252, atk: 0, def: 4, spa: 0, spd: 252, spe: 0 }, moves: ['Knock Off', 'Flare Blitz'],
});

const WIN = 100_000;

describe('opponent foresight', () => {
  test('foresight covering the horizon is EXACTLY full maximin', () => {
    const input: SearchInput = {
      mine: [{ set: flutter, hpPercent: 100, active: true }],
      opp: [
        { entry: oppOf(garchomp), hpPercent: 100, active: true },
        { entry: oppOf(incin), hpPercent: 100, active: true },
      ],
      field: { ...NEUTRAL_FIELD },
    };
    const full = searchToDepth(input, 3);
    const fs = createSearch(input, { oppForesight: 9 }).toDepth(3);
    expect(fs.score).toBe(full.score);
    expect(fs.verdict).toBe(full.verdict);
    expect(fs.plays).toEqual(full.plays);
  });

  test('a foresight-limited opponent never lowers my value below maximin', () => {
    const input: SearchInput = {
      mine: [{ set: flutter, hpPercent: 20, active: true }],
      opp: [
        { entry: oppOf(garchomp), hpPercent: 100, active: true },
        { entry: oppOf(incin), hpPercent: 100, active: true },
      ],
      field: { ...NEUTRAL_FIELD },
    };
    const full = searchToDepth(input, 4);
    const fs1 = createSearch(input, { oppForesight: 1 }).toDepth(4);
    expect(fs1.score).toBeGreaterThanOrEqual(full.score);
  });

  test('forced WIN is claimed under full maximin but never under a limited model', () => {
    const input: SearchInput = {
      mine: [{ set: flutter, hpPercent: 100, active: true }],
      opp: [{ entry: oppOf(incin), hpPercent: 1, active: true }],
      field: { ...NEUTRAL_FIELD },
      allOppRevealed: true,
    };
    const full = searchToDepth(input, 2);
    expect(full.forced).toBe(true);           // worst-case KO on a 1% foe
    expect(full.score).toBeGreaterThanOrEqual(WIN);
    const fs = createSearch(input, { oppForesight: 1 }).toDepth(2);
    expect(fs.score).toBeGreaterThanOrEqual(WIN);  // same outcome…
    expect(fs.forced).toBe(false);                 // …but never PROVEN forced
    expect(fs.breadth?.oppForesight).toBe(1);      // and the model is reported
  });

  test('a 1-ply opponent still escapes a lethal Perish clock', () => {
    // Flutter Mane's clock hits 0 at this turn's EOT; Garchomp waits on their
    // bench. A 1-ply chooser sees "stay = faint, switch = live" in the child
    // states (resolveTurn applies the tick), so the limited model must not
    // gift me the perish KO at interior nodes. The observable: the foresight
    // model's score stays CLOSE to full maximin (both models escape) instead
    // of jumping by a mon's worth of material (limited model sat in the faint).
    // Note the ROOT reply is exact-min in both models by design, so this
    // exercises the committed replies at depth.
    const input: SearchInput = {
      mine: [{ set: incin, hpPercent: 100, active: true }],
      opp: [
        { entry: oppOf(flutter), hpPercent: 100, active: true, perishCount: 1 },
        { entry: oppOf(garchomp), hpPercent: 100, active: false },
      ],
      field: { ...NEUTRAL_FIELD },
      allOppRevealed: true,
    };
    const full = searchToDepth(input, 3);
    const fs1 = createSearch(input, { oppForesight: 1 }).toDepth(3);
    // Monotone: the limited model may only help me…
    expect(fs1.score).toBeGreaterThanOrEqual(full.score);
    // …and only marginally — a sat-in-the-faint model would inflate the score
    // by roughly a full mon of material (|scores| here run ~1000 per mon).
    expect(fs1.score - full.score).toBeLessThan(800);
    // Never a proven win under a limited model.
    expect(fs1.score).toBeLessThan(WIN);
  });
});
