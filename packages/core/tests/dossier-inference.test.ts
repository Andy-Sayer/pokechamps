// The dossier's INFERRED movesets are what bring-picking reasons about for any
// mon with no usage data — which, for the first weeks after a regulation
// rotation, is most of the new field. Three classes of defect were fixed
// 2026-09-05 while prepping Reg M-C; these pin all three.
//
//   1. ability biases were ignored, so a mon's signature move could be missing
//      entirely (Aerilate Salamence had no Double-Edge; No Guard Raichu-Y had no
//      Zap Cannon; Sharpness Absol-Z had no Night Slash);
//   2. utilities flooded the set — Lucario-Mega-Z came out as SIX setup moves
//      and one attack, and Salamence-Mega ran Rest + Roost + Wish together;
//   3. a mega inherited its BASE species' usage moves even when it plays the
//      other way round (Garchomp-Mega-Z, a 141 SpA Levitating mono-Dragon, was
//      given physical Garchomp's Earthquake / Rock Slide).
import { describe, test, expect, beforeAll } from 'vitest';
import { buildDossier, type DossierEntry } from '../src/domain/monDossier.js';

let dossier: DossierEntry[];
const of = (label: string) => {
  const e = dossier.find(d => d.label === label);
  expect(e, `${label} missing from the dossier`).toBeDefined();
  return e!;
};

beforeAll(() => { dossier = buildDossier(); });

describe('ability biases reach the inferred set', () => {
  test('Aerilate: Salamence-Mega runs its retyped Normal moves', () => {
    // Double-Edge/Hyper Voice become Flying STAB — the generic Normal-coverage
    // penalty used to bury both, leaving the mega with no signature move.
    const moves = of('Salamence-Mega').moves;
    expect(moves).toContain('doubleedge');
    expect(moves).toContain('hypervoice');
  });

  test('No Guard: Raichu-Mega-Y runs the moves the ability makes reliable', () => {
    const moves = of('Raichu-Mega-Y').moves;
    expect(moves).toContain('zapcannon');   // 50% accurate without No Guard
    expect(moves).toContain('focusblast');
  });

  test('Sharpness: Absol-Mega-Z prefers slicing moves', () => {
    expect(of('Absol-Mega-Z').moves).toContain('nightslash');
  });

  test('Grassy Surge: Rillaboom keeps Grassy Glide alongside its power move', () => {
    // Both are Grass/Physical, so the type+category dedup used to collapse them
    // into Wood Hammer and throw away the priority that defines the mon.
    const moves = of('Rillaboom').moves;
    expect(moves).toContain('grassyglide');
    expect(moves).toContain('woodhammer');
  });

  test('Drizzle: Pelipper leans on its rain-boosted STAB', () => {
    expect(of('Pelipper').moves).toContain('weatherball');
  });
});

describe('sets are composed like real sets', () => {
  const RECOVERY = ['recover', 'roost', 'softboiled', 'moonlight', 'morningsun', 'synthesis', 'slackoff', 'wish', 'strengthsap', 'rest', 'lifedew', 'junglehealing'];
  const SETUP = ['swordsdance', 'nastyplot', 'dragondance', 'calmmind', 'quiverdance', 'bulkup', 'shellsmash', 'tailglow', 'irondefense', 'victorydance', 'agility'];

  test('no inferred set stacks recovery or setup moves', () => {
    for (const e of dossier) {
      if (e.moveSource !== 'inferred') continue;
      const recoveries = e.moves.filter(m => RECOVERY.includes(m));
      const setups = e.moves.filter(m => SETUP.includes(m));
      expect(recoveries.length, `${e.label}: ${recoveries.join('+')}`).toBeLessThanOrEqual(1);
      expect(setups.length, `${e.label}: ${setups.join('+')}`).toBeLessThanOrEqual(1);
    }
  });

  test('every inferred attacker keeps room for actual attacks', () => {
    const statusish = new Set([...RECOVERY, ...SETUP, 'protect', 'detect', 'tailwind', 'trickroom',
      'lightscreen', 'reflect', 'auroraveil', 'followme', 'ragepowder', 'helpinghand', 'wideguard',
      'quickguard', 'taunt', 'encore', 'willowisp', 'thunderwave', 'yawn', 'haze', 'charm',
      'raindance', 'sunnyday', 'snowscape', 'sandstorm', 'chillyreception', 'scaryface', 'teleport']);
    for (const e of dossier) {
      if (e.moveSource !== 'inferred' || e.supportLean) continue;
      const attacks = e.moves.filter(m => !statusish.has(m));
      expect(attacks.length, `${e.label} has only ${attacks.length} attacks: ${e.moves.join(', ')}`).toBeGreaterThanOrEqual(2);
    }
  });

  test('Rest never takes the recovery slot from an instant heal', () => {
    const sal = of('Salamence-Mega').moves;
    expect(sal).toContain('roost');
    expect(sal).not.toContain('rest');
  });
});

describe('a mega only inherits usage that describes how IT plays', () => {
  test('Garchomp-Mega-Z is inferred, not physical Garchomp usage', () => {
    const z = of('Garchomp-Mega-Z');
    expect(z.moveSource).toBe('inferred');
    expect(z.moves).toContain('dracometeor');
    // Base Garchomp's usage set — must not leak onto the special mega forme.
    expect(z.moves).not.toContain('rockslide');
  });

  test('base Garchomp still uses its real usage moves', () => {
    const base = of('Garchomp');
    expect(base.moveSource).toBe('usage');
    expect(base.moves).toContain('earthquake');
  });

  test('a mega that plays like its base KEEPS the usage moves', () => {
    // Charizard-Mega-Y is the special attacker Charizard's usage describes.
    expect(of('Charizard-Mega-Y').moveSource).toBe('usage');
  });
});

describe('the Reg M-C additions are all covered', () => {
  test.each([
    'Rillaboom', 'Salamence', 'Golisopod', 'Baxcalibur',
    'Salamence-Mega', 'Golisopod-Mega', 'Baxcalibur-Mega',
    'Absol-Mega-Z', 'Garchomp-Mega-Z', 'Lucario-Mega-Z',
  ])('%s has a dossier entry with moves', label => {
    const e = of(label);
    expect(e.moves.length).toBeGreaterThan(2);
    expect(e.baseStats.hp).toBeGreaterThan(0);
  });
});
