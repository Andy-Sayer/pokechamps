// Reg M-C switch-day readiness (starts Sept 8 2026 19:00 PDT / Sept 9 02:00 UTC).
// The six new megas must light up through the EXISTING pipeline once their stones
// are legal — data wiring only (stone in items.allow -> patched mega forme ability
// -> calc), plus the one CUSTOM ability that needs emulation (Lucario-Mega-Z's
// contact halving). If a switch-day refresh-data unpatches an ability or the calc
// stops resolving a forme, these fail loudly. See docs/notes/regulation-m-c.md.
import { describe, test, expect } from 'vitest';
import { isLegalItem, isLegalSpecies } from '../src/domain/data.js';
import { profileFromMegaStone } from '../src/domain/tactics.js';
import { megaFormeAbility } from '../src/domain/gimmicks/mega.js';
import { damageRange, isAuraGuardAbility } from '../src/domain/damage.js';
import { NEUTRAL_FIELD, type PokemonSet } from '../src/domain/types.js';

const MAX_IVS = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };

/** Stone id -> [base species id, mega forme name, the ability it must fight with]. */
const M_C_MEGAS: Array<[string, string, string, string]> = [
  ['salamencite', 'salamence', 'Salamence-Mega', 'Aerilate'],
  ['golisopite', 'golisopod', 'Golisopod-Mega', 'Emergency Exit'],      // placeholder — unrevealed
  ['baxcalibrite', 'baxcalibur', 'Baxcalibur-Mega', 'Thermal Exchange'], // placeholder — unrevealed
  ['absolitez', 'absol', 'Absol-Mega-Z', 'Sharpness'],
  ['garchompitez', 'garchomp', 'Garchomp-Mega-Z', 'Levitate'],
  ['lucarionitez', 'lucario', 'Lucario-Mega-Z', 'Aura Guard'],
];

describe('Reg M-C — the six new stones + four new base species are staged', () => {
  test.each(M_C_MEGAS)('%s is a legal item and %s is a legal species', (stone, base) => {
    expect(isLegalItem(stone)).toBe(true);
    expect(isLegalSpecies(base)).toBe(true);
  });

  test('the four newly announced base species are legal', () => {
    for (const id of ['rillaboom', 'salamence', 'golisopod', 'baxcalibur']) {
      expect(isLegalSpecies(id)).toBe(true);
    }
  });
});

describe('Reg M-C — every new stone resolves to its forme with the right ability', () => {
  test.each(M_C_MEGAS)('%s -> %s / %s', (stone, _base, forme, ability) => {
    const p = profileFromMegaStone(stone);
    expect(p).not.toBeNull();
    expect(p!.species).toBe(forme);
    expect(p!.item).toBe(stone);
    // megaFormeAbility is what the calc and the search actually read.
    expect(megaFormeAbility(forme)).toBe(ability);
  });
});

// ---------- Lucario-Mega-Z: Aura Guard (custom — contact damage taken ×0.5) ----------

const megaLucarioZ: PokemonSet = {
  species: 'Lucario',
  level: 50,
  item: 'Lucarionite Z',
  ability: 'Inner Focus',
  nature: 'Timid',
  evs: { hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 },
  ivs: MAX_IVS,
  moves: ['Aura Sphere', 'Flash Cannon', 'Vacuum Wave', 'Protect'],
};

const physicalAttacker: PokemonSet = {
  species: 'Garchomp',
  level: 50,
  item: 'Life Orb',
  ability: 'Rough Skin',
  nature: 'Jolly',
  evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 },
  ivs: MAX_IVS,
  moves: ['Earthquake', 'Dragon Claw', 'Fire Fang', 'Rock Slide'],
};

describe('Reg M-C — Aura Guard emulation', () => {
  test('both circulating names for the reveal are recognised', () => {
    expect(isAuraGuardAbility('Aura Guard')).toBe(true);
    expect(isAuraGuardAbility('Wave Shield')).toBe(true);
    expect(isAuraGuardAbility('aura guard')).toBe(true);
    expect(isAuraGuardAbility('Aura Break')).toBe(false);
    expect(isAuraGuardAbility(undefined)).toBe(false);
  });

  const roll = (move: string, active: boolean) => damageRange({
    attacker: physicalAttacker,
    defender: megaLucarioZ,
    move,
    field: NEUTRAL_FIELD,
    attackerSide: 'theirs',
    defenderOpts: { gimmickActive: active },
  });

  test('a CONTACT move is halved once the mon has mega evolved', () => {
    // Dragon Claw: contact, non-Fire, neutral into Fighting/Steel... Steel resists
    // Dragon, so both sides carry the same resist — only the ×0.5 differs.
    const pre = roll('Dragon Claw', false);   // stone held, not yet mega'd -> base forme
    const post = roll('Dragon Claw', true);
    // Mega-Z has the same Def (70) as base Lucario, so the ONLY change is the ability.
    expect(post.max).toBeLessThan(pre.max);
    expect(post.max).toBe(Math.floor(pre.max / 2));
    expect(post.min).toBe(Math.floor(pre.min / 2));
  });

  test('a contact FIRE move is halved too (Fluffy alone would cancel to x1)', () => {
    const pre = roll('Fire Fang', false);
    const post = roll('Fire Fang', true);
    // The Fire path routes through Heatproof, which halves the ATTACK STAT rather
    // than applying a final ×0.5 — within ~2 HP of the exact half, never ×1.
    expect(post.max).toBeGreaterThanOrEqual(Math.floor(pre.max / 2));
    expect(post.max).toBeLessThanOrEqual(Math.floor(pre.max / 2) + 2);
  });

  test('a NON-contact move is untouched', () => {
    const pre = roll('Rock Slide', false);
    const post = roll('Rock Slide', true);
    expect(post.max).toBe(pre.max);
  });
});

// ---------- Garchomp-Mega-Z: Levitate (mono-Dragon, loses the Ground weakness) ----------

describe('Reg M-C — Garchomp-Mega-Z is a Levitating mono-Dragon', () => {
  const megaChompZ: PokemonSet = {
    species: 'Garchomp',
    level: 50,
    item: 'Garchompite Z',
    ability: 'Rough Skin',
    nature: 'Modest',
    evs: { hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 },
    ivs: MAX_IVS,
    moves: ['Draco Meteor', 'Earth Power', 'Flamethrower', 'Protect'],
  };
  const groundAttacker: PokemonSet = {
    species: 'Excadrill',
    level: 50,
    item: 'Life Orb',
    ability: 'Sand Rush',
    nature: 'Adamant',
    evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 },
    ivs: MAX_IVS,
    moves: ['Earthquake', 'Iron Head', 'Rock Slide', 'Protect'],
  };

  test('Earthquake hurts the base forme but is a no-op once it mega evolves', () => {
    const base = damageRange({
      attacker: groundAttacker, defender: megaChompZ, move: 'Earthquake',
      field: NEUTRAL_FIELD, attackerSide: 'theirs', defenderOpts: { gimmickActive: false },
    });
    expect(base.max).toBeGreaterThan(0);
    // Immunity is signalled by the calc's kochance() throw — the repo-wide contract
    // callers use to exclude an option (see damage.test.ts's Eelevate case).
    expect(() => damageRange({
      attacker: groundAttacker, defender: megaChompZ, move: 'Earthquake',
      field: NEUTRAL_FIELD, attackerSide: 'theirs', defenderOpts: { gimmickActive: true },
    })).toThrow();
  });
});

// ---------- Absol-Mega-Z: Sharpness (standard — the calc applies it natively) ----------

describe('Reg M-C — Absol-Mega-Z gets Sharpness on slicing moves', () => {
  const megaAbsolZ: PokemonSet = {
    species: 'Absol',
    level: 50,
    item: 'Absolite Z',
    ability: 'Super Luck',
    nature: 'Jolly',
    evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 },
    ivs: MAX_IVS,
    moves: ['Night Slash', 'Sucker Punch', 'Play Rough', 'Protect'],
  };
  const wall: PokemonSet = {
    species: 'Snorlax',
    level: 50,
    item: 'Leftovers',
    ability: 'Thick Fat',
    nature: 'Careful',
    evs: { hp: 252, atk: 0, def: 4, spa: 0, spd: 252, spe: 0 },
    ivs: MAX_IVS,
    moves: ['Body Slam', 'Protect', 'Rest', 'Yawn'],
  };

  test('Night Slash out-damages the un-mega\'d roll by more than the Atk jump alone', () => {
    const pre = damageRange({
      attacker: megaAbsolZ, defender: wall, move: 'Night Slash',
      field: NEUTRAL_FIELD, attackerSide: 'theirs', attackerOpts: { gimmickActive: false },
    });
    const post = damageRange({
      attacker: megaAbsolZ, defender: wall, move: 'Night Slash',
      field: NEUTRAL_FIELD, attackerSide: 'theirs', attackerOpts: { gimmickActive: true },
    });
    // Atk 130 -> 154 is ×1.18; Sharpness adds ×1.5 on top, so the jump must clear ×1.5.
    expect(post.max / pre.max).toBeGreaterThan(1.5);
  });
});
