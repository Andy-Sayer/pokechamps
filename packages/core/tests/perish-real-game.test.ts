// The perish trap AS IT ACTUALLY HAPPENED (2026-07-28), reconstructed from
// matches/1785221959416.json + the vision banner log.
//
// This exists because the first analysis modelled a board that never existed —
// Blastoise as a Mean Look trapper, Incineroar's Intimidate on the field, no
// Destiny Bond, one song instead of two, and a Kingambit that was not brought.
// The corrected picture changes the answer, so it is pinned rather than narrated.
import { describe, test, expect, beforeAll } from 'vitest';
import { ensureSimLoaded } from '../src/domain/simBridge.js';
import { probeRealGame, type RealFinding } from '../src/scripts/perish-real-game.js';

let findings: RealFinding[];
beforeAll(async () => {
  expect(await ensureSimLoaded()).toBe(true);
  findings = await probeRealGame();
}, 120_000);

const find = (fragment: string): RealFinding => {
  const hit = findings.find(f => f.headline.includes(fragment));
  if (!hit) throw new Error(`no finding matching ${JSON.stringify(fragment)}`);
  return hit;
};

describe('the real 2026-07-28 perish game', () => {
  test('every expectation holds against the real engine', () => {
    expect(findings.filter(f => !f.ok).map(f => `${f.headline} -> ${f.detail}`)).toEqual([]);
    expect(findings.length).toBeGreaterThanOrEqual(11);
  });

  test.each([
    ['ONLY the Scarf Garchomp outruns Mega Gengar'],
    ['Blastoise Fake Out flinches Garchomp'],
    ['no Intimidate in play, Earthquake OHKOs'],
    ['outspeeds the Destiny Bond'],
    ['T3 switch out — nobody dies'],
    ['Switching on the song turn does NOT dodge it'],
    ['a T2 Protect blanks the Earthquake'],
    ['When they withdraw the Gengar, the door opens'],
    ['Protect T2, Protect T3, withdraw T4'],
    ['A Protect BLOCKS the U-turn escape'],
    ['BETTER LEAD'],
  ])('%s', (fragment) => {
    const f = find(fragment);
    expect(f.ok, `${f.headline}\n  engine said: ${f.detail}`).toBe(true);
  });
});
