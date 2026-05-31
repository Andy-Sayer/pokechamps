// /ask command output. runAskCommand is a pure read-only function over the
// match state, so these tests construct a minimal Match and assert on the
// rendered multi-line string.
import { describe, expect, test } from 'vitest';
import { runAskCommand } from '../src/ui/BattleScreen.js';
import type { Match, PokemonSet, OpponentEntry } from '@pokechamps/core/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '@pokechamps/core/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}

const delphox = mon({
  species: 'Delphox', item: 'Delphoxite', ability: 'Blaze', nature: 'Timid',
  evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Heat Wave', 'Psychic'],
});

// Psychic is immune into Dark, Will-O-Wisp is a status move — both get dropped
// by predictOffenseAll, so this set exercises the "show the full moveset" path.
const delphoxFull = mon({
  species: 'Delphox', item: 'Delphoxite', ability: 'Blaze', nature: 'Timid',
  evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Heat Wave', 'Psychic', 'Dazzling Gleam', 'Will-O-Wisp'],
});

function matchVs(opp: OpponentEntry, mine: PokemonSet = delphox): Match {
  return {
    id: 't', startedAt: '2026-05-31T00:00:00.000Z',
    myTeam: [mine], opponentTeam: [opp],
    bring: [0], opponentBrought: [0], turns: [], field: { ...NEUTRAL_FIELD },
    active: { mine: [0, null], theirs: [0, null] },
  } as Match;
}
const activeIdx = { mine: [0, null] as [number | null, number | null], theirs: [0, null] as [number | null, number | null] };

describe('runAskCommand', () => {
  test('lists ALL of my moves and the opponent\'s expected moves', () => {
    const out = runAskCommand('m1 vs o1', matchVs({ species: 'Charizard', knownMoves: ['Solar Beam', 'Air Slash'] } as OpponentEntry), activeIdx, { ...NEUTRAL_FIELD });
    expect(out).toContain('Heat Wave');
    expect(out).toContain('Psychic');
    expect(out).toContain('Air Slash');
    expect(out).toContain('Solar Beam');
  });

  test('lists the FULL moveset, tagging immune + status moves (not just damaging ones)', () => {
    const out = runAskCommand('m1 vs o1', matchVs({ species: 'Absol', knownMoves: ['Night Slash'] } as OpponentEntry, delphoxFull), activeIdx, { ...NEUTRAL_FIELD });
    // Every move on the set appears, even the ones predictOffenseAll drops.
    for (const m of ['Heat Wave', 'Psychic', 'Dazzling Gleam', 'Will-O-Wisp']) expect(out).toContain(m);
    // Psychic is immune into Dark → flagged as no-effect, not silently missing.
    expect(out).toMatch(/Psychic\s+no effect here/);
    // Will-O-Wisp is a status move → flagged as such.
    expect(out).toMatch(/Will-O-Wisp\s+\(status move\)/);
  });

  test('shows a mega variant for my side when a stone is held', () => {
    const out = runAskCommand('m1 vs o1', matchVs({ species: 'Charizard', knownMoves: ['Air Slash'] } as OpponentEntry), activeIdx, { ...NEUTRAL_FIELD });
    expect(out).toContain('mega → Delphox-Mega');
    expect(out).toMatch(/⭢mega/);
  });

  // The opponent dual-mega worst-case: Charizard-Mega-Y keeps Flying STAB and
  // has higher SpA, so Air Slash hits HARDER on mega — /ask must report the
  // scarier forme, not the first (Mega-X) which would understate the threat.
  test('reports the WORST-case forme for a dual-mega opponent (no understatement)', () => {
    const out = runAskCommand('m1 vs o1', matchVs({ species: 'Charizard', knownMoves: ['Air Slash'] } as OpponentEntry), activeIdx, { ...NEUTRAL_FIELD });
    const air = out.split('\n').find(l => l.includes('Air Slash'))!;
    expect(air).toBeTruthy();
    // Parse "Air Slash  A-B% (...)  ⭢mega-Y C-D%": the mega max must exceed base max.
    const nums = [...air.matchAll(/(\d+)-(\d+)%/g)].map(m => Number(m[2]));
    expect(nums.length).toBe(2);            // base + mega
    expect(out).toContain('⭢mega-Y');       // labelled with the scary forme
    expect(nums[1]!).toBeGreaterThan(nums[0]!); // mega threat > base threat
  });
});
