import { describe, test, expect } from 'vitest';
import {
  deriveSuggestionContext,
  getSuggestions,
  applySuggestion,
} from '../src/domain/actionSuggest.js';
import type { ParseContext } from '../src/domain/turnparser.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

const my: PokemonSet[] = [
  {
    species: 'Sneasler', level: 50, nature: 'Jolly',
    evs: { ...ZERO_EVS }, ivs: MAX_IVS,
    moves: ['Close Combat', 'Dire Claw', 'Fake Out', 'Protect'],
  },
  {
    species: 'Garchomp', level: 50, nature: 'Jolly',
    evs: { ...ZERO_EVS }, ivs: MAX_IVS,
    moves: ['Earthquake', 'Dragon Claw', 'Rock Slide', 'Protect'],
  },
  {
    species: 'Kingambit', level: 50, nature: 'Adamant',
    evs: { ...ZERO_EVS }, ivs: MAX_IVS,
    moves: ['Sucker Punch', 'Kowtow Cleave', 'Iron Head', 'Protect'],
  },
];

const opp: OpponentEntry[] = [
  { species: 'Incineroar', knownMoves: ['Knock Off'] }, // partial known
  { species: 'Pelipper', knownMoves: [] },              // empty — fall back to Pikalytics
  { species: 'Sinistcha', knownMoves: [] },
];

const ctx: ParseContext = {
  myTeam: my,
  opponentTeam: opp,
  myActiveTeamIndex: [0, 1],
  theirActiveTeamIndex: [0, 1],
};

describe('deriveSuggestionContext', () => {
  test('actor slot only (no >) returns kind=none', () => {
    expect(deriveSuggestionContext('m1', ctx).kind).toBe('none');
    expect(deriveSuggestionContext('m1+mega', ctx).kind).toBe('none');
    expect(deriveSuggestionContext('', ctx).kind).toBe('none');
  });

  test('state-update lines with `=` get no autocomplete (numbers, not verbs)', () => {
    expect(deriveSuggestionContext('o3 = 45%', ctx).kind).toBe('none');
  });

  test('state-verb-shaped lines (oN <verb>) return kind=state-verb', () => {
    const r = deriveSuggestionContext('o2 he', ctx);
    expect(r.kind).toBe('state-verb');
    expect(r.query).toBe('he');
    expect(r.actorSide).toBe('theirs');
    const s = getSuggestions(r, { myTeam: my, opponentTeam: opp });
    expect(s).toContain('heal');
  });

  test('completed state verb still returns state-verb (suggestions may be exact)', () => {
    const r = deriveSuggestionContext('o2 ko', ctx);
    expect(r.kind).toBe('state-verb');
    expect(getSuggestions(r, { myTeam: my, opponentTeam: opp })).toContain('ko');
  });

  test('after first > yields move slot with query', () => {
    const r = deriveSuggestionContext('m1 > Cl', ctx);
    expect(r.kind).toBe('move');
    expect(r.query).toBe('Cl');
    expect(r.actorSide).toBe('mine');
    expect(r.actorTeamIndex).toBe(0);
  });

  test('empty move slot still returns kind=move with empty query', () => {
    const r = deriveSuggestionContext('m1 > ', ctx);
    expect(r.kind).toBe('move');
    expect(r.query).toBe('');
  });

  test('switch verb advances slot 2 to switch-target', () => {
    const r = deriveSuggestionContext('m1 > switch > Ga', ctx);
    expect(r.kind).toBe('switch-target');
    expect(r.query).toBe('Ga');
    expect(r.actorSide).toBe('mine');
  });

  test('non-switch slot 2 is target — no autocomplete', () => {
    const r = deriveSuggestionContext('m1 > Close Combat > o1', ctx);
    expect(r.kind).toBe('none');
  });

  test('damage slot (4 segments) returns none', () => {
    const r = deriveSuggestionContext('m1 > Close Combat > o1 > 67', ctx);
    expect(r.kind).toBe('none');
  });

  test('bad actor token returns none', () => {
    expect(deriveSuggestionContext('p1 > Tackle', ctx).kind).toBe('none');
  });

  test('actor slot is empty in ctx — no autocomplete', () => {
    const emptyCtx: ParseContext = { ...ctx, myActiveTeamIndex: [null, 1] };
    expect(deriveSuggestionContext('m1 > Cl', emptyCtx).kind).toBe('none');
  });

  test('opp actor resolves through theirActiveTeamIndex', () => {
    const r = deriveSuggestionContext('o2 > Hu', ctx);
    expect(r.kind).toBe('move');
    expect(r.actorSide).toBe('theirs');
    expect(r.actorTeamIndex).toBe(1);
  });
});

describe('getSuggestions — move slot', () => {
  test('mine actor returns the mon\'s movepool filtered by query', () => {
    const sctx = deriveSuggestionContext('m1 > Cl', ctx);
    const s = getSuggestions(sctx, { myTeam: my, opponentTeam: opp });
    // 'Close Combat' is a prefix match; 'Dire Claw' is a substring match.
    expect(s).toContain('Close Combat');
    expect(s).toContain('Dire Claw');
    // 'Fake Out' and 'Protect' don't contain 'cl' — excluded.
    expect(s).not.toContain('Fake Out');
    expect(s).not.toContain('Protect');
    // Prefix match should rank ahead of substring match.
    expect(s.indexOf('Close Combat')).toBeLessThan(s.indexOf('Dire Claw'));
  });

  test('mine actor empty query returns full movepool + switch', () => {
    const sctx = deriveSuggestionContext('m1 > ', ctx);
    const s = getSuggestions(sctx, { myTeam: my, opponentTeam: opp });
    expect(s).toContain('Close Combat');
    expect(s).toContain('Dire Claw');
    expect(s).toContain('Fake Out');
    expect(s).toContain('Protect');
    expect(s).toContain('switch');
  });

  test('theirs actor unions knownMoves and Pikalytics top moves', () => {
    const sctx = deriveSuggestionContext('o1 > ', ctx);
    const s = getSuggestions(sctx, { myTeam: my, opponentTeam: opp });
    // Knock Off is in opp[0].knownMoves; known moves rank ahead of Pikalytics
    expect(s[0]).toBe('Knock Off');
    // Pikalytics typically lists 8+ Incineroar moves; should fill the 8-slot
    // suggestion list beyond just the known.
    expect(s.length).toBeGreaterThan(1);
    expect(s).toContain('Fake Out');
  });

  test('theirs pool includes legal learnset moves outside knownMoves and Pikalytics top', () => {
    // "Bulk Up" is in Incineroar's learnset but not in knownMoves or Pikalytics top.
    const sctx = deriveSuggestionContext('o1 > Bul', ctx);
    const s = getSuggestions(sctx, { myTeam: my, opponentTeam: opp });
    expect(s).toContain('Bulk Up');
  });

  test('theirs pool ranks knownMoves before Pikalytics before learnset within same match rank', () => {
    // 'k' matches: Knock Off (known, substring), then several Pikalytics &
    // learnset entries. Known should always appear first among matches.
    const sctx = deriveSuggestionContext('o1 > Knock', ctx);
    const s = getSuggestions(sctx, { myTeam: my, opponentTeam: opp });
    expect(s[0]).toBe('Knock Off');
  });

  test('"sw" query surfaces the switch verb', () => {
    const sctx = deriveSuggestionContext('m1 > sw', ctx);
    const s = getSuggestions(sctx, { myTeam: my, opponentTeam: opp });
    expect(s).toContain('switch');
  });

  test('theirs actor with no Pikalytics + no knownMoves still has switch', () => {
    const ctx2: ParseContext = {
      ...ctx,
      opponentTeam: [{ species: 'Nonexistmon', knownMoves: [] }],
      theirActiveTeamIndex: [0, null],
    };
    const sctx = deriveSuggestionContext('o1 > ', ctx2);
    const s = getSuggestions(sctx, ctx2);
    expect(s).toEqual(['switch']);
  });
});

describe('getSuggestions — switch-target', () => {
  test('mine switch lists team species', () => {
    const sctx = deriveSuggestionContext('m1 > switch > ', ctx);
    const s = getSuggestions(sctx, { myTeam: my, opponentTeam: opp });
    expect(s).toContain('Sneasler');
    expect(s).toContain('Garchomp');
    expect(s).toContain('Kingambit');
  });

  test('mine switch query filters', () => {
    const sctx = deriveSuggestionContext('m1 > switch > Ga', ctx);
    const s = getSuggestions(sctx, { myTeam: my, opponentTeam: opp });
    expect(s).toContain('Garchomp');
    expect(s).not.toContain('Sneasler');
  });

  test('mine switch excludes fainted teammates', () => {
    const sctx = deriveSuggestionContext('m1 > switch > ', ctx);
    const s = getSuggestions(sctx, { myTeam: my, opponentTeam: opp, myFainted: [1] }); // Garchomp fainted
    expect(s).toContain('Sneasler');
    expect(s).not.toContain('Garchomp');
    expect(s).toContain('Kingambit');
  });

  test('opp switch excludes fainted opps', () => {
    const oppF = opp.map((o, i) => i === 1 ? { ...o, fainted: true } : o);
    const ctx2 = { ...ctx, opponentTeam: oppF };
    const sctx = deriveSuggestionContext('o1 > switch > ', ctx2);
    const s = getSuggestions(sctx, { myTeam: my, opponentTeam: oppF });
    expect(s).toContain('Incineroar');
    expect(s).not.toContain('Pelipper');
    expect(s).toContain('Sinistcha');
  });
});

describe('applySuggestion', () => {
  test('move slot appends " > " after the pick', () => {
    expect(applySuggestion('m1 > Cl', 'Close Combat', 'move')).toBe('m1 > Close Combat > ');
  });

  test('switch-target appends nothing (last slot)', () => {
    expect(applySuggestion('m1 > switch > Ga', 'Garchomp', 'switch-target')).toBe('m1 > switch > Garchomp');
  });

  test('empty move slot still adds picked move + separator', () => {
    expect(applySuggestion('m1 > ', 'Protect', 'move')).toBe('m1 > Protect > ');
  });
});
