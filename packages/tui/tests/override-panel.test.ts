// /override apply logic: buildDraft round-trips current state, applyOverride
// writes field / HP (raw↔pct on mine, % on opp) / status / boosts / occupant
// moves back onto the Match.
import { describe, test, expect } from 'vitest';
import { buildDraft, applyOverride, type ActiveIdxLite } from '../src/ui/OverridePanel.js';
import type { Match, PokemonSet, OpponentEntry } from '@pokechamps/core/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '@pokechamps/core/domain/types.js';
import { maxHpFor } from '@pokechamps/core/domain/damage.js';

function mon(p: Partial<PokemonSet> & { species: string }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, moves: ['Tackle'], ...p };
}

function freshMatch(): Match {
  return {
    id: 't', startedAt: '2026-05-24T00:00:00.000Z',
    myTeam: [mon({ species: 'Sneasler' }), mon({ species: 'Rillaboom' }), mon({ species: 'Iron Hands' }), mon({ species: 'Flutter Mane' })],
    opponentTeam: ['Incineroar', 'Amoonguss', 'Garchomp', 'Talonflame'].map(species => ({ species, knownMoves: [] } as OpponentEntry)),
    bring: [0, 1, 2, 3], opponentBrought: [0, 1], turns: [], field: { ...NEUTRAL_FIELD },
    active: { mine: [null, null], theirs: [null, null] },
  };
}

const activeIdx: ActiveIdxLite = { mine: [0, 1], theirs: [0, 1] };

describe('buildDraft', () => {
  test('reflects current field + active occupants', () => {
    const m = freshMatch();
    m.field = { ...m.field, weather: 'Sun', trickRoom: true };
    const d = buildDraft(m, activeIdx);
    expect(d.weather).toBe('Sun');
    expect(d.trickRoom).toBe(true);
    expect(d.slots.find(s => s.side === 'mine' && s.slot === 0)?.teamIndex).toBe(0);
    expect(d.slots.find(s => s.side === 'theirs' && s.slot === 1)?.teamIndex).toBe(1);
  });

  test('mine HP is shown as raw (converted from stored percent)', () => {
    const m = freshMatch();
    m.myCurrentHp = { 0: 50 }; // 50%
    const d = buildDraft(m, activeIdx);
    const slot = d.slots.find(s => s.side === 'mine' && s.slot === 0)!;
    const expectedRaw = Math.round(0.5 * maxHpFor(m.myTeam[0]!));
    expect(slot.hp).toBe(expectedRaw);
  });
});

describe('applyOverride', () => {
  test('writes field state', () => {
    const m = freshMatch();
    const d = buildDraft(m, activeIdx);
    d.weather = 'Rain'; d.terrain = 'Grassy'; d.trickRoom = true; d.twMine = true;
    const { match } = applyOverride(m, activeIdx, d);
    expect(match.field?.weather).toBe('Rain');
    expect(match.field?.terrain).toBe('Grassy');
    expect(match.field?.trickRoom).toBe(true);
    expect(match.field?.myTailwind).toBe(true);
  });

  test('mine HP raw is stored back as percent', () => {
    const m = freshMatch();
    const d = buildDraft(m, activeIdx);
    const mineSlot = d.slots.find(s => s.side === 'mine' && s.slot === 0)!;
    const mx = maxHpFor(m.myTeam[0]!);
    mineSlot.hp = Math.round(mx / 2); // half HP in raw
    const { match } = applyOverride(m, activeIdx, d);
    expect(match.myCurrentHp?.[0]).toBeCloseTo(50, 0);
  });

  test('opp HP %, status and boosts apply directly', () => {
    const m = freshMatch();
    const d = buildDraft(m, activeIdx);
    const oppSlot = d.slots.find(s => s.side === 'theirs' && s.slot === 0)!;
    oppSlot.hp = 30; oppSlot.status = 'brn'; oppSlot.boosts.atk = -1; oppSlot.boosts.spe = 2;
    const { match } = applyOverride(m, activeIdx, d);
    expect(match.opponentTeam[0]!.currentHpPercent).toBe(30);
    expect(match.opponentTeam[0]!.status).toBe('brn');
    expect(match.opponentTeam[0]!.currentBoosts).toMatchObject({ atk: -1, spe: 2 });
  });

  test('changing an occupant repositions the active slot + grows opponentBrought', () => {
    const m = freshMatch();
    const d = buildDraft(m, activeIdx);
    const oppSlot = d.slots.find(s => s.side === 'theirs' && s.slot === 1)!;
    oppSlot.teamIndex = 2; // bring Garchomp into o2
    const { activeIdx: ai, match } = applyOverride(m, activeIdx, d);
    expect(ai.theirs[1]).toBe(2);
    expect(match.opponentBrought).toContain(2);
  });

  test('mine HP set to 0 marks fainted', () => {
    const m = freshMatch();
    const d = buildDraft(m, activeIdx);
    const mineSlot = d.slots.find(s => s.side === 'mine' && s.slot === 0)!;
    mineSlot.hp = 0;
    const { match } = applyOverride(m, activeIdx, d);
    expect(match.myFainted).toContain(0);
  });
});
