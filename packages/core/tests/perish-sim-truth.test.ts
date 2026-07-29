// Ground-truth check on the perish-trap advisory, resolved through the REAL
// Showdown engine (@pkmn/sim) rather than through our own model.
//
// WHY THIS EXISTS. `perishTrap.ts` tells the player what to do in a losing
// position, and it was written from mechanics reasoning plus one live game — the
// evidence mix that produces confident, wrong advice. Its "KO the trapper" out
// was already wrong once in exactly that way. Every escape route it names is a
// falsifiable claim about the engine, so each one is resolved here for real.
//
// The scenarios live in `scripts/perish-sim-probe.ts` and are imported rather
// than duplicated, so the human-readable report and this regression can never
// drift apart. Run the narrative version with:
//   npx tsx packages/core/src/scripts/perish-sim-probe.ts
import { describe, test, expect, beforeAll } from 'vitest';
import { ensureSimLoaded } from '../src/domain/simBridge.js';
import { probePerishTruth, type PerishClaim } from '../src/scripts/perish-sim-probe.js';

let claims: PerishClaim[];

beforeAll(async () => {
  // @pkmn/sim is an optional dep loaded lazily; the dev install has it.
  expect(await ensureSimLoaded()).toBe(true);
  claims = await probePerishTruth();
}, 60_000);

const claimFor = (fragment: string): PerishClaim => {
  const hit = claims.find(c => c.claim.includes(fragment));
  if (!hit) throw new Error(`no claim matching ${JSON.stringify(fragment)} — the probe's wording changed`);
  return hit;
};

describe('perish trap: the advisory checked against the real engine', () => {
  test('every claim the advisory makes holds', () => {
    const refuted = claims.filter(c => !c.ok);
    expect(refuted.map(c => `${c.claim} -> ${c.detail}`)).toEqual([]);
    expect(claims.length).toBeGreaterThanOrEqual(9);
  });

  // Named individually so a failure says WHICH mechanic the advice is wrong about,
  // not just "the probe failed".
  test.each([
    ['Mega Gengar has Shadow Tag', 'the base forme shows Cursed Body, so reading `ability` alone misses the trap'],
    ['3-turn clock', 'the clock really does kill, so the urgency in the headline is honest'],
    ['Switching out CLEARS', 'why the trapping side wins the race: only they can rotate'],
    ['U-turn escapes', 'the advisory\'s PRIMARY out — a pivot beats the trap and clears the count'],
    ['Baton Pass', 'escapes but PASSES the count, which is why it is surfaced as an explicit reject'],
    ['Shed Shell and Ghost', 'the only two passive escapes'],
    ['KOing the move-trapper', 'the user\'s correction: the KO frees me but hands them the slot'],
    ['returning Gengar re-applies', 'so a relief KO is not an escape while another trapper lives'],
    ['Taunting the singer', 'denial beats escape — the armed-phase counter'],
  ])('%s', (fragment) => {
    const c = claimFor(fragment as string);
    expect(c.ok, `${c.claim}\n  engine said: ${c.detail}`).toBe(true);
  });
});
