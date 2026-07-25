// Rage Fist gains +50 BP per damaging hit TAKEN (capped at 350 = 7x base). The live
// engine counts it (myTimesHit / OpponentEntry.timesHit, reset on switch-out per the
// Champions rule), damage.ts applies the BP override, and predictions plumb it — but the
// search never PASSED it, so every cell was built as if the mon had never been hit. An
// Annihilape that had eaten five hits was priced at its opening damage.
import { describe, test, expect } from 'vitest';
import { buildTablesForTest, searchInputFromMatch, type SearchInput } from '../src/domain/endgameSearch.js';
import type { Match, MoveAction, OpponentEntry, PokemonSet } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
const oppOf = (set: PokemonSet): OpponentEntry =>
  ({ species: set.species, knownMoves: set.moves, ability: set.ability, candidates: [set] });
const ape = mon({ species: 'Annihilape', ability: 'Defiant', nature: 'Adamant', evs: { ...ZERO_EVS, atk: 252 }, moves: ['Rage Fist'] });
const dozo = mon({ species: 'Dondozo', ability: 'Unaware', nature: 'Impish', evs: { ...ZERO_EVS, hp: 252, def: 252 }, moves: ['Wave Crash'] });

const dmgWith = (timesHit: number | undefined): number => {
  const input: SearchInput = {
    mine: [{ set: ape, hpPercent: 100, active: true, timesHit }],
    opp: [{ entry: oppOf(dozo), hpPercent: 100, active: true }],
    field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
  };
  return buildTablesForTest(input, { myMega: null, oppMega: null }).off[0]![0]!.dmgMid;
};

describe('Rage Fist carries the live hit counter into the search', () => {
  test('more hits taken → a bigger cell', () => {
    const fresh = dmgWith(0);
    const beaten = dmgWith(4);
    expect(beaten).toBeGreaterThan(fresh);
    // 5x base BP vs 1x — the cell should scale roughly with (1 + hits).
    expect(beaten / fresh).toBeGreaterThan(3);
  });

  test('undefined behaves as zero (a mon we have no count for)', () => {
    expect(dmgWith(undefined)).toBeCloseTo(dmgWith(0), 5);
  });

  test('the +50/hit bonus caps out (350 BP = 7x)', () => {
    expect(dmgWith(9)).toBeCloseTo(dmgWith(6), 5);   // 6 and 9 hits both sit at the cap
  });

  test('the LIVE match feeds the counter through searchInputFromMatch', () => {
    const m: Match = {
      id: 't', startedAt: '2026-07-25T00:00:00.000Z',
      myTeam: [ape], opponentTeam: [oppOf(dozo)],
      bring: [0], opponentBrought: [0],
      turns: [{ index: 1, actions: [{ side: 'theirs', kind: 'move', attackerTeamIndex: 0, move: 'Wave Crash' } as MoveAction], field: { ...NEUTRAL_FIELD } }],
      field: { ...NEUTRAL_FIELD }, active: { mine: [0, null], theirs: [0, null] },
      myTimesHit: { 0: 3 },
    };
    const inp = searchInputFromMatch(m, { mine: [0, null], theirs: [0, null] });
    expect(inp.mine[0]!.timesHit).toBe(3);
  });
});
