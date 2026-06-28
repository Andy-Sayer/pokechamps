// Meta team construction from Pikalytics usage data: real sets, item clause,
// one-mega cap, teammate-correlation fill.
import { describe, test, expect } from 'vitest';
import { loadPikaData, buildSet, composeTeam, metaTeams, baseSpeciesFor } from '../src/domain/metaTeams.js';
import { getItem, toId } from '../src/domain/data.js';

const pika = loadPikaData();

describe('metaTeams', () => {
  test('buildSet produces a complete legal set from usage data', () => {
    const used = new Set<string>();
    const s = buildSet(pika, 'Sneasler', used)!;
    expect(s).toBeTruthy();
    expect(s.species).toBe('Sneasler');
    expect(s.moves).toHaveLength(4);
    expect(s.item).toBeTruthy();
    expect(used.has(toId(s.item!))).toBe(true);
  });

  test('item clause: a second mon falls through to its next item choice', () => {
    const used = new Set<string>();
    const a = buildSet(pika, 'Sneasler', used)!;
    // Force a clash by reserving Sneasler's top item again via a fresh build.
    const b = buildSet(pika, 'Sneasler', used);
    if (b) expect(toId(b.item!)).not.toBe(toId(a.item!));
  });

  test('mega formes resolve to base species + stone', () => {
    // The dex helper maps a mega forme name back to its base species.
    expect(baseSpeciesFor('Charizard-Mega-Y')).toBe('Charizard');
    // Reg M-B keys megas by BASE species in the usage table (e.g. "Charizard"
    // whose top item is Charizardite Y); Reg M-A keyed them by forme name
    // ("Charizard-Mega-Y"). buildSet handles both via baseSpeciesFor — find the
    // first top mon that builds into a mega and assert it resolves to base +
    // stone, independent of which keying the data uses.
    let mega = null as ReturnType<typeof buildSet>;
    let name = '';
    for (const n of pika.topPokemon) {
      const s = buildSet(pika, n, new Set());
      if (s && (getItem(s.item ?? '') as { megaStone?: unknown }).megaStone) { mega = s; name = n; break; }
    }
    expect(mega).toBeTruthy();
    expect(mega!.species).toBe(baseSpeciesFor(name));
  });

  test('composeTeam: 6 mons, unique species, unique items, ≤1 mega stone', () => {
    const sets = composeTeam(pika, [pika.topPokemon[0]!])!;
    expect(sets).toHaveLength(6);
    expect(new Set(sets.map(s => s.species)).size).toBe(6);
    expect(new Set(sets.map(s => toId(s.item ?? ''))).size).toBe(6);
    const megas = sets.filter(s => !!(getItem(s.item ?? '') as { megaStone?: unknown }).megaStone);
    expect(megas.length).toBeLessThanOrEqual(1);
  });

  test('metaTeams returns distinct full teams for top anchors', () => {
    const teams = metaTeams(pika, 3);
    expect(teams.length).toBe(3);
    const keys = teams.map(t => t.sets.map(s => s.species).sort().join('|'));
    expect(new Set(keys).size).toBe(3);
  });
});
