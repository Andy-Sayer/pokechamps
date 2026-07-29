// The perish-trap counter-play for the ACTUAL team (TalonFlameAndyBoy), resolved
// through the real Showdown engine rather than through our own model.
//
// WHY A TEAM-SPECIFIC TEST. The generic advisory in `perishTrap.ts` lists escapes:
// pivot out, Shed Shell, Ghost typing, Taunt the singer. Run against this roster
// almost none of them exist — one pivot (Meowscarada's U-turn), no Shed Shell, no
// Ghost, no Taunt, no Soundproof. Five of six mons cannot leave a Shadow Tag. So
// the counter here is DENIAL, not escape, and the denial lines have to be checked
// against the real engine with the real spreads before they are advice.
//
// These assertions are load-bearing on the team file: change a set and a broken
// expectation here is the point, not a nuisance. Run the readable report with
//   npx tsx packages/core/src/scripts/talonflame-perish-counter.ts
import { describe, test, expect, beforeAll } from 'vitest';
import { ensureSimLoaded } from '../src/domain/simBridge.js';
import { probeTalonflameCounters, type CounterFinding } from '../src/scripts/talonflame-perish-counter.js';

let findings: CounterFinding[];

beforeAll(async () => {
  expect(await ensureSimLoaded()).toBe(true);
  findings = await probeTalonflameCounters();
}, 120_000);

const find = (fragment: string): CounterFinding => {
  const hit = findings.find(f => f.headline.includes(fragment));
  if (!hit) throw new Error(`no finding matching ${JSON.stringify(fragment)} — the probe's wording changed`);
  return hit;
};

describe('TalonFlameAndyBoy vs a perish trap', () => {
  test('every counter-play expectation holds against the real engine', () => {
    expect(findings.filter(f => !f.ok).map(f => `${f.headline} -> ${f.detail}`)).toEqual([]);
    expect(findings.length).toBeGreaterThanOrEqual(11);
  });

  test.each([
    ['Mega Gengar outspeeds the team by a hair'],
    ['Gale Wings Acrobatics resolves BEFORE Perish Song'],
    ['Acrobatics + Knock Off together KO the singer'],
    ['Acrobatics ALONE does not KO'],
    ['Knock Off CANNOT remove Gengarite'],
    ['Sucker Punch FAILS against Perish Song'],
    ['Under Tailwind, Meowscarada moves before Mega Gengar'],
    ['double-up is a RELIABLE kill'],
    ['Scarf Garchomp Earthquake OHKOs Mega Gengar'],
    ['Meowscarada U-turn IS a real escape'],
    ['Scarf Garchomp has NO out'],
  ])('%s', (fragment) => {
    const f = find(fragment);
    expect(f.ok, `${f.headline}\n  engine said: ${f.detail}`).toBe(true);
  });
});
