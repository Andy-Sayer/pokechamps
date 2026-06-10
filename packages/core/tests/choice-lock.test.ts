// Choice lock (per-move cells stage b). A Choice holder that has used a move is
// locked to that move's per-move cell — at the live-match root (via
// choiceLockedMove / searchInputFromMatch) AND dynamically inside the search
// tree (an unlocked holder that attacks at ply 1 stays locked for the rest of
// the lookahead) — until it switches out. Opp locks only from a KNOWN Choice
// item; soft repeated-move suspicions never restrict the search.
import { describe, test, expect } from 'vitest';
import { searchToDepth, searchInputFromMatch, type SearchInput } from '../src/domain/endgameSearch.js';
import { lockedMoveSinceEntry } from '../src/domain/itemSignals.js';
import type { PokemonSet, OpponentEntry, Match, MoveAction } from '../src/domain/types.js';
import { NEUTRAL_FIELD, ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}
function oppOf(set: PokemonSet, extra: Partial<OpponentEntry> = {}): OpponentEntry {
  return { species: set.species, knownMoves: set.moves, candidates: [set], item: set.item, ...extra };
}

describe('root Choice lock — my side', () => {
  // Banded Garchomp locked into Dragon Claw vs a Fairy (Dragon-immune): the
  // locked move has no legal target, so the only real option is switching out.
  const bandChomp = mon({
    species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', item: 'Choice Band',
    evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Dragon Claw', 'Stone Edge'],
  });
  const oppFairy = mon({
    species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid',
    evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Moonblast'],
  });
  const bench = mon({
    species: 'Iron Hands', ability: 'Quark Drive', nature: 'Adamant',
    evs: { ...ZERO_EVS, hp: 252, atk: 252 }, moves: ['Drain Punch', 'Wild Charge'],
  });

  test('locked into an immune move → recommended play is a switch', () => {
    const r = searchToDepth({
      mine: [
        { set: bandChomp, hpPercent: 100, active: true, choiceLockedMove: 'Dragon Claw' },
        { set: bench, hpPercent: 100, active: false },
      ],
      opp: [{ entry: oppOf(oppFairy), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 2);
    expect(r.plays).toHaveLength(1);
    expect(r.plays[0]!.move).toBe('switch');
  });

  test('same position unlocked → attacks (Stone Edge is available)', () => {
    const r = searchToDepth({
      mine: [
        { set: bandChomp, hpPercent: 100, active: true },
        { set: bench, hpPercent: 100, active: false },
      ],
      opp: [{ entry: oppOf(oppFairy), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 2);
    expect(r.plays).toHaveLength(1);
    expect(r.plays[0]!.move).not.toBe('switch');
  });

  test('locked with no bench and no target → no-ops without crashing', () => {
    const r = searchToDepth({
      mine: [{ set: bandChomp, hpPercent: 100, active: true, choiceLockedMove: 'Dragon Claw' }],
      opp: [{ entry: oppOf(oppFairy), hpPercent: 100, active: true }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 2);
    expect(r.plays).toHaveLength(1);
    expect(r.verdict).toBeDefined();
  });
});

describe('dynamic in-tree Choice lock', () => {
  // The core property: a 1v2 winnable only by using two DIFFERENT moves on
  // consecutive turns. Foe A (Staraptor, Normal/Flying) is immune to Shadow
  // Ball and dies to Thunderbolt; foe B (Dugtrio, Ground) is immune to
  // Thunderbolt and dies to Shadow Ball. Neither foe can damage my Ghost/Fairy
  // attacker (their only move is Normal). Without an item the position is a
  // clean win; with Choice Specs the first KO locks the move the second foe is
  // immune to, so the win disappears.
  const foes = (): SearchInput['opp'] => [
    { entry: oppOf(mon({ species: 'Staraptor', ability: 'Intimidate', nature: 'Jolly', evs: { ...ZERO_EVS }, moves: ['Quick Attack'] })), hpPercent: 100, active: true },
    // 50% so the itemless Shadow Ball is a guaranteed KO (full HP would need Specs).
    { entry: oppOf(mon({ species: 'Dugtrio', ability: 'Sand Veil', nature: 'Jolly', evs: { ...ZERO_EVS }, moves: ['Tackle'] })), hpPercent: 50, active: true },
  ];
  const attacker = (item?: string) => mon({
    species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid', item,
    evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Shadow Ball', 'Thunderbolt'],
  });

  test('without a Choice item the two-move 1v2 is winning', () => {
    const r = searchToDepth({
      mine: [{ set: attacker(), hpPercent: 100, active: true }],
      opp: foes(), field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 3);
    expect(r.verdict).toBe('winning');
  });

  test('with Choice Specs the first KO locks the wrong move → not winning', () => {
    const r = searchToDepth({
      mine: [{ set: attacker('Choice Specs'), hpPercent: 100, active: true }],
      opp: foes(), field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    }, 3);
    expect(r.verdict).not.toBe('winning');
  });
});

describe('opp Choice lock honored', () => {
  // Bulky Banded Garchomp with Dragon Claw + Poison Jab vs my Flutter Mane
  // (Ghost/Fairy): Dragon Claw is IMMUNE vs Fairy, Poison Jab is super-effective
  // and scary. Locked into Dragon Claw the chomp can't touch me → winning, and
  // no advisory line may name Poison Jab. Unlocked, Poison Jab makes it a real
  // fight (strictly worse verdict/score for me).
  const oppChomp = mon({
    species: 'Garchomp', ability: 'Rough Skin', nature: 'Adamant', item: 'Choice Band',
    evs: { ...ZERO_EVS, hp: 252, atk: 252 }, moves: ['Dragon Claw', 'Poison Jab'],
  });
  const myFlutter = mon({
    species: 'Flutter Mane', ability: 'Protosynthesis', nature: 'Timid',
    evs: { ...ZERO_EVS, spa: 252, spe: 252 }, moves: ['Moonblast', 'Shadow Ball'],
  });
  const base = (locked: boolean): SearchInput => ({
    mine: [{ set: myFlutter, hpPercent: 100, active: true }],
    opp: [{ entry: oppOf(oppChomp), hpPercent: 100, active: true, choiceLockedMove: locked ? 'Dragon Claw' : undefined }],
    field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
  });

  test('locked opp cannot threaten with its other moves', () => {
    const locked = searchToDepth(base(true), 2);
    const unlocked = searchToDepth(base(false), 2);
    expect(locked.score).toBeGreaterThan(unlocked.score);
    expect(locked.verdict).toBe('winning');
    // No advisory surface may name the move it can't use.
    const texts = [
      ...locked.risks.map(x => x.label),
      ...(locked.oppLine ?? []).map(p => p.move),
      ...(locked.obviousOppPlay ?? []).map(p => p.move),
    ].join(' | ');
    expect(texts).not.toContain('Poison Jab');
  });

  test('a soft suspicion (no known item) does NOT lock', () => {
    // Same chomp but the item is NOT revealed: the choiceLockedMove field must
    // be a complete no-op (searchInputFromMatch never sets it in this case;
    // initialState gates on isChoiceItem too). Identical input ± the field
    // must produce the identical score.
    const entry = oppOf({ ...oppChomp, item: undefined });
    const mk = (lock?: string): SearchInput => ({
      mine: [{ set: myFlutter, hpPercent: 100, active: true }],
      opp: [{ entry, hpPercent: 100, active: true, choiceLockedMove: lock }],
      field: { ...NEUTRAL_FIELD }, allOppRevealed: true,
    });
    const withBogusLock = searchToDepth(mk('Dragon Claw'), 2);
    const without = searchToDepth(mk(), 2);
    expect(withBogusLock.score).toBe(without.score);
    expect(withBogusLock.verdict).toBe(without.verdict);
  });
});

describe('lockedMoveSinceEntry (match-log derivation)', () => {
  const turns = (actions: Array<Partial<MoveAction> & { side: 'mine' | 'theirs' }>): Match =>
    ({ turns: actions.map((a, i) => ({ index: i + 1, actions: [a] })) } as unknown as Match);

  test('last move since entry; null before any move', () => {
    expect(lockedMoveSinceEntry(turns([]), 'mine', 0)).toBeNull();
    const m = turns([
      { side: 'mine', kind: 'move', attackerTeamIndex: 0, move: 'Earthquake' },
      { side: 'mine', kind: 'move', attackerTeamIndex: 0, move: 'Earthquake' },
    ]);
    expect(lockedMoveSinceEntry(m, 'mine', 0)).toBe('Earthquake');
  });

  test('a switch involving the mon resets the lock', () => {
    const m = turns([
      { side: 'mine', kind: 'move', attackerTeamIndex: 0, move: 'Earthquake' },
      { side: 'mine', kind: 'switch', attackerTeamIndex: 0, targetTeamIndex: 2 },
    ]);
    expect(lockedMoveSinceEntry(m, 'mine', 0)).toBeNull();
    // Re-enters and moves again → locked into the new move.
    const m2 = turns([
      { side: 'mine', kind: 'move', attackerTeamIndex: 0, move: 'Earthquake' },
      { side: 'mine', kind: 'switch', attackerTeamIndex: 0, targetTeamIndex: 2 },
      { side: 'mine', kind: 'switch', attackerTeamIndex: 2, targetTeamIndex: 0 },
      { side: 'mine', kind: 'move', attackerTeamIndex: 0, move: 'Stone Edge' },
    ]);
    expect(lockedMoveSinceEntry(m2, 'mine', 0)).toBe('Stone Edge');
  });

  test('other side / other mon does not interfere', () => {
    const m = turns([
      { side: 'theirs', kind: 'move', attackerTeamIndex: 0, move: 'Moonblast' },
      { side: 'mine', kind: 'move', attackerTeamIndex: 1, move: 'Protect' },
    ]);
    expect(lockedMoveSinceEntry(m, 'mine', 0)).toBeNull();
    expect(lockedMoveSinceEntry(m, 'theirs', 0)).toBe('Moonblast');
  });
});

describe('searchInputFromMatch threads the Choice lock', () => {
  const bandChomp = mon({
    species: 'Garchomp', ability: 'Rough Skin', nature: 'Jolly', item: 'Choice Band',
    evs: { ...ZERO_EVS, atk: 252, spe: 252 }, moves: ['Earthquake', 'Dragon Claw'],
  });
  const freshMatch = (): Match => ({
    id: 't', startedAt: '2026-06-09T00:00:00.000Z',
    myTeam: [bandChomp, mon({ species: 'Flutter Mane', moves: ['Moonblast'] })],
    opponentTeam: [
      { species: 'Urshifu-Rapid-Strike', knownMoves: ['Surging Strikes'], item: 'Choice Band' } as OpponentEntry,
      { species: 'Amoonguss', knownMoves: [] } as OpponentEntry,
    ],
    bring: [0, 1], opponentBrought: [0, 1], turns: [], field: { ...NEUTRAL_FIELD },
    active: { mine: [null, null], theirs: [null, null] },
  });

  test('my Choice holder that moved → locked; opp known-Band mover → locked', () => {
    const m = freshMatch();
    m.turns = [{
      index: 1, actions: [
        { side: 'mine', kind: 'move', attackerTeamIndex: 0, move: 'Earthquake' } as MoveAction,
        { side: 'theirs', kind: 'move', attackerTeamIndex: 0, move: 'Surging Strikes' } as MoveAction,
      ],
    }];
    const input = searchInputFromMatch(m, { mine: [0, 1], theirs: [0, 1] });
    expect(input.mine[0]!.choiceLockedMove).toBe('Earthquake');
    expect(input.opp[0]!.choiceLockedMove).toBe('Surging Strikes');
    // Non-Choice mons never get a lock.
    expect(input.mine[1]!.choiceLockedMove).toBeUndefined();
    expect(input.opp[1]!.choiceLockedMove).toBeUndefined();
  });

  test('no lock without a revealed opp item, after a knock-off, or before moving', () => {
    const m = freshMatch();
    m.opponentTeam[0]!.item = undefined;          // item not revealed → no hard lock
    m.myItemConsumed = { 0: 'Choice Band' };      // my Band knocked off → lock lifted
    m.turns = [{
      index: 1, actions: [
        { side: 'mine', kind: 'move', attackerTeamIndex: 0, move: 'Earthquake' } as MoveAction,
        { side: 'theirs', kind: 'move', attackerTeamIndex: 0, move: 'Surging Strikes' } as MoveAction,
      ],
    }];
    const input = searchInputFromMatch(m, { mine: [0, 1], theirs: [0, 1] });
    expect(input.mine[0]!.choiceLockedMove).toBeUndefined();
    expect(input.opp[0]!.choiceLockedMove).toBeUndefined();
  });
});
