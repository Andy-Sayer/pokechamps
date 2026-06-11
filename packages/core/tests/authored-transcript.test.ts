// J.6 — authored Champions transcripts: full-fidelity battles with KNOWN
// spreads, exercised end-to-end through the replay pipeline. With EVs/nature
// in the packed team, the J.3 check collapses to STRICT containment — any
// miss means the pipeline mangled something (EVs, the mega forme, field,
// spread modifier), since the expected numbers were computed with the same
// calc the checker uses. The mega activation covers the Champions-specific
// forme path real gen9 replays never reach.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReplayLog } from '../src/domain/showdownReplay.js';
import { ingestTranscript } from '../src/domain/replayDriver.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'replays', 'authored-champions-1.log');
const log = readFileSync(FIXTURE, 'utf8');

describe('J.6 — authored Champions transcript', () => {
  const t = parseReplayLog(log);

  test('packed teams carry the full spreads', () => {
    const zard = t.teams.p1.find(m => m.species === 'Charizard')!;
    expect(zard.nature).toBe('Modest');
    expect(zard.evs).toEqual({ hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 });
    expect(zard.item).toBe('Charizardite Y');
    const zong = t.teams.p2.find(m => m.species === 'Bronzong')!;
    expect(zong.evs?.spd).toBe(124);
    expect(zong.nature).toBe('Sassy');
  });

  test('strict containment: every hit in, envelopes collapsed to roll width', () => {
    const r = ingestTranscript(t);
    expect(r.flags).toEqual([]);
    const out = r.damage.filter(d => d.verdict === 'out');
    expect(out).toEqual([]);
    // Known spreads on both sides → the envelope is just the 16-roll band,
    // an order of magnitude tighter than the reachability envelopes.
    const nonKo = r.damage.filter(d => d.verdict === 'in' && !d.faintTruncated);
    expect(nonKo.length).toBeGreaterThanOrEqual(5);
    for (const d of nonKo) {
      // The 16-roll band is ~16-18% of the mid; reachability envelopes span
      // 3-10× the mid. Relative width proves strict mode engaged.
      const rel = (d.maxPct - d.minPct) / ((d.maxPct + d.minPct) / 2);
      expect(rel).toBeLessThan(0.25);
    }
  });

  test('the mega path is exercised: post-mega hits price the Mega-Y forme', () => {
    const r = ingestTranscript(t);
    // Heat Wave in sun off Mega-Y's 159 SpA vs Heatproof AV Bronzong: the
    // strict band must contain the authored roll (34-41% of 174 HP).
    const hw = r.damage.find(d => d.move === 'Heat Wave' && d.defender === 'Bronzong')!;
    expect(hw.verdict).toBe('in');
    expect(hw.attacker).toBe('Charizard-Mega-Y');
    // A base-forme Charizard (lower SpA, no sun) could NOT produce this band:
    // tamper-check by re-ingesting with the mega event stripped — the same
    // observed damage must fall OUT of the stricter base-forme band.
    const noMega = parseReplayLog(log.split('\n').filter(l => !l.startsWith('|detailschange|') && !l.startsWith('|-weather|SunnyDay|[from]')).join('\n'));
    const r2 = ingestTranscript(noMega);
    const hw2 = r2.damage.find(d => d.move === 'Heat Wave' && d.defender === 'Bronzong')!;
    expect(hw2.verdict).toBe('out');
  });

  test('tampered EVs break containment (the strict check has teeth)', () => {
    // Quarter the attacker's SpA investment in the packed team: the authored
    // damage numbers are no longer reachable by the "known" spread.
    const tampered = parseReplayLog(log.replace('|Modest|4,0,0,252,0,252|', '|Modest|4,0,0,0,0,252|'));
    const r = ingestTranscript(tampered);
    expect(r.damage.some(d => d.verdict === 'out')).toBe(true);
  });
});
