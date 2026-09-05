// Hand-built Reg M-C threat teams — the six new megas + Rillaboom, the additions
// that actually change the field. M-C keeps every M-B species, so the M-B threats
// stay valid opponents: `ALL_THREATS` is the combined gauntlet and is what the
// stress-test / bring tooling should use from Sept 8, 2026 onward.
//
// WHY HAND-BUILT. Pikalytics will have no `gen9championsvgc2026regmc` usage for
// ~2 weeks after launch, so day-one bring picking has nothing real to score
// against. These are best-guess archetypes built off each mega's stat line and
// legal learnset, using the SAME support cast as the M-B threats (Incineroar /
// Whimsicott / Scarf Garchomp) so the two halves of the gauntlet stay comparable.
// Replace them with real usage the moment the M-B->M-C refresh-pikalytics lands.
//
// ITEM LEGALITY: Champions Reg M allows 73 non-stone items and Choice Scarf is
// the ONLY Choice item — no Assault Vest / Band / Specs / Safety Goggles. Every
// set here is item-clause-unique within its team and pinned by threats-legal.test.ts.
//
// TWO SETS ARE PROVISIONAL: Golisopod-Mega and Baxcalibur-Mega ship with
// PLACEHOLDER abilities (the base forme's) because Champions has not revealed
// theirs — see docs/notes/regulation-m-c.md. Re-tune both on switch-day.
import type { PokemonSet } from '../domain/types.js';
import { S, inc, whim, chompScarf, MB_THREATS } from './mbThreats.js';

/** Trick Room setter shared by the two slow-mega teams. */
const farigirafTR = S('Farigiraf', 'Armor Tail', 'Leftovers', 'Sassy', { hp: 252, spa: 4, spd: 252 }, ['Trick Room', 'Psychic', 'Helping Hand', 'Protect']);

export const MC_THREATS: { anchor: string; sets: PokemonSet[] }[] = [
  // Aerilate hyper-offense. Double-Edge is a 120 BP Flying nuke off 145 Atk;
  // Hyper Voice is the spread Flying option through Protect-heavy boards.
  { anchor: 'Mega Salamence (Aerilate)', sets: [
    S('Salamence', 'Intimidate', 'Salamencite', 'Naive', { atk: 252, spa: 4, spe: 252 }, ['Double-Edge', 'Hyper Voice', 'Dragon Claw', 'Protect']),
    inc('Sitrus Berry'),
    whim('Focus Sash'),
    chompScarf,
    S('Gholdengo', 'Good as Gold', 'Life Orb', 'Modest', { spa: 252, spe: 252 }, ['Make It Rain', 'Shadow Ball', 'Power Gem', 'Protect']),
    S('Primarina', 'Torrent', 'Leftovers', 'Modest', { hp: 252, spa: 252 }, ['Moonblast', 'Hydro Pump', 'Ice Beam', 'Protect']),
  ] },

  // 164 SpA / 151 Spe special breaker that HALVES contact damage taken — the
  // specific reason to check our contact-heavy priority (Kingambit Sucker Punch,
  // Talonflame Brave Bird, Meowscarada Flower Trick) against this team.
  { anchor: 'Mega Lucario Z (Aura Guard)', sets: [
    S('Lucario', 'Inner Focus', 'Lucarionite Z', 'Timid', { spa: 252, spd: 4, spe: 252 }, ['Aura Sphere', 'Flash Cannon', 'Dark Pulse', 'Protect']),
    inc('Sitrus Berry'),
    whim('Focus Sash'),
    chompScarf,
    S('Dragapult', 'Clear Body', 'Life Orb', 'Jolly', { atk: 252, spe: 252 }, ['Dragon Darts', 'Phantom Force', 'U-turn', 'Sucker Punch']),
    S('Garganacl', 'Purifying Salt', 'Leftovers', 'Careful', { hp: 252, spd: 252 }, ['Salt Cure', 'Recover', 'Protect', 'Wide Guard']),
  ] },

  // Levitate mono-Dragon: 141 SpA, immune to Ground AND to grounded hazards.
  // Garchomp is the anchor here, so no Scarf Garchomp in this team.
  { anchor: 'Mega Garchomp Z (Levitate)', sets: [
    S('Garchomp', 'Rough Skin', 'Garchompite Z', 'Modest', { spa: 252, spd: 4, spe: 252 }, ['Draco Meteor', 'Earth Power', 'Flamethrower', 'Protect']),
    inc('Sitrus Berry'),
    whim('Focus Sash'),
    S('Archaludon', 'Stamina', 'Leftovers', 'Modest', { hp: 124, spa: 252, spe: 132 }, ['Electro Shot', 'Flash Cannon', 'Dragon Pulse', 'Body Press']),
    S('Kingambit', 'Supreme Overlord', 'Muscle Band', 'Adamant', { hp: 252, atk: 252 }, ['Sucker Punch', 'Kowtow Cleave', 'Iron Head', 'Protect']),
    S('Gholdengo', 'Good as Gold', 'Life Orb', 'Modest', { spa: 252, spe: 252 }, ['Make It Rain', 'Shadow Ball', 'Power Gem', 'Protect']),
  ] },

  // Sharpness on a 154 Atk / 151 Spe Dark/Ghost frame: Night Slash and Psycho
  // Cut are both x1.5. Sucker Punch is NOT a slicing move — it stays the
  // priority option, unboosted.
  { anchor: 'Mega Absol Z (Sharpness)', sets: [
    S('Absol', 'Super Luck', 'Absolite Z', 'Jolly', { atk: 252, spd: 4, spe: 252 }, ['Night Slash', 'Psycho Cut', 'Sucker Punch', 'Protect']),
    inc('Sitrus Berry'),
    whim('Focus Sash'),
    chompScarf,
    S('Gholdengo', 'Good as Gold', 'Life Orb', 'Modest', { spa: 252, spe: 252 }, ['Make It Rain', 'Shadow Ball', 'Power Gem', 'Protect']),
    S('Primarina', 'Torrent', 'Leftovers', 'Modest', { hp: 252, spa: 252 }, ['Moonblast', 'Hydro Pump', 'Ice Beam', 'Protect']),
  ] },

  // 175 Atk under Trick Room. PROVISIONAL ability (Thermal Exchange is the base
  // forme's placeholder) — the spread and moves are the durable part.
  { anchor: 'Mega Baxcalibur (Trick Room)', sets: [
    S('Baxcalibur', 'Thermal Exchange', 'Baxcalibrite', 'Brave', { hp: 252, atk: 252, def: 4 }, ['Glaive Rush', 'Icicle Crash', 'Earthquake', 'Protect']),
    farigirafTR,
    inc('Sitrus Berry'),
    S('Kingambit', 'Supreme Overlord', 'Muscle Band', 'Brave', { hp: 252, atk: 252 }, ['Sucker Punch', 'Kowtow Cleave', 'Iron Head', 'Protect']),
    S('Sinistcha', 'Hospitality', 'Focus Sash', 'Quiet', { hp: 252, spa: 252 }, ['Matcha Gotcha', 'Rage Powder', 'Trick Room', 'Life Dew']),
    S('Gholdengo', 'Good as Gold', 'Life Orb', 'Quiet', { hp: 252, spa: 252 }, ['Make It Rain', 'Shadow Ball', 'Power Gem', 'Protect']),
  ] },

  // Bug/Steel, 175 Def / 120 SpD / 40 Spe — a Trick Room wall with a 4x Fire
  // weakness. PROVISIONAL ability (Emergency Exit is the base forme's
  // placeholder, and would be self-defeating on a mega — expect it to change).
  { anchor: 'Mega Golisopod (Trick Room wall)', sets: [
    S('Golisopod', 'Emergency Exit', 'Golisopite', 'Brave', { hp: 252, atk: 252, def: 4 }, ['First Impression', 'Liquidation', 'Knock Off', 'Protect']),
    farigirafTR,
    inc('Sitrus Berry'),
    S('Hatterene', 'Magic Bounce', 'Focus Sash', 'Quiet', { hp: 252, spa: 252 }, ['Trick Room', 'Dazzling Gleam', 'Psychic', 'Protect']),
    S('Kingambit', 'Supreme Overlord', 'Muscle Band', 'Brave', { hp: 252, atk: 252 }, ['Sucker Punch', 'Kowtow Cleave', 'Iron Head', 'Protect']),
    S('Gholdengo', 'Good as Gold', 'Life Orb', 'Quiet', { hp: 252, spa: 252 }, ['Make It Rain', 'Shadow Ball', 'Power Gem', 'Protect']),
  ] },

  // The non-mega headline. Grassy Surge + priority Grassy Glide is the direct
  // answer to the M-B rain core: Grassy Terrain boosts Grass moves, halves
  // Earthquake, and heals every grounded mon each turn. Mega Swampert holds the
  // stone so the team still has a mega, but Rillaboom is the reason it works.
  { anchor: 'Rillaboom (Grassy Surge) + Mega Swampert', sets: [
    S('Rillaboom', 'Grassy Surge', 'Miracle Seed', 'Adamant', { hp: 252, atk: 252, def: 4 }, ['Grassy Glide', 'Wood Hammer', 'Fake Out', 'U-turn']),
    S('Swampert', 'Torrent', 'Swampertite', 'Adamant', { hp: 4, atk: 252, spe: 252 }, ['Liquidation', 'Earthquake', 'Ice Punch', 'Protect']),
    inc('Sitrus Berry'),
    whim('Focus Sash'),
    chompScarf,
    S('Talonflame', 'Gale Wings', 'Sharp Beak', 'Jolly', { atk: 252, spe: 252 }, ['Brave Bird', 'Tailwind', 'Will-O-Wisp', 'Protect']),
  ] },
];

/** The full Reg M-C hand gauntlet: M-B's archetypes (all still legal) plus the
 *  M-C additions. Use this from Sept 8, 2026 — `MB_THREATS` alone under-samples
 *  the field by exactly the six new megas and Rillaboom. */
export const ALL_THREATS: { anchor: string; sets: PokemonSet[] }[] = [...MB_THREATS, ...MC_THREATS];
