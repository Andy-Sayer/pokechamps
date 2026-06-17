// Reg M-B team stress-test. There is NO M-B usage data yet, so the gauntlet is
// the M-A Pikalytics meta (most of it carries forward) PLUS a hand-built set of
// M-B threat teams built around the strong, calc-correct new megas/species
// (Mega Mawile / Metagross / Swampert / Raichu-X + Gholdengo / Annihilape).
// These threat teams are a BEST-GUESS meta, not real usage — they exist to
// surface M-B-specific holes, not to optimise against a known field.
//
//   npx tsx packages/core/src/scripts/mb-team-check.ts [team.json] [--depth N] [--meta N]
//
// Reports each matchup's maximin score (under mutual best play; + favors us),
// the floor + average over the M-A gauntlet and over the M-B threats separately.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { MatchupPool } from '../domain/matchupPool.js';
import type { PokemonSet, Stats } from '../domain/types.js';
import { MAX_IVS } from '../domain/types.js';

const argNum = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const DEPTH = argNum('--depth', 5);
const META_N = argNum('--meta', 8);
// Budgeted anytime deepening (1→DEPTH under a per-board wall-clock cap) matches
// how the validated baseline was scored. This momentum team (rain + double
// Tailwind) is badly under-rated at a shallow FIXED depth — its payoff sits near
// the horizon (depth 3 read it ~-1000, depth 5 ~+20). 0 disables (fixed depth).
const BUDGET = argNum('--budget', 20000);
const teamArg = process.argv.slice(2).find(a => a.endsWith('.json'));
const teamPath = teamArg ? (teamArg.includes('/') || teamArg.includes('\\') ? teamArg : join(dataDirPath(), 'my-teams', teamArg))
  : join(dataDirPath(), 'my-teams', 'anti-meta.json');

// Compact set builder: EVs default to 0, only the named stats are set.
function S(species: string, ability: string, item: string, nature: string, evs: Partial<Stats>, moves: string[]): PokemonSet {
  return { species, level: 50, nature, ability, item: item || undefined,
    evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...evs }, ivs: { ...MAX_IVS }, moves };
}
const inc = (item: string) => S('Incineroar', 'Intimidate', item, 'Careful', { hp: 252, atk: 4, spd: 252 }, ['Fake Out', 'Flare Blitz', 'Knock Off', 'Parting Shot']);
const whim = (item: string, m4 = 'Light Screen') => S('Whimsicott', 'Prankster', item, 'Timid', { spa: 252, spe: 252 }, ['Moonblast', 'Tailwind', 'Encore', m4]);
const chompScarf = S('Garchomp', 'Rough Skin', 'Choice Scarf', 'Jolly', { atk: 252, spe: 252 }, ['Earthquake', 'Rock Slide', 'Dragon Claw', 'Stomping Tantrum']);

// --- M-B threat teams (best-guess; 1 mega each, unique items) ---------------
const MB_THREATS: { anchor: string; sets: PokemonSet[] }[] = [
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

const team: PokemonSet[] = JSON.parse(readFileSync(teamPath, 'utf8'));
const pika = loadPikaData();
const metaA = metaTeams(pika, META_N, 3);
const gauntlet = [
  ...metaA.map(m => ({ anchor: `[M-A] ${m.anchor}`, sets: m.sets })),
  ...MB_THREATS.map(m => ({ anchor: `[M-B] ${m.anchor}`, sets: m.sets })),
];

console.log(`team: ${teamPath.split(/[\\/]/).pop()} — ${team.map(s => s.species).join(', ')}`);
console.log(`gauntlet: ${metaA.length} M-A meta teams + ${MB_THREATS.length} M-B threat teams · deepen 1→${DEPTH}${BUDGET ? ` · ${BUDGET / 1000}s/board` : ' (fixed)'}\n`);

const pool = new MatchupPool();
const results = await pool.run(gauntlet.map(g => ({ mine: team, oppSets: g.sets, oppAnchor: g.anchor, depth: DEPTH, budgetMs: BUDGET || undefined })));
pool.close();

const rows = gauntlet.map((g, i) => ({ anchor: g.anchor, score: results[i]!.score, verdict: results[i]!.verdict, bring: results[i]!.myBring }));
rows.sort((a, b) => a.score - b.score);
for (const r of rows) {
  console.log(`  ${r.anchor.padEnd(28)} ${String(Math.round(r.score)).padStart(6)}  ${r.verdict.padEnd(7)}  bring: ${r.bring.join(', ')}`);
}
const stat = (xs: number[]) => ({ floor: Math.min(...xs), avg: Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) });
const mbScores = rows.filter(r => r.anchor.startsWith('[M-B]')).map(r => r.score);
const maScores = rows.filter(r => r.anchor.startsWith('[M-A]')).map(r => r.score);
const all = stat(rows.map(r => r.score));
console.log(`\nM-A  floor ${Math.round(stat(maScores).floor)}  avg ${stat(maScores).avg}`);
console.log(`M-B  floor ${Math.round(stat(mbScores).floor)}  avg ${stat(mbScores).avg}`);
console.log(`ALL  floor ${Math.round(all.floor)}  avg ${all.avg}`);
