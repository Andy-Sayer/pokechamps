// MEGA_ABILITY_OVERRIDES is the SINGLE source of truth for every mega forme's
// Champions ability. refresh-data derives data/species.json's patches from it,
// the domain reads it through megaFormeAbility(), and the calc/search follow.
//
// Before 2026-09-07 the same pins were hand-maintained in TWO unlinked tables
// (this one and refresh-data's SPECIES_PATCHES). Pinning an ability in one and
// not the other left them silently disagreeing, which is exactly the mistake a
// regulation switch-day invites. These tests pin the invariant.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSpecies, dataDirPath, toId } from '../src/domain/data.js';
import { MEGA_ABILITY_OVERRIDES, MEGA_ABILITY_UNREVEALED, megaFormeAbility } from '../src/domain/gimmicks/mega.js';

describe('mega ability table', () => {
  test('every override is materialized in data/species.json', () => {
    // i.e. someone pinned an ability and remembered to run `npm run refresh-data`.
    const drift = Object.entries(MEGA_ABILITY_OVERRIDES)
      .map(([forme, ability]) => ({ forme, ability, dumped: (getSpecies(forme) as any)?.abilities?.['0'] }))
      .filter(d => toId(d.ability) !== toId(d.dumped ?? ''));
    expect(drift, `run \`npm run refresh-data\`: ${JSON.stringify(drift)}`).toEqual([]);
  });

  test('megaFormeAbility returns the override for every pinned forme', () => {
    for (const [forme, ability] of Object.entries(MEGA_ABILITY_OVERRIDES)) {
      expect(megaFormeAbility(forme), forme).toBe(ability);
    }
  });

  test('refresh-data derives its mega patches rather than hand-listing them', () => {
    // Guards the regression directly: a second hand-maintained mega table.
    const src = readFileSync(join(dataDirPath(), '..', 'packages', 'core', 'src', 'scripts', 'refresh-data.ts'), 'utf8');
    expect(src).toContain('MEGA_ABILITY_OVERRIDES');
    const extra = src.slice(src.indexOf('const EXTRA_SPECIES_PATCHES'), src.indexOf('const megaIdOf'));
    expect(extra, 'no mega forme may be pinned in EXTRA_SPECIES_PATCHES').not.toMatch(/mega[xyz]?:/i);
  });

  test('unrevealed formes are not also pinned as known', () => {
    for (const forme of MEGA_ABILITY_UNREVEALED) {
      expect(MEGA_ABILITY_OVERRIDES[forme], `${forme} is both pinned and marked unrevealed`).toBeUndefined();
    }
  });

  test('the M-C unrevealed set is exactly what we are still waiting on', () => {
    // Golisopod/Baxcalibur drop out when Champions publishes them (Sept 8 2026);
    // Heatran-Mega is armed ahead of a possible roster add (teased 2026-08-31).
    expect([...MEGA_ABILITY_UNREVEALED].sort())
      .toEqual(['Baxcalibur-Mega', 'Golisopod-Mega', 'Heatran-Mega']);
  });
});
