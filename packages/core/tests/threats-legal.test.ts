// The hand-built gauntlet must consist of teams that could actually be BROUGHT.
// This started as a real defect: eight M-B threat sets carried Assault Vest /
// Choice Band / Choice Specs / Safety Goggles, none of which are legal in
// Champions Reg M (73 non-stone items; Choice Scarf is the only Choice item).
// The gauntlet was therefore scoring our team against opponents that cannot
// exist — and that were stronger than the real thing. Fixed 2026-09-05; this
// test keeps it fixed for every future regulation.
import { describe, test, expect } from 'vitest';
import { MB_THREATS } from '../src/scripts/mbThreats.js';
import { MC_THREATS, ALL_THREATS } from '../src/scripts/mcThreats.js';
import { isLegalSpecies, isLegalItem, getLearnset, getSpecies, toId } from '../src/domain/data.js';
import type { PokemonSet } from '../src/domain/types.js';

const pools: Array<[string, { anchor: string; sets: PokemonSet[] }[]]> = [
  ['MB_THREATS', MB_THREATS],
  ['MC_THREATS', MC_THREATS],
];

describe.each(pools)('%s — every hand-built threat team is bringable', (_name, pool) => {
  test('the pool is non-empty (guards against a bad import)', () => {
    expect(pool.length).toBeGreaterThan(0);
  });

  test.each(pool.map(t => [t.anchor, t] as const))('%s', (_anchor, team) => {
    const items = new Set<string>();
    const species = new Set<string>();
    let megas = 0;
    for (const s of team.sets) {
      expect(isLegalSpecies(s.species), `${s.species} is not a legal species`).toBe(true);

      if (s.item) {
        expect(isLegalItem(s.item), `${s.species}'s ${s.item} is not a legal item`).toBe(true);
        // Item Clause: no two mons on a team hold the same item.
        expect(items.has(toId(s.item)), `item clause: ${s.item} held twice`).toBe(false);
        items.add(toId(s.item));
      }

      // Species Clause.
      expect(species.has(toId(s.species)), `species clause: ${s.species} twice`).toBe(false);
      species.add(toId(s.species));

      const learnset = new Set(getLearnset(s.species).map(toId));
      for (const move of s.moves) {
        expect(learnset.has(toId(move)), `${s.species} can't learn ${move}`).toBe(true);
      }

      const abilities = Object.values((getSpecies(s.species) as { abilities?: Record<string, string> } | undefined)?.abilities ?? {})
        .map(a => toId(a));
      expect(abilities, `${s.species} can't have ${s.ability}`).toContain(toId(s.ability));

      const evTotal = Object.values(s.evs ?? {}).reduce((a, b) => a + (b ?? 0), 0);
      expect(evTotal, `${s.species} spends ${evTotal} EVs`).toBeLessThanOrEqual(508);

      if (s.item && /ite$|ite [XYZ]$|nite|drite|rite$/i.test(s.item)) megas++;
    }
    // One mega stone per team — more than one is legal to HOLD, but these teams
    // are meant to read as a single-mega gameplan.
    expect(megas, `${team.anchor} carries ${megas} mega stones`).toBeLessThanOrEqual(1);
  });
});

describe('ALL_THREATS — the combined Reg M-C gauntlet', () => {
  test('is M-B plus M-C with no drops', () => {
    expect(ALL_THREATS.length).toBe(MB_THREATS.length + MC_THREATS.length);
  });

  test('covers all six new M-C megas plus Rillaboom', () => {
    const stones = new Set(ALL_THREATS.flatMap(t => t.sets.map(s => toId(s.item ?? ''))));
    for (const stone of ['salamencite', 'lucarionitez', 'garchompitez', 'absolitez', 'baxcalibrite', 'golisopite']) {
      expect(stones.has(stone), `no threat team runs ${stone}`).toBe(true);
    }
    const mons = new Set(ALL_THREATS.flatMap(t => t.sets.map(s => toId(s.species))));
    expect(mons.has('rillaboom')).toBe(true);
  });

  test('every anchor is uniquely named (the report keys on it)', () => {
    const anchors = ALL_THREATS.map(t => t.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
  });
});
