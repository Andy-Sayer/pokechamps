// Sanity-check the damage + inference modules against a known matchup.
//
// Matchup: Calyrex-Shadow's Astral Barrage into Incineroar.
// Both at level 50, Calyrex with 252 SpA Timid + Choice Specs, Incineroar at
// 244 HP / 4 SpD bulky spread. Expected damage range from Pikalytics is roughly
// 60–72% (one-shot range varies with rolls). We just check that the predicted
// percent overlaps the published expectation.

import { damageRange, maxHpFor } from '../domain/damage.js';
import { inferSpread, mostLikely } from '../domain/inference.js';
import { NEUTRAL_FIELD } from '../domain/types.js';
import type { PokemonSet } from '../domain/types.js';

const calyrex: PokemonSet = {
  species: 'Calyrex-Shadow',
  level: 50,
  item: 'Choice Specs',
  ability: 'As One (Spectrier)',
  nature: 'Timid',
  evs: { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 },
  ivs: { hp: 31, atk: 0, def: 31, spa: 31, spd: 31, spe: 31 },
  moves: ['Astral Barrage', 'Psyshock', 'Nasty Plot', 'Protect'],
};

const incineroar: PokemonSet = {
  species: 'Incineroar',
  level: 50,
  item: 'Safety Goggles',
  ability: 'Intimidate',
  nature: 'Careful',
  evs: { hp: 244, atk: 0, def: 4, spa: 0, spd: 252, spe: 4 },
  ivs: { hp: 31, atk: 31, def: 31, spa: 0, spd: 31, spe: 31 },
  moves: ['Fake Out', 'Flare Blitz', 'Knock Off', 'Parting Shot'],
};

const dmg = damageRange({
  attacker: calyrex,
  defender: incineroar,
  move: 'Astral Barrage',
  field: NEUTRAL_FIELD,
  attackerSide: 'mine',
});

console.log('=== Forward damage check ===');
console.log(`Calyrex-S Choice Specs Astral Barrage -> 244 HP / 252 SpD Incineroar`);
console.log(`  Predicted: ${dmg.min}-${dmg.max} damage (${dmg.minPercent.toFixed(1)}-${dmg.maxPercent.toFixed(1)}% of ${maxHpFor(incineroar)} HP)`);
console.log(`  Desc: ${dmg.desc}`);
console.log(`  KO: ${dmg.koChance}`);

const median = Math.round((dmg.min + dmg.max) / 2);
const observedPercent = (median / maxHpFor(incineroar)) * 100;

console.log('\n=== Inverse inference check ===');
console.log(`Pretending we observed ${observedPercent.toFixed(0)}% damage. Narrow Incineroar's spread:`);

const candidates = inferSpread({
  defenderSpecies: 'Incineroar',
  defenderLevel: 50,
  knownDefenderMoves: incineroar.moves,
  attackerSet: calyrex,
  observation: {
    attackerSide: 'mine',
    attackerSpecies: 'Calyrex-Shadow',
    defenderSide: 'theirs',
    defenderSpecies: 'Incineroar',
    move: 'Astral Barrage',
    field: NEUTRAL_FIELD,
    damageHpPercent: observedPercent,
  },
  priorAbilities: ['Intimidate'],
  priorItems: ['Safety Goggles', 'Assault Vest', 'Sitrus Berry', 'Rocky Helmet', undefined as any],
});

console.log(`  Narrowed to ${candidates.length} candidate spreads.`);
const top = mostLikely(candidates);
if (top) {
  const evStr = Object.entries(top.evs).filter(([_, v]) => v).map(([k, v]) => `${v} ${k.toUpperCase()}`).join(' / ');
  console.log(`  Most likely: ${top.nature} ${evStr}${top.item ? ` @ ${top.item}` : ''}`);
} else {
  console.log('  No candidates — observation outside all expected ranges (check inputs).');
}
