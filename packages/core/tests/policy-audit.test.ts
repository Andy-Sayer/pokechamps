import { describe, test, expect } from 'vitest';
import { material, candidatePlays } from '../src/domain/policyAudit.js';
import type { OracleSuccess } from '../src/domain/simOracle.js';

const mon = (side: 'mine' | 'opp', species: string, hpMean: number, faintRate = 0): OracleSuccess['mons'][number] =>
  ({ side, species, beforeHpPct: 100, hpMin: hpMean, hpMax: hpMean, hpMean, faintRate, statusRates: {} });

describe('policyAudit.material', () => {
  test('even board → 0', () => {
    const r: OracleSuccess = { ok: true, seeds: 1, myChoice: '', oppChoice: '', fieldNotes: [], mons: [mon('mine', 'A', 100), mon('opp', 'B', 100)] };
    expect(material(r)).toBe(0);
  });

  test('opp at 50% vs mine full → +50', () => {
    const r: OracleSuccess = { ok: true, seeds: 1, myChoice: '', oppChoice: '', fieldNotes: [], mons: [mon('mine', 'A', 100), mon('opp', 'B', 50)] };
    expect(material(r)).toBe(50);
  });

  test('opp faint adds the tempo bonus on top of the HP loss', () => {
    const r: OracleSuccess = { ok: true, seeds: 1, myChoice: '', oppChoice: '', fieldNotes: [], mons: [mon('mine', 'A', 100), mon('opp', 'B', 0, 1)] };
    expect(material(r)).toBe(100 /* hp gone */ + 50 /* tempo */);
  });
});

describe('policyAudit.candidatePlays', () => {
  const foes = ['Pelipper', 'Archaludon'];
  test('spread move → one play; single-target → one per live foe; self → one', () => {
    const plays = candidatePlays('Garchomp', ['Earthquake', 'Protect', 'Dragon Claw'], foes, 'Dragonite');
    const eq = plays.filter(p => p.move === 'Earthquake');
    expect(eq).toHaveLength(1);
    expect(eq[0]!.spread).toBe(true);
    expect(plays.filter(p => p.move === 'Protect')).toHaveLength(1);
    expect(plays.filter(p => p.move === 'Protect')[0]!.self).toBe(true);
    expect(plays.filter(p => p.move === 'Dragon Claw').map(p => p.targetSpecies).sort()).toEqual(['Archaludon', 'Pelipper']);
  });

  test('deduplicates repeated moves', () => {
    const plays = candidatePlays('X', ['Protect', 'Protect'], foes, '');
    expect(plays.filter(p => p.move === 'Protect')).toHaveLength(1);
  });
});
