// The perish trap behind a FAKE OUT lead, resolved through the real Showdown engine.
//
// The turn-1 answer (Scarf Garchomp Earthquake) has two independent failure modes, and
// the standard Fake Out lead — Incineroar — brings BOTH:
//   • Fake Out (+3) stops the Earthquake HAPPENING. It beats the Choice Scarf and Gale
//     Wings alike, and this Garchomp has no Protect with which to refuse the flinch.
//   • Intimidate stops the Earthquake KILLING. At -1 it is a near-kill (1/16), which is
//     the worst possible shape: it looks like the answer until the singer survives on 12%.
//
// Scenarios live in scripts/perish-fakeout.ts and are imported, not duplicated.
//   npx tsx packages/core/src/scripts/perish-fakeout.ts
import { describe, test, expect, beforeAll } from 'vitest';
import { ensureSimLoaded } from '../src/domain/simBridge.js';
import { probeFakeOut, type FakeOutFinding } from '../src/scripts/perish-fakeout.js';

let findings: FakeOutFinding[];
beforeAll(async () => {
  expect(await ensureSimLoaded()).toBe(true);
  findings = await probeFakeOut();
}, 120_000);

const find = (fragment: string): FakeOutFinding => {
  const hit = findings.find(f => f.headline.includes(fragment));
  if (!hit) throw new Error(`no finding matching ${JSON.stringify(fragment)}`);
  return hit;
};

describe('perish trap behind a Fake Out lead', () => {
  test('every expectation holds against the real engine', () => {
    expect(findings.filter(f => !f.ok).map(f => `${f.headline} -> ${f.detail}`)).toEqual([]);
    expect(findings.length).toBeGreaterThanOrEqual(10);
  });

  test.each([
    ['Fake Out (+3) flinches Garchomp'],
    ['Garchomp has NO Protect'],
    ['Intimidate breaks the solo Earthquake'],
    ['FIX A — Earthquake + Acrobatics'],
    ['FIX B — Kingambit OHKOs it ALONE'],
    ['THE ADAPTED PLAN'],
    ['exactly TWO turns of slack'],
    ['Sucker Punch does NOT beat Fake Out'],
    ['A T2 Protect does not beat the plan'],
    ['Talonflame alone cannot stop the song'],
  ])('%s', (fragment) => {
    const f = find(fragment);
    expect(f.ok, `${f.headline}\n  engine said: ${f.detail}`).toBe(true);
  });
});
