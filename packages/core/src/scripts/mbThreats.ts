// Hand-built Reg M-B threat teams (best-guess meta — no real usage exists yet).
// Built around the strong, calc-correct new megas/species; one mega each, unique
// items. Shared by mb-team-check.ts (stress-test) and mb-hill-climb.ts (search)
// so both reason about the exact same M-B gauntlet. Side-effect free.
import type { PokemonSet, Stats } from '../domain/types.js';
import { MAX_IVS } from '../domain/types.js';

/** Compact set builder: EVs default to 0, only the named stats are set. */
export function S(species: string, ability: string, item: string, nature: string, evs: Partial<Stats>, moves: string[]): PokemonSet {
  return { species, level: 50, nature, ability, item: item || undefined,
    evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...evs }, ivs: { ...MAX_IVS }, moves };
}
const inc = (item: string) => S('Incineroar', 'Intimidate', item, 'Careful', { hp: 252, atk: 4, spd: 252 }, ['Fake Out', 'Flare Blitz', 'Knock Off', 'Parting Shot']);
const whim = (item: string, m4 = 'Light Screen') => S('Whimsicott', 'Prankster', item, 'Timid', { spa: 252, spe: 252 }, ['Moonblast', 'Tailwind', 'Encore', m4]);
const chompScarf = S('Garchomp', 'Rough Skin', 'Choice Scarf', 'Jolly', { atk: 252, spe: 252 }, ['Earthquake', 'Rock Slide', 'Dragon Claw', 'Stomping Tantrum']);

export const MB_THREATS: { anchor: string; sets: PokemonSet[] }[] = [
  { anchor: 'Mega Mawile', sets: [
    S('Mawile', 'Intimidate', 'Mawilite', 'Adamant', { hp: 252, atk: 252 }, ['Play Rough', 'Sucker Punch', 'Iron Head', 'Protect']),
    inc('Sitrus Berry'),
    chompScarf,
    whim('Focus Sash'),
    S('Gholdengo', 'Good as Gold', 'Choice Specs', 'Modest', { spa: 252, spe: 252 }, ['Make It Rain', 'Shadow Ball', 'Power Gem', 'Thunderbolt']),
    S('Primarina', 'Torrent', 'Assault Vest', 'Modest', { hp: 252, spa: 252 }, ['Moonblast', 'Hydro Pump', 'Ice Beam', 'Energy Ball']),
  ] },
  { anchor: 'Mega Metagross', sets: [
    S('Metagross', 'Clear Body', 'Metagrossite', 'Jolly', { atk: 252, spe: 252 }, ['Meteor Mash', 'Bullet Punch', 'Ice Punch', 'Earthquake']),
    inc('Safety Goggles'),
    S('Dragapult', 'Clear Body', 'Choice Band', 'Jolly', { atk: 252, spe: 252 }, ['Dragon Darts', 'Phantom Force', 'U-turn', 'Sucker Punch']),
    whim('Focus Sash', 'Helping Hand'),
    S('Garganacl', 'Purifying Salt', 'Leftovers', 'Careful', { hp: 252, spd: 252 }, ['Salt Cure', 'Recover', 'Protect', 'Wide Guard']),
    S('Talonflame', 'Gale Wings', 'Sharp Beak', 'Jolly', { atk: 252, spe: 252 }, ['Brave Bird', 'Tailwind', 'Will-O-Wisp', 'Protect']),
  ] },
  { anchor: 'Mega Swampert (rain)', sets: [
    S('Pelipper', 'Drizzle', 'Focus Sash', 'Modest', { spa: 252, spe: 252 }, ['Hurricane', 'Weather Ball', 'Tailwind', 'Protect']),
    S('Swampert', 'Torrent', 'Swampertite', 'Adamant', { atk: 252, spe: 252 }, ['Liquidation', 'Earthquake', 'Ice Punch', 'Protect']),
    S('Archaludon', 'Stamina', 'Assault Vest', 'Modest', { hp: 124, spa: 252, spe: 132 }, ['Electro Shot', 'Flash Cannon', 'Dragon Pulse', 'Body Press']),
    S('Sneasler', 'Unburden', 'White Herb', 'Jolly', { atk: 252, spe: 252 }, ['Close Combat', 'Dire Claw', 'Fake Out', 'Protect']),
    inc('Sitrus Berry'),
    S('Rillaboom', 'Grassy Surge', 'Miracle Seed', 'Adamant', { hp: 252, atk: 252 }, ['Grassy Glide', 'Wood Hammer', 'Fake Out', 'U-turn']),
  ] },
  { anchor: 'Mega Raichu-X (terrain)', sets: [
    S('Raichu', 'Static', 'Raichunite X', 'Modest', { spa: 252, spe: 252 }, ['Rising Voltage', 'Thunderbolt', 'Volt Switch', 'Protect']),
    S('Archaludon', 'Stamina', 'Assault Vest', 'Modest', { hp: 124, spa: 252, spe: 132 }, ['Electro Shot', 'Flash Cannon', 'Dragon Pulse', 'Body Press']),
    whim('Focus Sash'),
    inc('Sitrus Berry'),
    chompScarf,
    S('Bellibolt', 'Electromorphosis', 'Leftovers', 'Modest', { hp: 252, spa: 252 }, ['Discharge', 'Volt Switch', 'Slack Off', 'Protect']),
  ] },
  { anchor: 'Mega Blaziken + Annihilape', sets: [
    S('Blaziken', 'Speed Boost', 'Blazikenite', 'Adamant', { atk: 252, spe: 252 }, ['Flare Blitz', 'Close Combat', 'Knock Off', 'Protect']),
    S('Annihilape', 'Defiant', 'Leftovers', 'Adamant', { hp: 252, atk: 252 }, ['Rage Fist', 'Drain Punch', 'Bulk Up', 'Protect']),
    inc('Sitrus Berry'),
    whim('Focus Sash', 'Helping Hand'),
    S('Dragapult', 'Clear Body', 'Choice Specs', 'Timid', { spa: 252, spe: 252 }, ['Draco Meteor', 'Shadow Ball', 'Thunderbolt', 'U-turn']),
    S('Primarina', 'Torrent', 'Assault Vest', 'Modest', { hp: 252, spa: 252 }, ['Moonblast', 'Hydro Pump', 'Ice Beam', 'Energy Ball']),
  ] },
];
