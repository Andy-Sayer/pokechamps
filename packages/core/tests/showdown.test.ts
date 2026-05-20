import { describe, test, expect } from 'vitest';
import { parseShowdownTeam, formatShowdownTeam } from '../src/domain/showdown.js';

const CHARIZARD_Y = `Charizard @ Charizardite Y
Ability: Blaze
Level: 50
EVs: 4 HP / 252 SpA / 252 Spe
Timid Nature
IVs: 0 Atk
- Heat Wave
- Solar Beam
- Protect
- Tailwind`;

const INCINEROAR = `Incineroar @ Sitrus Berry
Ability: Intimidate
Level: 50
EVs: 244 HP / 4 Atk / 4 Def / 12 SpD / 244 Spe
Adamant Nature
- Flare Blitz
- Knock Off
- Fake Out
- Parting Shot`;

describe('parseShowdownTeam', () => {
  test('parses a complete single set with item/ability/level/EVs/nature/IVs/moves', () => {
    const [set] = parseShowdownTeam(CHARIZARD_Y);
    expect(set).toBeDefined();
    expect(set!.species).toBe('Charizard');
    expect(set!.item).toBe('Charizardite Y');
    expect(set!.ability).toBe('Blaze');
    expect(set!.level).toBe(50);
    expect(set!.nature).toBe('Timid');
    expect(set!.evs).toEqual({ hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 });
    expect(set!.ivs).toEqual({ hp: 31, atk: 0, def: 31, spa: 31, spd: 31, spe: 31 });
    expect(set!.moves).toEqual(['Heat Wave', 'Solar Beam', 'Protect', 'Tailwind']);
  });

  test('parses a nicknamed set with species in parentheses', () => {
    const input = `Bubbles (Azumarill) @ Sitrus Berry
Ability: Huge Power
Level: 50
EVs: 252 HP / 252 Atk / 4 SpD
Adamant Nature
- Aqua Jet
- Play Rough
- Belly Drum
- Protect`;
    const [set] = parseShowdownTeam(input);
    expect(set!.species).toBe('Azumarill');
    expect(set!.item).toBe('Sitrus Berry');
    expect(set!.ability).toBe('Huge Power');
  });

  test('parses a 6-pokemon team separated by blank lines', () => {
    const six = [
      CHARIZARD_Y,
      INCINEROAR,
      `Gardevoir @ Gardevoirite\nAbility: Trace\nLevel: 50\nEVs: 252 HP / 252 SpA / 4 SpD\nModest Nature\nIVs: 0 Atk\n- Dazzling Gleam\n- Psychic\n- Trick Room\n- Protect`,
      `Amoonguss @ Rocky Helmet\nAbility: Regenerator\nLevel: 50\nEVs: 244 HP / 76 Def / 188 SpD\nCalm Nature\nIVs: 0 Atk / 0 Spe\n- Spore\n- Rage Powder\n- Pollen Puff\n- Protect`,
      `Dragonite @ Choice Band\nAbility: Inner Focus\nLevel: 50\nEVs: 4 HP / 252 Atk / 252 Spe\nAdamant Nature\n- Extreme Speed\n- Dragon Claw\n- Earthquake\n- Tera Blast`,
      `Tyranitar @ Tyranitarite\nAbility: Sand Stream\nLevel: 50\nEVs: 252 HP / 4 Atk / 252 SpD\nSassy Nature\nIVs: 0 Spe\n- Rock Slide\n- Crunch\n- Low Kick\n- Protect`,
    ].join('\n\n');
    const team = parseShowdownTeam(six);
    expect(team).toHaveLength(6);
    expect(team.map(s => s.species)).toEqual([
      'Charizard', 'Incineroar', 'Gardevoir', 'Amoonguss', 'Dragonite', 'Tyranitar',
    ]);
  });

  test('ignores legacy "Tera Type:" lines (Champions uses mega, not Tera)', () => {
    const input = `Dragonite @ Choice Band
Ability: Inner Focus
Level: 50
Tera Type: Normal
EVs: 4 HP / 252 Atk / 252 Spe
Adamant Nature
- Extreme Speed
- Dragon Claw
- Earthquake
- Protect`;
    const [set] = parseShowdownTeam(input) as any[];
    // No tera field should appear in the parsed set.
    expect(set.teraType).toBeUndefined();
    expect((set as any).tera).toBeUndefined();
    expect(set.species).toBe('Dragonite');
    expect(set.moves).toEqual(['Extreme Speed', 'Dragon Claw', 'Earthquake', 'Protect']);
  });

  test('round-trip: parse -> format -> parse produces equivalent sets', () => {
    const teamA = parseShowdownTeam(`${CHARIZARD_Y}\n\n${INCINEROAR}`);
    const text = formatShowdownTeam(teamA);
    const teamB = parseShowdownTeam(text);
    expect(teamB).toEqual(teamA);
  });

  test('handles CR-only line endings (Windows Terminal + Ink useInput pastes)', () => {
    // Two mons separated by a blank line, but every newline is "\r" not "\n".
    // This mirrors what shows up in data/my-teams when pasted on Windows.
    const crOnly = [
      'Charizard @ Charizardite Y',
      'Ability: Blaze',
      'Level: 50',
      'EVs: 4 HP / 252 SpA / 252 Spe',
      'Timid Nature',
      '- Heat Wave',
      '- Protect',
      '',
      'Incineroar @ Sitrus Berry',
      'Ability: Intimidate',
      'Level: 50',
      'EVs: 244 HP / 12 SpD',
      'Adamant Nature',
      '- Fake Out',
      '- Knock Off',
    ].join('\r');
    const team = parseShowdownTeam(crOnly);
    expect(team).toHaveLength(2);
    expect(team[0]!.species).toBe('Charizard');
    expect(team[0]!.item).toBe('Charizardite Y');
    expect(team[0]!.moves).toEqual(['Heat Wave', 'Protect']);
    expect(team[1]!.species).toBe('Incineroar');
    expect(team[1]!.moves).toEqual(['Fake Out', 'Knock Off']);
  });

  test('handles CRLF line endings', () => {
    const crlf = `Charizard @ Charizardite Y\r\nAbility: Blaze\r\n- Heat Wave\r\n- Protect`;
    const [set] = parseShowdownTeam(crlf);
    expect(set!.species).toBe('Charizard');
    expect(set!.ability).toBe('Blaze');
    expect(set!.moves).toEqual(['Heat Wave', 'Protect']);
  });

  test('defaults: missing nature -> Hardy, missing level -> 50, missing EVs all 0, missing IVs all 31', () => {
    const input = `Snorlax @ Leftovers
Ability: Thick Fat
- Body Slam
- Rest
- Sleep Talk
- Curse`;
    const [set] = parseShowdownTeam(input);
    expect(set!.nature).toBe('Hardy');
    expect(set!.level).toBe(50);
    expect(set!.evs).toEqual({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 });
    expect(set!.ivs).toEqual({ hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 });
  });
});
