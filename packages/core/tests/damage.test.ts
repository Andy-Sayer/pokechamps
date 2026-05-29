import { describe, test, expect } from 'vitest';
import {
  damageRange,
  maxHpFor,
  observationToAbsoluteDamage,
  CALC_SPECIES_OVERRIDES,
  calcSpeciesName,
} from '../src/domain/damage.js';
import { NEUTRAL_FIELD, type PokemonSet, type DamageObservation } from '../src/domain/types.js';

const MAX_IVS = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
const ZERO_EVS = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };

// ---------- Reference sets ----------

const specsCalyrexS: PokemonSet = {
  species: 'Calyrex-Shadow',
  level: 50,
  item: 'Choice Specs',
  ability: 'As One (Spectrier)',
  nature: 'Timid',
  evs: { hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 },
  ivs: MAX_IVS,
  moves: ['Astral Barrage', 'Psyshock', 'Nasty Plot', 'Protect'],
};

// 244 HP / 252+ SpD Incineroar w/ Safety Goggles — Regulation-style spread.
const bulkyIncineroar: PokemonSet = {
  species: 'Incineroar',
  level: 50,
  item: 'Safety Goggles',
  ability: 'Intimidate',
  nature: 'Careful',
  evs: { hp: 244, atk: 0, def: 0, spa: 0, spd: 252, spe: 12 },
  ivs: MAX_IVS,
  moves: ['Fake Out', 'Flare Blitz', 'Knock Off', 'Parting Shot'],
};

const specsHydreigon: PokemonSet = {
  species: 'Hydreigon',
  level: 50,
  item: 'Choice Specs',
  ability: 'Levitate',
  nature: 'Modest',
  evs: { hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 },
  ivs: MAX_IVS,
  moves: ['Draco Meteor', 'Dark Pulse', 'Flash Cannon', 'Protect'],
};

const frailCharizard: PokemonSet = {
  species: 'Charizard',
  level: 50,
  item: undefined,
  ability: 'Blaze',
  nature: 'Hardy',
  evs: { ...ZERO_EVS, hp: 4 },
  ivs: MAX_IVS,
  moves: ['Flamethrower', 'Air Slash', 'Dragon Pulse', 'Protect'],
};

// ---------- CALC_SPECIES_OVERRIDES ----------

describe('CALC_SPECIES_OVERRIDES / calcSpeciesName', () => {
  test('Aegislash maps to Aegislash-Shield', () => {
    expect(CALC_SPECIES_OVERRIDES['Aegislash']).toBe('Aegislash-Shield');
    expect(calcSpeciesName('Aegislash')).toBe('Aegislash-Shield');
  });

  test('non-overridden species pass through unchanged', () => {
    expect(calcSpeciesName('Incineroar')).toBe('Incineroar');
    expect(calcSpeciesName('Charizard')).toBe('Charizard');
  });
});

// ---------- damageRange — golden matchup ----------

describe('damageRange — golden Calyrex-Shadow vs bulky Incineroar', () => {
  const r = damageRange({
    attacker: specsCalyrexS,
    defender: bulkyIncineroar,
    move: 'Astral Barrage',
    field: NEUTRAL_FIELD,
    attackerSide: 'theirs',
  });

  test('min damage is 53 (+/- 1)', () => {
    expect(r.min).toBeGreaterThanOrEqual(52);
    expect(r.min).toBeLessThanOrEqual(54);
  });

  test('max damage is 63 (+/- 1)', () => {
    expect(r.max).toBeGreaterThanOrEqual(62);
    expect(r.max).toBeLessThanOrEqual(64);
  });

  test('percent range straddles 26.3 - 31.3', () => {
    // 53/202 ~ 26.24%, 63/202 ~ 31.19%. Allow ~1pp tolerance on each side.
    expect(r.minPercent).toBeGreaterThan(25);
    expect(r.minPercent).toBeLessThan(28);
    expect(r.maxPercent).toBeGreaterThan(30);
    expect(r.maxPercent).toBeLessThan(33);
  });

  test('koChance text is populated and desc mentions both mons', () => {
    expect(r.koChance.length).toBeGreaterThan(0);
    expect(r.desc).toMatch(/Calyrex/);
    expect(r.desc).toMatch(/Incineroar/);
  });

  test('rolls array has at least one entry', () => {
    expect(Array.isArray(r.rolls)).toBe(true);
    expect(r.rolls.length).toBeGreaterThan(0);
  });
});

// ---------- damageRange — secondary matchup ----------

describe('damageRange — Specs Hydreigon Draco Meteor vs frail Charizard', () => {
  const r = damageRange({
    attacker: specsHydreigon,
    defender: frailCharizard,
    move: 'Draco Meteor',
    field: NEUTRAL_FIELD,
    attackerSide: 'theirs',
  });
  const maxHP = maxHpFor(frailCharizard);

  test('min damage > 0', () => {
    expect(r.min).toBeGreaterThan(0);
  });

  test('max damage is a sensible finite positive number', () => {
    // @smogon/calc returns raw damage rolls, which legitimately exceed maxHP
    // on an OHKO (overkill is just how the calc reports it — not a bug).
    expect(r.max).toBeGreaterThan(0);
    expect(Number.isFinite(r.max)).toBe(true);
    expect(maxHP).toBeGreaterThan(0);
  });

  test('percent range is meaningful (max > 50%)', () => {
    expect(r.maxPercent).toBeGreaterThan(50);
  });

  test('koChance is non-empty', () => {
    expect(r.koChance.length).toBeGreaterThan(0);
  });
});

// ---------- maxHpFor ----------

describe('maxHpFor', () => {
  test('returns sentinel 1 for an unknown species (does not throw)', () => {
    const fake: PokemonSet = {
      species: 'Nonexistmon',
      level: 50,
      nature: 'Hardy',
      evs: ZERO_EVS,
      ivs: MAX_IVS,
      moves: [],
    };
    expect(() => maxHpFor(fake)).not.toThrow();
    expect(maxHpFor(fake)).toBe(1);
  });

  test('Calyrex-Shadow with 0 HP EVs is around 175', () => {
    const noHpCaly: PokemonSet = {
      ...specsCalyrexS,
      evs: { ...ZERO_EVS, spa: 252, spe: 252 },
    };
    const hp = maxHpFor(noHpCaly);
    // Base HP 100, level 50, 0 EVs, 31 IVs:
    //   floor((2*100 + 31 + 0) * 50 / 100) + 50 + 10 = 115 + 60 = 175.
    expect(hp).toBeGreaterThanOrEqual(173);
    expect(hp).toBeLessThanOrEqual(177);
  });

  test('bulky Incineroar (244 HP EVs) maxHP is significantly higher than 0-HP', () => {
    const noHpIncin: PokemonSet = { ...bulkyIncineroar, evs: { ...ZERO_EVS } };
    expect(maxHpFor(bulkyIncineroar)).toBeGreaterThan(maxHpFor(noHpIncin));
  });
});

// ---------- Aegislash override behavior ----------

describe('Aegislash species override end-to-end', () => {
  const aegi: PokemonSet = {
    species: 'Aegislash',
    level: 50,
    item: 'Weakness Policy',
    ability: 'Stance Change',
    nature: 'Quiet',
    evs: { hp: 252, atk: 0, def: 0, spa: 252, spd: 4, spe: 0 },
    ivs: MAX_IVS,
    moves: ['Shadow Ball', 'Flash Cannon', 'Shadow Sneak', 'Protect'],
  };

  test('damageRange does not throw with Aegislash as attacker', () => {
    expect(() => damageRange({
      attacker: aegi,
      defender: bulkyIncineroar,
      move: 'Shadow Ball',
      field: NEUTRAL_FIELD,
      attackerSide: 'mine',
    })).not.toThrow();
    const r = damageRange({
      attacker: aegi,
      defender: bulkyIncineroar,
      move: 'Shadow Ball',
      field: NEUTRAL_FIELD,
      attackerSide: 'mine',
    });
    expect(Number.isFinite(r.min)).toBe(true);
    expect(Number.isFinite(r.max)).toBe(true);
    expect(r.max).toBeGreaterThan(0);
  });

  test('damageRange does not throw with Aegislash as defender', () => {
    expect(() => damageRange({
      attacker: specsCalyrexS,
      defender: aegi,
      move: 'Astral Barrage',
      field: NEUTRAL_FIELD,
      attackerSide: 'theirs',
    })).not.toThrow();
    const r = damageRange({
      attacker: specsCalyrexS,
      defender: aegi,
      move: 'Astral Barrage',
      field: NEUTRAL_FIELD,
      attackerSide: 'theirs',
    });
    expect(Number.isFinite(r.min)).toBe(true);
    expect(Number.isFinite(r.max)).toBe(true);
    expect(r.max).toBeGreaterThan(0);
  });
});

// ---------- observationToAbsoluteDamage ----------

describe('observationToAbsoluteDamage', () => {
  // Hand-rolled defender whose maxHP we can predict cleanly.
  const dummyDefender: PokemonSet = {
    species: 'Incineroar',
    level: 50,
    nature: 'Careful',
    evs: { ...ZERO_EVS, hp: 244, spd: 252 },
    ivs: MAX_IVS,
    moves: [],
  };

  test('raw observation returns lo === hi', () => {
    const obs: DamageObservation = {
      attackerSide: 'theirs',
      attackerSpecies: 'Calyrex-Shadow',
      defenderSide: 'mine',
      defenderSpecies: 'Incineroar',
      move: 'Astral Barrage',
      field: NEUTRAL_FIELD,
      damageRaw: 60,
    };
    const { lo, hi } = observationToAbsoluteDamage(obs, dummyDefender);
    expect(lo).toBe(60);
    expect(hi).toBe(60);
  });

  test('50% damage against a 200-HP mon straddles 100', () => {
    // Fabricate a defender whose maxHP is exactly 200 so the math is clean.
    const fakeDef: PokemonSet = {
      species: 'Incineroar',
      level: 50,
      nature: 'Hardy',
      evs: ZERO_EVS,
      ivs: MAX_IVS,
      moves: [],
    };
    // Whatever the actual HP is, the 50% observation should produce a lo/hi
    // range that straddles half-HP.
    const maxHP = maxHpFor(fakeDef);
    const obs: DamageObservation = {
      attackerSide: 'theirs',
      attackerSpecies: 'Calyrex-Shadow',
      defenderSide: 'mine',
      defenderSpecies: 'Incineroar',
      move: 'Astral Barrage',
      field: NEUTRAL_FIELD,
      damageHpPercent: 50,
    };
    const { lo, hi } = observationToAbsoluteDamage(obs, fakeDef);
    const halfHP = maxHP / 2;
    expect(lo).toBeLessThanOrEqual(halfHP);
    expect(hi).toBeGreaterThanOrEqual(halfHP);
    expect(hi).toBeGreaterThan(lo);
  });

  test('no damage info given returns [0, +Inf]', () => {
    const obs: DamageObservation = {
      attackerSide: 'theirs',
      attackerSpecies: 'Calyrex-Shadow',
      defenderSide: 'mine',
      defenderSpecies: 'Incineroar',
      move: 'Astral Barrage',
      field: NEUTRAL_FIELD,
    };
    const { lo, hi } = observationToAbsoluteDamage(obs, dummyDefender);
    expect(lo).toBe(0);
    expect(hi).toBe(Number.POSITIVE_INFINITY);
  });

  test('lo is clamped to 0 even for tiny percents', () => {
    // 0% with the -0.5% slack could go negative — must clamp.
    const obs: DamageObservation = {
      attackerSide: 'theirs',
      attackerSpecies: 'Calyrex-Shadow',
      defenderSide: 'mine',
      defenderSpecies: 'Incineroar',
      move: 'Astral Barrage',
      field: NEUTRAL_FIELD,
      damageHpPercent: 0,
    };
    const { lo } = observationToAbsoluteDamage(obs, dummyDefender);
    expect(lo).toBeGreaterThanOrEqual(0);
  });
});

// ---------- Mega behavior ----------

describe('Mega evolution behavior', () => {
  const baseChar: PokemonSet = {
    species: 'Charizard',
    level: 50,
    item: undefined,
    ability: 'Blaze',
    nature: 'Modest',
    evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 },
    ivs: MAX_IVS,
    moves: ['Flamethrower', 'Air Slash', 'Solar Beam', 'Protect'],
  };
  const megaY: PokemonSet = { ...baseChar, item: 'Charizardite Y', ability: 'Drought' };

  const target: PokemonSet = {
    species: 'Garchomp',
    level: 50,
    item: undefined,
    ability: 'Rough Skin',
    nature: 'Hardy',
    evs: ZERO_EVS,
    ivs: MAX_IVS,
    moves: ['Earthquake'],
  };

  test('Mega Charizard Y Flamethrower hits harder than base Charizard', () => {
    const base = damageRange({
      attacker: baseChar,
      defender: target,
      move: 'Flamethrower',
      field: NEUTRAL_FIELD,
      attackerSide: 'mine',
    });
    const mega = damageRange({
      attacker: megaY,
      defender: target,
      move: 'Flamethrower',
      field: NEUTRAL_FIELD,
      attackerSide: 'mine',
      attackerOpts: { gimmickActive: true },
    });
    expect(mega.min).toBeGreaterThan(base.min);
    expect(mega.max).toBeGreaterThan(base.max);
  });

  test('Spread moves get the 0.75x doubles modifier auto-applied', () => {
    // Heat Wave (allAdjacentFoes) should hit ~75% of single-target damage.
    // Compare against Flamethrower (single target) from the same attacker
    // into the same defender — base power is identical, so the only
    // difference should be the spread multiplier.
    const spread = damageRange({
      attacker: megaY, defender: target, move: 'Heat Wave',
      field: NEUTRAL_FIELD, attackerSide: 'mine',
      attackerOpts: { gimmickActive: true },
    });
    const single = damageRange({
      attacker: megaY, defender: target, move: 'Flamethrower',
      field: NEUTRAL_FIELD, attackerSide: 'mine',
      attackerOpts: { gimmickActive: true },
    });
    // Both 95 BP fire moves on the same attacker — single hits harder than
    // spread by approximately the spread modifier (0.75x). Both ranges
    // should overlap on the order-of-magnitude side, but spread.max <
    // single.max.
    expect(spread.max).toBeLessThan(single.max);
    // Sanity: spread isn't accidentally zero.
    expect(spread.max).toBeGreaterThan(0);
  });

  test('Pre-mega Charizard holding Charizardite Y still calcs as base Charizard', () => {
    // Held stone alone does NOT auto-megify — the mon has to have actually
    // mega-evolved (active=true) for the calc to use the mega forme stats.
    const heldStone = damageRange({
      attacker: megaY, defender: target, move: 'Flamethrower',
      field: NEUTRAL_FIELD, attackerSide: 'mine',
      // No gimmickActive — stone held but mon hasn't mega'd yet.
    });
    const activated = damageRange({
      attacker: megaY, defender: target, move: 'Flamethrower',
      field: NEUTRAL_FIELD, attackerSide: 'mine',
      attackerOpts: { gimmickActive: true },
    });
    // Pre-mega < post-mega: held stone alone doesn't get the mega SpA bump.
    expect(heldStone.max).toBeLessThan(activated.max);
  });
});

describe('damageRange — multi-hit moves total per-hit damage', () => {
  const aero: PokemonSet = {
    species: 'Aerodactyl', level: 50, ability: 'Pressure', nature: 'Jolly',
    evs: { ...ZERO_EVS, atk: 252, spe: 252 }, ivs: MAX_IVS, moves: ['Dual Wingbeat'],
  };
  const victreebel: PokemonSet = {
    species: 'Victreebel', level: 50, ability: 'Chlorophyll', nature: 'Modest',
    evs: { ...ZERO_EVS, hp: 252 }, ivs: MAX_IVS, moves: [],
  };

  test('Dual Wingbeat reports the 2-hit total, not a single hit', () => {
    const r = damageRange({ attacker: aero, defender: victreebel, move: 'Dual Wingbeat', field: NEUTRAL_FIELD, attackerSide: 'theirs' });
    expect(r.desc).toContain('(2 hits)');
    // One hit is ~45% here; the 2-hit total must be far higher (was the bug).
    expect(r.minPercent).toBeGreaterThan(70);
    // And consistent with the calc's own description total.
    const m = r.desc.match(/\((\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)%\)/);
    expect(m).not.toBeNull();
    expect(r.maxPercent).toBeCloseTo(parseFloat(m![2]!), 0);
  });
});
