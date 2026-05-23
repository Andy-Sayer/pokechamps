// applyMegaAction + resolveMegaForme tests. Verifies the X/Y
// disambiguation logic and the side-effect mutations on the Match.
import { describe, expect, test } from 'vitest';
import { applyMegaAction } from '../src/domain/megaResolve.js';
import { resolveMegaForme, getMegaOptions } from '../src/domain/gimmicks/mega.js';
import type { Match, MoveAction, PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { MAX_IVS, ZERO_EVS, NEUTRAL_FIELD } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string }): PokemonSet {
  return {
    level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: { ...MAX_IVS }, moves: [],
    ...p,
  };
}

function makeMatch(myTeam: PokemonSet[], oppSpecies: string[]): Match {
  return {
    id: 't', startedAt: '2026-05-22',
    myTeam,
    opponentTeam: oppSpecies.map<OpponentEntry>(s => ({ species: s, knownMoves: [] })),
    bring: [0],
    turns: [], field: { ...NEUTRAL_FIELD },
    active: { mine: [null, null], theirs: [null, null] },
  };
}

function megaAction(side: 'mine' | 'theirs', teamIndex: number, variant: string): MoveAction {
  return {
    side, attackerSlot: 0, kind: 'mega',
    move: variant ? `mega-${variant}` : 'mega',
    attackerTeamIndex: teamIndex, target: 'self', order: 1,
  };
}

describe('resolveMegaForme (raw — no legality filter)', () => {
  test('species with multiple options + no variant returns null', () => {
    // PoChamps has Lucarionite + Lucarionite Z. resolveMegaForme doesn't
    // know about format legality, so empty variant + 2 options is ambiguous.
    expect(resolveMegaForme('Lucario', '')).toBeNull();
    expect(resolveMegaForme('Charizard', '')).toBeNull();
  });

  test('explicit variant resolves', () => {
    const y = resolveMegaForme('Charizard', 'y');
    expect(y?.forme).toBe('Charizard-Mega-Y');
    expect(y?.stone).toBe('Charizardite Y');
    const x = resolveMegaForme('Charizard', 'x');
    expect(x?.forme).toBe('Charizard-Mega-X');
    expect(x?.stone).toBe('Charizardite X');
  });

  test('getMegaOptions surfaces both Charizard X+Y options', () => {
    const opts = getMegaOptions('Charizard');
    const variants = opts.map(o => o.variant).sort();
    expect(variants).toContain('x');
    expect(variants).toContain('y');
  });

  test('non-mega species returns no options', () => {
    expect(getMegaOptions('Snorlax')).toEqual([]);
    expect(resolveMegaForme('Snorlax', '')).toBeNull();
  });
});

describe('applyMegaAction — opp side', () => {
  test('Lucario opp + "o1 mega" sets megaForme + confirms held stone', () => {
    const m = makeMatch([mon({ species: 'Sneasler' })], ['Lucario']);
    const err = applyMegaAction(m, megaAction('theirs', 0, ''));
    expect(err).toBeNull();
    const opp = m.opponentTeam[0]!;
    expect(opp.megaUsed).toBe(true);
    expect(opp.megaForme).toBe('Lucario-Mega');
    expect(opp.item).toBe('Lucarionite');
    // species stays as the base — we look up mega-options off it later.
    expect(opp.species).toBe('Lucario');
  });

  test('Charizard opp + "o1 mega y" picks Y forme', () => {
    const m = makeMatch([mon({ species: 'Sneasler' })], ['Charizard']);
    expect(applyMegaAction(m, megaAction('theirs', 0, 'y'))).toBeNull();
    expect(m.opponentTeam[0]!.megaForme).toBe('Charizard-Mega-Y');
    expect(m.opponentTeam[0]!.item).toBe('Charizardite Y');
  });

  test('Charizard opp + bare "o1 mega" errors out (ambiguous)', () => {
    const m = makeMatch([mon({ species: 'Sneasler' })], ['Charizard']);
    const err = applyMegaAction(m, megaAction('theirs', 0, ''));
    expect(err).toBeTruthy();
    expect(err).toContain('Charizard');
    expect(err).toContain('disambiguate');
    expect(m.opponentTeam[0]!.megaForme).toBeUndefined();
    expect(m.opponentTeam[0]!.megaUsed).toBeUndefined();
  });

  test('non-mega species errors out cleanly', () => {
    const m = makeMatch([mon({ species: 'Sneasler' })], ['Snorlax']);
    const err = applyMegaAction(m, megaAction('theirs', 0, ''));
    expect(err).toBeTruthy();
    expect(err).toContain('Snorlax');
    expect(m.opponentTeam[0]!.megaForme).toBeUndefined();
  });
});

describe('applyMegaAction — mine side', () => {
  test('Charizard mine + "m1 mega x" records forme on myMegaForme', () => {
    const m = makeMatch([mon({ species: 'Charizard', item: 'Charizardite X' })], ['Pikachu']);
    expect(applyMegaAction(m, megaAction('mine', 0, 'x'))).toBeNull();
    expect(m.myMegaUsed).toEqual([0]);
    expect(m.myMegaForme).toEqual({ 0: 'Charizard-Mega-X' });
    // We do NOT mutate the team's item — it's already known from the team
    // data and the gimmick's calc-time resolver handles the swap.
    expect(m.myTeam[0]!.item).toBe('Charizardite X');
  });

  test('mine side with held stone auto-resolves even without explicit variant', () => {
    // Charizard has 2 mega formes but the held item (Charizardite Y) locks
    // it — no need for the user to type the variant.
    const m = makeMatch([mon({ species: 'Charizard', item: 'Charizardite Y' })], ['Pikachu']);
    expect(applyMegaAction(m, megaAction('mine', 0, ''))).toBeNull();
    expect(m.myMegaForme).toEqual({ 0: 'Charizard-Mega-Y' });
  });

  test('mine side with no item and no variant errors out cleanly', () => {
    const m = makeMatch([mon({ species: 'Charizard' })], ['Pikachu']);
    const err = applyMegaAction(m, megaAction('mine', 0, ''));
    expect(err).toBeTruthy();
    expect(err).toContain('Charizard');
    expect(m.myMegaUsed).toBeUndefined();
    expect(m.myMegaForme).toBeUndefined();
  });
});
