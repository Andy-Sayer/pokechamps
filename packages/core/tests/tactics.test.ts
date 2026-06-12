// Multi-part tactic detection: pattern detectors over actual sets (bring
// synergy), potential learnset profiles (opponent threats / catalog), and the
// hybrid battle-time opponent profile (reveals narrow the threat space).
import { describe, test, expect } from 'vitest';
import {
  detectTactics, profileFromSet, profileFromSpecies, profileFromOpponentEntry,
  profileFromMegaStone, tacticLabel,
} from '../src/domain/tactics.js';
import { scoreBrings } from '../src/domain/bring.js';
import type { PokemonSet, OpponentEntry } from '../src/domain/types.js';
import { ZERO_EVS, MAX_IVS } from '../src/domain/types.js';

function mon(p: Partial<PokemonSet> & { species: string; moves: string[] }): PokemonSet {
  return { level: 50, nature: 'Hardy', evs: { ...ZERO_EVS }, ivs: MAX_IVS, ...p };
}

describe('detectTactics — actual sets', () => {
  test('perish trap pair: singer + trapping move', () => {
    const politoed = mon({ species: 'Politoed', ability: 'Drizzle', item: 'Sitrus Berry', moves: ['Perish Song', 'Protect', 'Surf', 'Icy Wind'] });
    const steelix = mon({ species: 'Steelix', ability: 'Sturdy', item: 'Leftovers', moves: ['Block', 'Iron Head', 'Protect', 'Earthquake'] });
    const out = detectTactics([profileFromSet(politoed), profileFromSet(steelix)]);
    const trap = out.find(t => t.pattern === 'perish-trap');
    expect(trap).toBeTruthy();
    expect(tacticLabel(trap!)).toContain('Politoed');
    expect(tacticLabel(trap!)).toContain('Steelix');
  });

  test('Espathra stored-power snowball (Speed Boost + Calm Mind)', () => {
    const espathra = mon({ species: 'Espathra', ability: 'Speed Boost', item: 'Leftovers', moves: ['Stored Power', 'Calm Mind', 'Protect', 'Dazzling Gleam'] });
    const out = detectTactics([profileFromSet(espathra)]);
    const sp = out.find(t => t.pattern === 'stored-power');
    expect(sp).toBeTruthy();
    expect(sp!.payoff).toContain('+3 stages/turn');
  });

  test('spread move + immune partner (Earthquake + Flying)', () => {
    const chomp = mon({ species: 'Garchomp', ability: 'Rough Skin', item: 'Life Orb', moves: ['Earthquake', 'Dragon Claw', 'Protect', 'Rock Slide'] });
    const talon = mon({ species: 'Talonflame', ability: 'Gale Wings', item: 'Sharp Beak', moves: ['Brave Bird', 'Tailwind', 'Protect', 'Will-O-Wisp'] });
    const out = detectTactics([profileFromSet(chomp), profileFromSet(talon)]);
    const free = out.find(t => t.pattern === 'spread-immune');
    expect(free).toBeTruthy();
    expect(free!.pieces.some(p => p.species === 'Talonflame')).toBe(true);
  });

  test('no combo pieces -> no instances', () => {
    const plain = mon({ species: 'Garchomp', ability: 'Rough Skin', item: 'Choice Band', moves: ['Dragon Claw', 'Iron Head'] });
    const out = detectTactics([profileFromSet(plain)]);
    expect(out.length).toBe(0);
  });
});

describe('detectTactics — potential profiles', () => {
  test('Politoed learnset exposes perish-trap potential with a trapper partner', () => {
    const out = detectTactics([profileFromSpecies('Politoed'), profileFromSpecies('Steelix')]);
    expect(out.some(t => t.pattern === 'perish-trap')).toBe(true);
  });

  test('mega stone profile carries the custom ability (Mega Sol on Meganium-Mega)', () => {
    const p = profileFromMegaStone('meganiumite');
    expect(p).toBeTruthy();
    expect(p!.abilities).toContain('megasol');
    const out = detectTactics([p!]);
    expect(out.some(t => t.pattern === 'weather' && t.name.includes('Mega Sol'))).toBe(true);
  });
});

describe('profileFromOpponentEntry — battle-time narrowing', () => {
  const base: OpponentEntry = { species: 'Politoed', knownMoves: [] };

  test('unrevealed: full learnset, threat space wide', () => {
    const p = profileFromOpponentEntry(base);
    expect(p.potential).toBe(true);
    expect(p.moves.has('perishsong')).toBe(true);
  });

  test('4 revealed moves without Perish Song kill the perish threat', () => {
    const p = profileFromOpponentEntry({ ...base, knownMoves: ['Surf', 'Protect', 'Ice Beam', 'Helping Hand'] });
    expect(p.potential).toBe(false);
    expect(p.moves.has('perishsong')).toBe(false);
  });

  test('ability rule-outs prune the ability list', () => {
    const p = profileFromOpponentEntry({ species: 'Sneasler', knownMoves: [], abilitiesRuledOut: ['Unburden'] });
    expect(p.abilities).not.toContain('unburden');
    const out = detectTactics([p]);
    expect(out.some(t => t.pattern === 'unburden')).toBe(false);
  });

  test('a known non-consumable item kills the Unburden combo', () => {
    const p = profileFromOpponentEntry({ species: 'Sneasler', knownMoves: [], item: 'choiceband' });
    const out = detectTactics([p]);
    expect(out.some(t => t.pattern === 'unburden')).toBe(false);
  });
});

describe('scoreBrings tactic integration', () => {
  test('brings carry tactics/threats numbers and combo rationale', () => {
    const team = [
      mon({ species: 'Politoed', ability: 'Drizzle', item: 'Sitrus Berry', moves: ['Perish Song', 'Protect', 'Surf', 'Icy Wind'] }),
      mon({ species: 'Steelix', ability: 'Sturdy', item: 'Leftovers', moves: ['Block', 'Iron Head', 'Protect', 'Earthquake'] }),
      mon({ species: 'Garchomp', ability: 'Rough Skin', item: 'Life Orb', moves: ['Earthquake', 'Dragon Claw', 'Protect', 'Rock Slide'] }),
      mon({ species: 'Talonflame', ability: 'Gale Wings', item: 'Sharp Beak', moves: ['Brave Bird', 'Tailwind', 'Protect', 'Taunt'] }),
      mon({ species: 'Espathra', ability: 'Speed Boost', item: 'Focus Sash', moves: ['Stored Power', 'Calm Mind', 'Protect', 'Baton Pass'] }),
      mon({ species: 'Kingambit', ability: 'Defiant', item: 'Black Glasses', moves: ['Kowtow Cleave', 'Sucker Punch', 'Iron Head', 'Protect'] }),
    ];
    const opp: OpponentEntry[] = ['Politoed', 'Espathra', 'Torkoal', 'Whimsicott', 'Araquanid', 'Sneasler']
      .map(species => ({ species, knownMoves: [] }));
    const brings = scoreBrings(team, opp);
    expect(brings.length).toBe(15);
    const withTrap = brings.find(b =>
      b.myIndices.includes(0) && b.myIndices.includes(1));
    expect(withTrap).toBeTruthy();
    expect(withTrap!.tactics).toBeGreaterThan(0);
    expect(withTrap!.rationale.some(r => r.startsWith('Combo: Perish trap'))).toBe(true);
    // Threat lines exist (covered or not) for the opponent's combo space.
    expect(brings[0]!.rationale.some(r => r.startsWith('Covers opp') || r.startsWith('⚠ No answer'))).toBe(true);
  });
});

describe('no-guard detector', () => {
  test('Mega Raichu Y (stone profile): Zap Cannon never misses', () => {
    const p = profileFromMegaStone('raichunitey');
    expect(p).toBeTruthy();
    expect(p!.abilities).toContain('noguard');
    const out = detectTactics([p!]);
    const ng = out.find(t => t.pattern === 'no-guard');
    expect(ng).toBeTruthy();
    expect(ng!.payoff).toContain('Zap Cannon');
  });

  test('Mega Hawlucha (legal M-A stone): High Jump Kick crash-free', () => {
    const p = profileFromMegaStone('hawluchanite');
    expect(p).toBeTruthy();
    const out = detectTactics([p!]);
    const ng = out.find(t => t.pattern === 'no-guard');
    expect(ng).toBeTruthy();
    expect(ng!.pieces[0]!.move).toContain('High Jump Kick');
  });

  test('accurate-only movesets produce no instance', () => {
    const set = mon({ species: 'Hawlucha', ability: 'No Guard', item: 'Hawluchanite', moves: ['Acrobatics', 'Protect'] });
    const out = detectTactics([profileFromSet(set)]);
    expect(out.some(t => t.pattern === 'no-guard')).toBe(false);
  });
});
