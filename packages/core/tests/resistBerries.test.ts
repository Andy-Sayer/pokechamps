// Resist berries inclusion is weakness-aware — only mons weak to the matching
// type carry the berry. Chilan is an exception: included for neutral-Normal
// mons too because halving a Normal hit at neutral effectiveness is its niche.
import { describe, test, expect } from 'vitest';
import { resistBerryForType, resistBerriesForSpecies } from '../src/domain/resistBerries.js';

describe('resistBerryForType', () => {
  test('maps each offensive type to its matching berry', () => {
    expect(resistBerryForType('Ice')).toBe('Yache Berry');
    expect(resistBerryForType('Fire')).toBe('Occa Berry');
    expect(resistBerryForType('Dragon')).toBe('Haban Berry');
    expect(resistBerryForType('Fairy')).toBe('Roseli Berry');
    expect(resistBerryForType('Steel')).toBe('Babiri Berry');
  });

  test('returns undefined for non-existent types', () => {
    expect(resistBerryForType('NotAType')).toBeUndefined();
  });
});

describe('resistBerriesForSpecies', () => {
  test('Garchomp (Dragon/Ground) gets Ice/Dragon/Fairy resist berries', () => {
    const out = resistBerriesForSpecies('Garchomp');
    expect(out).toContain('Yache Berry'); // weak to Ice (4×)
    expect(out).toContain('Haban Berry'); // weak to Dragon
    expect(out).toContain('Roseli Berry'); // weak to Fairy
  });

  test('Charizard (Fire/Flying) gets Rock/Water/Electric resist berries (+ Chilan for neutral Normal)', () => {
    const out = resistBerriesForSpecies('Charizard');
    expect(out).toContain('Charti Berry'); // weak to Rock (4×)
    expect(out).toContain('Passho Berry'); // weak to Water
    expect(out).toContain('Wacan Berry'); // weak to Electric
    expect(out).toContain('Chilan Berry'); // neutral to Normal → Chilan included
  });

  test('does NOT include berries for resisted types', () => {
    // Charizard resists Grass — Rindo Berry would be wasted.
    const out = resistBerriesForSpecies('Charizard');
    expect(out).not.toContain('Rindo Berry');
    expect(out).not.toContain('Tanga Berry'); // Bug 4× resist on Charizard
  });

  test('Fighting/Poison Sneasler gets Psychic/Ground/Flying resist berries (but NOT Roseli)', () => {
    // Sneasler (Hisuian, Fighting/Poison) is 4× weak to Psychic, 2× to Ground
    // (via Poison) and 2× to Flying (via Fighting). It is NOT weak to Fairy —
    // Poison RESISTS Fairy (0.5×), which cancels the Fighting 2× to neutral.
    const out = resistBerriesForSpecies('Sneasler');
    expect(out).toContain('Payapa Berry'); // 4× weak to Psychic
    expect(out).toContain('Shuca Berry');  // weak to Ground via Poison
    expect(out).toContain('Coba Berry');   // weak to Flying via Fighting
    expect(out).not.toContain('Roseli Berry'); // Fairy is neutral, not SE
  });

  test('empty for unknown species (graceful)', () => {
    expect(resistBerriesForSpecies('NotAMon')).toEqual([]);
  });
});

// ─── engine integration: auto-consume on SE hit ───────────────────────────

import { finalizeTurn, type ActiveIdx } from '../src/match/engine.js';
import type { Match, PokemonSet, OpponentEntry, MoveAction } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}

// Garchomp (Dragon/Ground): weak to Ice (2×), Fairy (2×), Dragon (2×).
// Normal is neutral (1×), so Chilan would apply; Fire, Water, Electric etc. are
// resisted or neutral and must NOT trigger a type-resist berry.
function freshMatch(oppItem?: string): Match {
  const myTeam = [
    mon({ species: 'Gardevoir', ability: 'Synchronize', item: 'Yache Berry', moves: ['Ice Beam', 'Tackle'] }),
    mon({ species: 'Rillaboom', ability: 'Grassy Surge', item: 'Assault Vest', moves: ['Grassy Glide'] }),
    mon({ species: 'Iron Hands', ability: 'Quark Drive', moves: ['Drain Punch'] }),
    mon({ species: 'Flutter Mane', ability: 'Protosynthesis', moves: ['Moonblast'] }),
  ];
  // Garchomp on opp team — weak to Ice/Fairy/Dragon
  const opp: OpponentEntry = { species: 'Garchomp', knownMoves: [], item: oppItem };
  const opponentTeam: OpponentEntry[] = [opp, { species: 'Amoonguss', knownMoves: [] },
    { species: 'Incineroar', knownMoves: [] }, { species: 'Talonflame', knownMoves: [] }];
  return {
    id: 'test', startedAt: '2026-01-01T00:00:00.000Z',
    myTeam, opponentTeam, bring: [0, 1, 2, 3],
    opponentBrought: [0, 1], turns: [], field: NEUTRAL_FIELD,
    active: { mine: [null, null], theirs: [null, null] },
  };
}
const active: ActiveIdx = { mine: [0, 1], theirs: [0, 1] };

describe('resist berry auto-consume via finalizeTurn', () => {
  test('opp KNOWN Yache Berry consumed after Ice-type (SE) hit', () => {
    const match = freshMatch('Yache Berry');
    const iceHit: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Ice Beam', target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      targetRemainingHpPercent: 60, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [iceHit], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.opponentTeam[0]!.itemConsumed).toBe('Yache Berry');
  });

  test('opp KNOWN Yache Berry NOT consumed for non-SE hit (Tackle = Normal on Garchomp)', () => {
    const match = freshMatch('Yache Berry');
    const normalHit: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Tackle', target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      targetRemainingHpPercent: 70, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [normalHit], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.opponentTeam[0]!.itemConsumed).toBeFalsy();
  });

  test('opp with UNKNOWN item (no o.item) — never auto-consume (conservatism)', () => {
    const match = freshMatch(undefined); // item not set → unknown
    const iceHit: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Ice Beam', target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      targetRemainingHpPercent: 60, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [iceHit], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.opponentTeam[0]!.itemConsumed).toBeFalsy();
  });

  test('opp Chilan Berry consumed after Normal-type hit (neutral effectiveness)', () => {
    const match = freshMatch('Chilan Berry');
    const normalHit: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Tackle', target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      targetRemainingHpPercent: 75, order: 1,
    };
    const r = finalizeTurn({ match, turn: { actions: [normalHit], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.opponentTeam[0]!.itemConsumed).toBe('Chilan Berry');
  });

  test('my Gardevoir (Psychic/Fairy) holds Yache Berry — consumed after opp Ice hit (SE)', () => {
    // Gardevoir is Psychic/Fairy; Ice is neutral vs it. Not SE, so NO consume.
    // Use Incineroar (Fire/Dark) instead — Ice is SE vs Fire/Dark? No, Fire resists Ice.
    // Use Garchomp on MY side instead (via a custom match):
    const match2: Match = {
      id: 'test2', startedAt: '2026-01-01T00:00:00.000Z',
      myTeam: [
        mon({ species: 'Garchomp', ability: 'Rough Skin', item: 'Yache Berry', moves: ['Earthquake'] }),
        mon({ species: 'Rillaboom', ability: 'Grassy Surge', moves: ['Grassy Glide'] }),
        mon({ species: 'Iron Hands', ability: 'Quark Drive', moves: ['Drain Punch'] }),
        mon({ species: 'Flutter Mane', ability: 'Protosynthesis', moves: ['Moonblast'] }),
      ],
      opponentTeam: [
        { species: 'Weavile', knownMoves: ['Ice Punch'] },
        { species: 'Amoonguss', knownMoves: [] },
        { species: 'Incineroar', knownMoves: [] },
        { species: 'Talonflame', knownMoves: [] },
      ],
      bring: [0, 1, 2, 3], opponentBrought: [0, 1], turns: [], field: NEUTRAL_FIELD,
      active: { mine: [null, null], theirs: [null, null] },
      myCurrentHp: {},
    };
    const iceHit: MoveAction = {
      side: 'theirs', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Ice Punch', target: { side: 'mine', slot: 0 }, targetTeamIndex: 0,
      targetRemainingHpPercent: 55, order: 1,
    };
    const r = finalizeTurn({ match: match2, turn: { actions: [iceHit], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.myItemConsumed?.[0]).toBe('Yache Berry');
  });
});
