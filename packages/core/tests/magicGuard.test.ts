// Magic Guard: blocks all indirect HP loss — status chip, weather chip, residuals,
// recoil, contact-chip abilities (Rough Skin/Iron Barbs), hazard chip on switch-in.
// Heals (Leftovers, Aqua Ring, weather heals) are NOT blocked.
import { describe, test, expect } from 'vitest';
import { endOfTurn } from '../src/domain/endOfTurn.js';
import { finalizeTurn, type ActiveIdx } from '../src/match/engine.js';
import type { Match, PokemonSet, OpponentEntry, MoveAction } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}

const sandField = { ...NEUTRAL_FIELD, weather: 'Sand' as const };

function freshMatch(myAbility: string, myStatus?: 'brn' | 'psn' | 'tox'): Match {
  const m: Match = {
    id: 't', startedAt: '',
    myTeam: [mon({ species: 'Clefable', ability: myAbility, moves: ['Moonblast'] })],
    opponentTeam: [{ species: 'Tyranitar', knownMoves: [] }],
    bring: [0, 1, 2, 3], opponentBrought: [0], turns: [], field: NEUTRAL_FIELD,
    active: { mine: [null, null], theirs: [null, null] },
    myCurrentHp: { 0: 100 },
    myStatus: myStatus ? { 0: myStatus } : {},
    myToxCounter: myStatus === 'tox' ? { 0: 1 } : {},
  };
  return m;
}

const active: ActiveIdx = { mine: [0, null], theirs: [0, null] };

// ─── EOT: status chip blocked ──────────────────────────────────────────────
describe('Magic Guard blocks EOT status chip', () => {
  test('burn chip skipped for Magic Guard holder', () => {
    const m = freshMatch('Magic Guard', 'brn');
    const r = endOfTurn(m, NEUTRAL_FIELD, { mine: [0, null], theirs: [0, null] });
    expect(r.match.myCurrentHp![0]).toBe(100); // no chip
  });

  test('psn chip skipped', () => {
    const m = freshMatch('Magic Guard', 'psn');
    const r = endOfTurn(m, NEUTRAL_FIELD, { mine: [0, null], theirs: [0, null] });
    expect(r.match.myCurrentHp![0]).toBe(100);
  });

  test('tox chip skipped but counter still increments', () => {
    const m = freshMatch('Magic Guard', 'tox');
    const r = endOfTurn(m, NEUTRAL_FIELD, { mine: [0, null], theirs: [0, null] });
    expect(r.match.myCurrentHp![0]).toBe(100);
    expect(r.match.myToxCounter![0]).toBe(2); // counter still ramps
  });

  test('non-Magic Guard mon takes burn chip normally', () => {
    const m = freshMatch('Unaware', 'brn');
    const r = endOfTurn(m, NEUTRAL_FIELD, { mine: [0, null], theirs: [0, null] });
    expect(r.match.myCurrentHp![0]).toBeLessThan(100);
  });
});

// ─── EOT: weather chip blocked ─────────────────────────────────────────────
describe('Magic Guard blocks weather chip', () => {
  test('sand chip skipped for Magic Guard holder', () => {
    // Clefable is Fairy — takes sand chip normally without Magic Guard
    const m = freshMatch('Magic Guard');
    const r = endOfTurn(m, sandField, { mine: [0, null], theirs: [0, null] });
    expect(r.match.myCurrentHp![0]).toBe(100);
  });

  test('non-Magic Guard Clefable takes sand chip', () => {
    const m = freshMatch('Unaware');
    const r = endOfTurn(m, sandField, { mine: [0, null], theirs: [0, null] });
    expect(r.match.myCurrentHp![0]).toBeLessThan(100);
  });
});

// ─── Recoil blocked ────────────────────────────────────────────────────────
describe('Magic Guard blocks recoil', () => {
  test('Brave Bird recoil skipped for Magic Guard holder', () => {
    const m: Match = {
      id: 't', startedAt: '',
      myTeam: [mon({ species: 'Clefable', ability: 'Magic Guard', moves: ['Brave Bird'] })],
      opponentTeam: [{ species: 'Garchomp', knownMoves: [] }],
      bring: [0, 1, 2, 3], opponentBrought: [0], turns: [], field: NEUTRAL_FIELD,
      active: { mine: [null, null], theirs: [null, null] },
      myCurrentHp: { 0: 100 },
    };
    const action: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Brave Bird', target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      damageHpPercent: 40, targetRemainingHpPercent: 60, order: 1,
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.myCurrentHp![0]).toBe(100); // recoil blocked
  });

  test('Brave Bird recoil applies normally without Magic Guard', () => {
    const m: Match = {
      id: 't', startedAt: '',
      myTeam: [mon({ species: 'Talonflame', ability: 'Gale Wings', moves: ['Brave Bird'] })],
      opponentTeam: [{ species: 'Garchomp', knownMoves: [] }],
      bring: [0, 1, 2, 3], opponentBrought: [0], turns: [], field: NEUTRAL_FIELD,
      active: { mine: [null, null], theirs: [null, null] },
      myCurrentHp: { 0: 100 },
    };
    const action: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Brave Bird', target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      damageHpPercent: 40, targetRemainingHpPercent: 60, order: 1,
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.myCurrentHp![0]).toBeLessThan(100); // recoil applied
  });
});

// ─── Rough Skin / Iron Barbs blocked ───────────────────────────────────────
describe('Magic Guard blocks Rough Skin / Iron Barbs chip', () => {
  test('Rough Skin chip skipped when attacker has Magic Guard', () => {
    const m: Match = {
      id: 't', startedAt: '',
      myTeam: [mon({ species: 'Clefable', ability: 'Magic Guard', moves: ['Pound'] })],
      opponentTeam: [{ species: 'Garchomp', knownMoves: [], ability: 'Rough Skin' }],
      bring: [0, 1, 2, 3], opponentBrought: [0], turns: [], field: NEUTRAL_FIELD,
      active: { mine: [null, null], theirs: [null, null] },
      myCurrentHp: { 0: 100 },
    };
    const action: MoveAction = {
      side: 'mine', attackerSlot: 0, attackerTeamIndex: 0, kind: 'move',
      move: 'Pound', target: { side: 'theirs', slot: 0 }, targetTeamIndex: 0,
      damageHpPercent: 20, targetRemainingHpPercent: 80, order: 1,
    };
    const r = finalizeTurn({ match: m, turn: { actions: [action], field: NEUTRAL_FIELD }, activeIdx: active });
    expect(r.match.myCurrentHp![0]).toBe(100); // no Rough Skin chip
  });
});
