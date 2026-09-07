// Opponent sets for mons with NO usage data — the ~2-week hole a regulation
// rotation leaves, during which every team builder used to silently drop exactly
// the species the rotation is about. See domain/inferredSets.ts.
import { describe, test, expect } from 'vitest';
import { loadPikaData, buildSet } from '../src/domain/metaTeams.js';
import { inferredSet, buildSetOrInfer, describeSources } from '../src/domain/inferredSets.js';
import { buildThreatTeam } from '../src/domain/creatorIntel.js';
import { loadFormat, isLegalItem, isLegalSpecies, toId } from '../src/domain/data.js';
import { getMegaOptions } from '../src/domain/gimmicks/mega.js';
import { dossierBase, rolesFrom } from '../src/domain/monDossier.js';
import { getMove } from '../src/domain/data.js';

const format = loadFormat();

describe('inferredSets', () => {
  test('the gap is real: buildSet returns null for a newly-legal species', () => {
    // Rillaboom is M-C-legal and has no M-B Pikalytics entry. If this ever starts
    // passing, usage has landed and the fallback is no longer load-bearing.
    const pika = loadPikaData();
    expect(isLegalSpecies('rillaboom', format)).toBe(true);
    expect(buildSet(pika, 'Rillaboom', new Set())).toBeNull();
  });

  test('inferredSet fills it with a legal, complete set', () => {
    const s = inferredSet('Rillaboom', new Set());
    expect(s).not.toBeNull();
    expect(s!.set.species).toBe('Rillaboom');
    expect(s!.set.moves).toHaveLength(4);
    expect(s!.set.ability).toBeTruthy();
    expect(s!.set.level).toBe(format.level);
    expect(['analog', 'derived']).toContain(s!.source);
    if (s!.set.item) expect(isLegalItem(toId(s!.set.item), format)).toBe(true);
  });

  // NOTE: do NOT assert a 508 EV budget here. Champions allocates STAT POINTS
  // (0-32 per stat) and evFromSp maps each to whatever EV reproduces the same
  // L50/31-IV stat, so the EV *total* is an artifact of that mapping, not a rule
  // — 49 of 50 real usage-built sets come out at 516. Asserting 508 would only
  // force inferred sets to be weaker than the real ones they sit beside.
  test('EVs are valid evFromSp outputs, capped at 252 per stat', () => {
    for (const sp of ['Rillaboom', 'Golisopod', 'Baxcalibur', 'Salamence']) {
      const s = inferredSet(sp, new Set());
      if (!s) continue;
      for (const [stat, ev] of Object.entries(s.set.evs)) {
        expect(ev, `${sp}.${stat}`).toBeLessThanOrEqual(252);
        expect(ev, `${sp}.${stat}`).toBeGreaterThanOrEqual(0);
        // evFromSp yields 0, or 4 + 8k (clamped at 252).
        expect(ev === 0 || ev === 252 || (ev - 4) % 8 === 0, `${sp}.${stat}=${ev} is not an evFromSp value`).toBe(true);
      }
    }
  });

  // REGRESSION: DossierEntry.moves is a candidate POOL (~8), not a chosen set.
  // Taking the first four dropped Grassy Glide from Rillaboom — a mon the dossier
  // itself tags 'priority' — so the set contradicted its own role label and every
  // downstream read inherited that. The picked 4 must realise the entry's roles.
  test('the chosen 4 moves express the roles the dossier assigned', () => {
    for (const sp of ['Rillaboom', 'Golisopod', 'Baxcalibur', 'Salamence']) {
      const entry = dossierBase(sp);
      const s = inferredSet(sp, new Set());
      if (!entry || !s) continue;
      const ids = s.set.moves.map(m => toId((getMove(toId(m)) as { name?: string }).name ?? m));
      const got = new Set(rolesFrom(ids, [toId(entry.ability ?? '')].filter(Boolean), entry.baseStats));
      // Every role the entry claims must be realisable within 4 slots; with <=4
      // roles all must appear.
      if (entry.roles.length <= 4) {
        for (const r of entry.roles) expect(got.has(r), `${sp} is tagged ${r} but its set has no move for it`).toBe(true);
      }
    }
  });

  test('Rillaboom specifically keeps Grassy Glide', () => {
    const s = inferredSet('Rillaboom', new Set());
    expect(s!.set.moves.map(m => toId(m))).toContain('grassyglide');
  });

  test('provenance is never silently "usage" for an inferred set', () => {
    const s = inferredSet('Rillaboom', new Set());
    expect(s!.source).not.toBe('usage');
    // 'analog' is the trustworthy tier; 'derived' must not claim to be safe.
    if (s!.source === 'derived') expect(s!.safe).toBe(false);
  });

  test('buildSetOrInfer prefers REAL usage over inference', () => {
    const pika = loadPikaData();
    const s = buildSetOrInfer(pika, 'Incineroar', new Set());
    expect(s).not.toBeNull();
    expect(s!.source).toBe('usage');   // Incineroar has M-B usage; never infer over that
    expect(s!.safe).toBe(true);
  });

  test('respects the item clause across a team', () => {
    const used = new Set<string>();
    const items: string[] = [];
    for (const sp of ['Rillaboom', 'Golisopod', 'Baxcalibur', 'Salamence']) {
      const s = inferredSet(sp, used);
      if (s?.set.item) items.push(toId(s.set.item));
    }
    expect(new Set(items).size, `duplicate item: ${items.join(', ')}`).toBe(items.length);
  });

  test('takes a mega stone only while the team still has its mega', () => {
    const withMega = inferredSet('Salamence', new Set(), { megaAvailable: true });
    const stones = getMegaOptions('Salamence').map(m => toId(m.stone));
    expect(stones.length).toBeGreaterThan(0);
    expect(stones, 'should claim its stone when the mega is free').toContain(toId(withMega!.set.item ?? ''));

    const without = inferredSet('Salamence', new Set(), { megaAvailable: false });
    expect(stones, 'must not take a second mega').not.toContain(toId(without!.set.item ?? ''));
  });

  test('describeSources names the inferred mons rather than burying them', () => {
    const used = new Set<string>();
    const sourced = ['Incineroar', 'Rillaboom'].map(sp => buildSetOrInfer(loadPikaData(), sp, used)!);
    const desc = describeSources(sourced);
    expect(desc).toMatch(/from usage/);
    expect(desc).toMatch(/Rillaboom/);
  });
});

describe('creatorIntel with the fallback', () => {
  // The regression this whole module exists for: a creator video about the new
  // mons used to fail with "no Pikalytics data for: ...", which made the LEADING
  // indicator useless during precisely the window it was built for.
  test('builds a threat team around species that have no usage', () => {
    const res = buildThreatTeam(
      ['Rillaboom', 'Golisopod', 'Baxcalibur', 'Incineroar', 'Garchomp', 'Gholdengo'],
      'test-creator',
    );
    expect('team' in res, 'error' in res ? res.error : '').toBe(true);
    if (!('team' in res)) return;
    expect(res.team.sets.length).toBeGreaterThanOrEqual(4);
    expect(res.team.provenance).toBeTruthy();
    expect(res.team.provenance).toMatch(/analog|derived/);   // it says so out loud
    // Item clause holds across the built six.
    const items = res.team.sets.map(s => toId(s.item ?? '')).filter(Boolean);
    expect(new Set(items).size).toBe(items.length);
    // At most one mega stone.
    const stoneCount = res.team.sets.filter(s =>
      getMegaOptions(s.species).some(m => toId(m.stone) === toId(s.item ?? ''))).length;
    expect(stoneCount).toBeLessThanOrEqual(1);
  });
});
