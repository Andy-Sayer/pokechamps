// Champions-sim readiness — locks in the 2026-06-28 discovery that @pkmn/sim
// (0.10.11+) simulates Champions megas NATIVELY (formes + stones + custom
// abilities Eelevate/Fire Mane), so full-game playouts on the exact engine are
// Champions-correct with no local mod. If a future @pkmn/sim bump regresses any
// of this (drops a forme, re-stages an ability), these tests fail loudly — the
// signal to reconcile our data vs upstream. See project_sim_champions_native.
import { describe, test, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBattle, ensureSimLoaded, simHasSpecies, readRoster } from '../src/domain/simBridge.js';
import { megaFormeAbility, MEGA_ABILITY_OVERRIDES } from '../src/domain/gimmicks/mega.js';
import { dataDirPath } from '../src/domain/data.js';
import { Dex } from '@pkmn/dex';

beforeAll(async () => {
  expect(await ensureSimLoaded()).toBe(true);
});

const dex = Dex.forGen(9).includeData();
const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Champions-legal mega formes = every legal item with a megaStone record.
function legalMegaFormes(): string[] {
  const fmt = JSON.parse(readFileSync(join(dataDirPath(), 'format.champions.json'), 'utf8')) as { items: { allow: string[] } };
  const formes = new Set<string>();
  for (const id of fmt.items.allow) {
    const it = dex.items.get(id) as unknown as { megaStone?: Record<string, string> };
    if (it?.megaStone) for (const f of Object.values(it.megaStone)) formes.add(f);
  }
  return [...formes];
}

describe('Champions sim readiness (@pkmn/sim 0.10.11+)', () => {
  test('every Champions-legal mega forme exists in the sim dex', () => {
    const formes = legalMegaFormes();
    expect(formes.length).toBeGreaterThan(60); // ~76 — guards against an empty/short read
    expect(formes.filter(f => !simHasSpecies(f))).toEqual([]);
  });

  // Reg M-C's three Legends Z-A formes were revealed 2026-08-31 — AFTER @pkmn/sim
  // 0.10.11 (still the latest as of 2026-09-05), so the sim carries the MAINLINE
  // mega's ability for them. Our dex-side override is right and the calc path is
  // correct; only the /exact sim oracle is stale for these three. Delete an entry
  // here the moment upstream ships it — the second test below is the tripwire.
  // Documented in docs/notes/sim-divergences.md.
  const PENDING_UPSTREAM: Record<string, string> = {
    'Absol-Mega-Z': 'Magic Bounce',
    'Garchomp-Mega-Z': 'Sand Force',
    'Lucario-Mega-Z': 'Adaptability',
  };
  const simAbility = () => {
    const battle = buildBattle({
      p1team: [{ species: 'Garchomp', moves: ['Earthquake'], level: 50 }, { species: 'Dragonite', moves: ['Outrage'], level: 50 }],
      p2team: [{ species: 'Talonflame', moves: ['Brave Bird'], level: 50 }, { species: 'Sableye', moves: ['Knock Off'], level: 50 }],
      p1active: [0, 1], p2active: [0, 1],
    });
    const dx = (battle as unknown as { dex: { species: { get(n: string): { abilities?: Record<string, string> } } } }).dex;
    return (forme: string) => dx.species.get(forme)?.abilities?.['0'];
  };

  test('custom mega formes carry the correct Champions ability', () => {
    const get = simAbility();
    for (const forme of Object.keys(MEGA_ABILITY_OVERRIDES)) {
      if (forme in PENDING_UPSTREAM) continue;
      expect(norm(get(forme)), `${forme} sim ability vs our verified override`).toBe(norm(megaFormeAbility(forme)));
    }
  });

  test('the M-C Z-mega abilities are STILL missing upstream (drop them here when they land)', () => {
    const get = simAbility();
    for (const [forme, stale] of Object.entries(PENDING_UPSTREAM)) {
      // Sanity: our side is patched...
      expect(norm(megaFormeAbility(forme))).not.toBe(norm(stale));
      // ...and the sim still isn't. When this flips, remove the entry above so the
      // main assertion covers the forme again.
      expect(norm(get(forme)), `${forme}: upstream may have shipped the real ability`).toBe(norm(stale));
    }
  });

  test('mega evolution actually performs (Dragonite + Dragoninite -> Dragonite-Mega)', () => {
    const battle = buildBattle({
      p1team: [
        { species: 'Dragonite', item: 'Dragoninite', ability: 'Multiscale', moves: ['Dragon Claw', 'Earthquake', 'Roost', 'Protect'], level: 50 },
        { species: 'Garchomp', ability: 'Rough Skin', moves: ['Dragon Claw', 'Earthquake', 'Protect', 'Stone Edge'], level: 50 },
      ],
      p2team: [
        { species: 'Talonflame', moves: ['Brave Bird', 'Protect'], level: 50 },
        { species: 'Sableye', moves: ['Knock Off', 'Protect'], level: 50 },
      ],
      p1active: [0, 1], p2active: [0, 1], seed: [1, 2, 3, 4],
    });
    battle.makeChoices('move 1 1 mega, move 1 1', 'default'); // both leads' move 1 = Dragon Claw (single-target)
    expect(readRoster(battle).p1.some(m => m.species === 'Dragonite-Mega')).toBe(true);
  });
});
