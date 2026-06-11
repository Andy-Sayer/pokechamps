// J.3 damage consistency: every observed replay hit must be REACHABLE by some
// legal spread given the known items/abilities and transcript-truth state
// (boosts / status / weather / screens / Helping Hand / crit / curHP-scaled BP
// / Glaive Rush vulnerability). `out` = our damage model is missing something.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDamageEvent, type DamageCheckInput } from '../src/domain/replayDamageCheck.js';
import { parseReplayLog } from '../src/domain/showdownReplay.js';
import { ingestTranscript } from '../src/domain/replayDriver.js';
import { NEUTRAL_FIELD } from '../src/domain/types.js';

const fixture = (name: string) =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'replays', name), 'utf8');

function input(over: Partial<DamageCheckInput> = {}): DamageCheckInput {
  return {
    turn: 1, move: 'Tackle',
    field: { ...NEUTRAL_FIELD },
    attacker: { species: 'Pikachu', level: 50, item: '', ability: 'Static', moves: ['Tackle'] },
    defender: { species: 'Blissey', level: 50, item: '', ability: 'Natural Cure', moves: [] },
    beforePct: 100, afterPct: 95, fainted: false,
    ...over,
  };
}

describe('checkDamageEvent (unit)', () => {
  test('a plausible hit is in', () => {
    const r = checkDamageEvent(input());
    expect(r.verdict).toBe('in');
    expect(r.observedPct).toBe(5);
    expect(r.minPct).toBeLessThanOrEqual(5);
  });

  test('impossible damage is out with a directional note', () => {
    // Pikachu Tackle cannot take 90% off a Blissey under any investment.
    const r = checkDamageEvent(input({ afterPct: 10 }));
    expect(r.verdict).toBe('out');
    expect(r.note).toMatch(/> max reachable/);
  });

  test('implausibly LOW damage is out the other way', () => {
    // Even 0-IV negative-nature Iron Hands Close Combat onto max-bulk Blissey
    // (frail special wall) far exceeds 1%.
    const r = checkDamageEvent(input({
      move: 'Close Combat',
      attacker: { species: 'Iron Hands', level: 50, item: '', ability: 'Quark Drive', moves: ['Close Combat'] },
      afterPct: 99,
    }));
    expect(r.verdict).toBe('out');
    expect(r.note).toMatch(/< min reachable/);
  });

  test('a faint-truncated KO only requires the kill to be reachable', () => {
    const r = checkDamageEvent(input({
      move: 'Close Combat',
      attacker: { species: 'Iron Hands', level: 50, item: '', ability: 'Quark Drive', moves: ['Close Combat'] },
      beforePct: 20, afterPct: 0, fainted: true,
    }));
    expect(r.verdict).toBe('in');
    expect(r.faintTruncated).toBe(true);
  });

  test('Glaive Rush vulnerability doubles the envelope', () => {
    const base = checkDamageEvent(input());
    const doubled = checkDamageEvent(input({
      defender: { ...input().defender, doubleDamageTaken: true },
    }));
    expect(doubled.maxPct).toBeCloseTo(base.maxPct * 2, 5);
    expect(doubled.minPct).toBeCloseTo(base.minPct * 2, 5);
  });

  test('state-dependent moves and tera are honestly skipped', () => {
    expect(checkDamageEvent(input({ move: 'Gyro Ball' })).verdict).toBe('skipped');
    expect(checkDamageEvent(input({ move: 'Rage Fist' })).verdict).toBe('skipped');
    expect(checkDamageEvent(input({ attacker: { ...input().attacker, tera: true } })).verdict).toBe('skipped');
  });

  test('transcript-truth boosts scale the envelope (+4 Atk ≈ ×3)', () => {
    const base = checkDamageEvent(input());
    const boosted = checkDamageEvent(input({ attacker: { ...input().attacker, boosts: { atk: 4 } } }));
    expect(boosted.maxPct / base.maxPct).toBeGreaterThan(2.7);
    expect(boosted.maxPct / base.maxPct).toBeLessThan(3.3);
  });
});

describe('J.3 on the real fixtures', () => {
  test('the Reg F game: every hit in, Glaive Rush ×2 modelled, tera skipped', () => {
    const r = ingestTranscript(parseReplayLog(fixture('gen9vgc2026regfbo3-2573268519.log')));
    const out = r.damage.filter(d => d.verdict === 'out');
    expect(out).toEqual([]);
    // The Eruption into a Glaive-Rush-vulnerable Baxcalibur (98% observed) is
    // only reachable through the ×2 envelope — the catch that drove the model.
    const vuln = r.damage.find(d => d.move === 'Eruption' && d.defender === 'Baxcalibur' && d.turn === 2)!;
    expect(vuln.verdict).toBe('in');
    expect(vuln.maxPct).toBeGreaterThan(100);
    expect(r.damage.some(d => d.verdict === 'skipped' && /terastallized/.test(d.note ?? ''))).toBe(true);
  });

  test('team-preview forme wildcards fold into one entry (Urshifu-*)', () => {
    const t = parseReplayLog(fixture('gen9vgc2026regfbo3-2573267871.log'));
    expect(t.teams.p2).toHaveLength(6);
    expect(t.teams.p2.some(m => m.species.endsWith('-*'))).toBe(false);
  });
});
