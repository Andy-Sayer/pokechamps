// Explore swapping a NEW Reg M-B mega into the team's mega slot (replacing the
// current mega), scored against the gauntlet. For fun / off-meta hunting.
//
//   NODE_OPTIONS=--max-old-space-size=8192 \
//     npx tsx packages/core/src/scripts/mb-explore-megas.ts [team.json]
//
// CAVEAT: the 5 CANONICAL megas (Sceptile/Blaziken/Swampert/Mawile/Metagross)
// have real abilities the calc knows → trustworthy. The INVENTED megas carry
// PLACEHOLDER abilities in our data (Eelevate/Fire Mane named, effects NOT
// emulated), so their scores are approximate — their real custom ability could
// swing things once it's published + emulated.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId, getItem } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { MatchupPool } from '../domain/matchupPool.js';
import { detectTactics, profileFromSet } from '../domain/tactics.js';
import type { Matchup } from '../domain/teamSim.js';
import type { PokemonSet, Stats } from '../domain/types.js';
import { MAX_IVS } from '../domain/types.js';
import { MB_THREATS } from './mbThreats.js';

const argNum = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const DEPTH = argNum('--depth', 5);
const BUDGET = argNum('--budget', 15000);
const teamFile = process.argv.slice(2).find(a => a.endsWith('.json')) ?? 'anti-meta-mb.json';

const E = (p: Partial<Stats>): Stats => ({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...p });
const mk = (species: string, ability: string, item: string, nature: string, evs: Stats, moves: string[]): PokemonSet =>
  ({ species, level: 50, nature, ability, item, evs, ivs: { ...MAX_IVS }, moves });

// Candidate megas (base species + stone; the gimmick resolves the forme/ability).
// `canon` = calc-correct ability; otherwise placeholder (approximate).
const CANDIDATES: { label: string; canon: boolean; odd: string; set: PokemonSet }[] = [
  { label: 'Mega Swampert', canon: true, odd: 'Swift Swim — RAIN synergy w/ Pelipper', set: mk('Swampert', 'Torrent', 'Swampertite', 'Adamant', E({ atk: 252, hp: 4, spe: 252 }), ['Liquidation', 'Earthquake', 'Ice Punch', 'Protect']) },
  { label: 'Mega Sceptile', canon: true, odd: 'Lightning Rod fast special Grass/Dragon', set: mk('Sceptile', 'Overgrow', 'Sceptilite', 'Timid', E({ spa: 252, hp: 4, spe: 252 }), ['Leaf Storm', 'Dragon Pulse', 'Giga Drain', 'Protect']) },
  { label: 'Mega Blaziken', canon: true, odd: 'Speed Boost snowball', set: mk('Blaziken', 'Blaze', 'Blazikenite', 'Adamant', E({ atk: 252, hp: 4, spe: 252 }), ['Flare Blitz', 'Close Combat', 'Knock Off', 'Protect']) },
  { label: 'Mega Pyroar', canon: true, odd: 'Fire Mane EMULATED — Fire moves ×1.5', set: mk('Pyroar', 'Unnerve', 'Pyroarite', 'Modest', E({ spa: 252, hp: 4, spe: 252 }), ['Hyper Voice', 'Flamethrower', 'Dark Pulse', 'Protect']) },
  { label: 'Mega Malamar', canon: false, odd: 'Contrary? Superpower setup (placeholder)', set: mk('Malamar', 'Contrary', 'Malamarite', 'Adamant', E({ atk: 252, hp: 252 }), ['Superpower', 'Psycho Cut', 'Knock Off', 'Protect']) },
  { label: 'Mega Eelektross', canon: false, odd: 'Eelevate — Ground immunity emulated (Beast Boost not)', set: mk('Eelektross', 'Levitate', 'Eelektrossite', 'Modest', E({ spa: 252, hp: 4, spe: 252 }), ['Thunderbolt', 'Flamethrower', 'Giga Drain', 'Protect']) },
  { label: 'Mega Barbaracle', canon: false, odd: 'Shell Smash sweeper (placeholder ability)', set: mk('Barbaracle', 'Tough Claws', 'Barbaracite', 'Adamant', E({ atk: 252, hp: 4, spe: 252 }), ['Shell Smash', 'Stone Edge', 'Razor Shell', 'Protect']) },
  { label: 'Mega Scrafty', canon: false, odd: 'Dragon Dance Dark/Fighting (placeholder)', set: mk('Scrafty', 'Intimidate', 'Scraftinite', 'Adamant', E({ atk: 252, hp: 252 }), ['Dragon Dance', 'Drain Punch', 'Knock Off', 'Protect']) },
  { label: 'Mega Dragalge', canon: false, odd: 'Poison/Dragon special wall-breaker (placeholder)', set: mk('Dragalge', 'Adaptability', 'Dragalgite', 'Modest', E({ spa: 252, hp: 252 }), ['Draco Meteor', 'Sludge Bomb', 'Flip Turn', 'Protect']) },
];

// --keep: demote the current mega holder to a non-mega item and try the new mega
// in a PHYSICAL seat instead (keep the special/rain linchpin). Protected seats
// (rain setter + the Metagross answer + the demoted special attacker) are never
// replaced; everything else is a candidate seat.
const KEEP = process.argv.includes('--keep');
const PROTECTED = new Set(['pelipper', 'rotomwash', 'dragonite']);
const DEMOTE_ITEM = 'Life Orb';

const team: PokemonSet[] = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', teamFile), 'utf8'));
const megaSlot = team.findIndex(s => !!(getItem(s.item ?? '') as { megaStone?: unknown } | undefined)?.megaStone);
if (megaSlot < 0) { console.error('no mega slot found'); process.exit(1); }
const otherItems = new Set(team.filter((_, i) => i !== megaSlot).map(s => toId(s.item ?? '')));

const pika = loadPikaData();
const gauntlet = [
  ...metaTeams(pika, argNum('--meta', 8), 3).map(m => ({ anchor: `[M-A] ${m.anchor}`, sets: m.sets })),
  ...MB_THREATS.map(m => ({ anchor: `[M-B] ${m.anchor}`, sets: m.sets })),
];
const pool = new MatchupPool();
interface Fit { floor: number; avg: number; flex: number }
const fitOf = (ms: Matchup[]): Fit => ({ floor: Math.min(...ms.map(m => m.score)), avg: ms.reduce((s, m) => s + m.score, 0) / ms.length, flex: new Set(ms.flatMap(m => m.myBring)).size });
const evalTeam = async (t: PokemonSet[]): Promise<Fit> => fitOf(await pool.run(gauntlet.map(g => ({ mine: t, oppSets: g.sets, oppAnchor: g.anchor, depth: DEPTH, budgetMs: BUDGET }))));

// In KEEP mode the new mega goes into a physical seat and the old mega holder is
// demoted; otherwise it just replaces the mega slot.
const baseTeam = KEEP ? team.map((s, i) => (i === megaSlot ? { ...s, item: DEMOTE_ITEM } : s)) : team;
const seats = KEEP ? team.map((_, i) => i).filter(i => i !== megaSlot && !PROTECTED.has(toId(team[i]!.species))) : [megaSlot];

console.log(KEEP
  ? `KEEP: ${team[megaSlot]!.species}→${DEMOTE_ITEM}; new mega tried in seats [${seats.map(i => team[i]!.species).join(', ')}]`
  : `swapping the ${team[megaSlot]!.species} mega slot`);
console.log(`· ${gauntlet.length} boards · deepen 1→${DEPTH} @ ${BUDGET / 1000}s`);
const base = await evalTeam(team);
console.log(`current saved team: floor ${Math.round(base.floor)} avg ${Math.round(base.avg)} flex ${base.flex}\n`);

const rows: { label: string; canon: boolean; odd: string; fit: Fit; seat: string; combos: string[] }[] = [];
for (const c of CANDIDATES) {
  let best: { fit: Fit; seat: number; trial: PokemonSet[] } | null = null;
  for (const seat of seats) {
    const others = baseTeam.filter((_, i) => i !== seat).map(s => toId(s.item ?? ''));
    if (others.includes(toId(c.set.item ?? ''))) continue;     // stone clash
    const trial = baseTeam.map((s, i) => (i === seat ? c.set : s));
    const fit = await evalTeam(trial);
    if (!best || fit.floor > best.fit.floor || (fit.floor === best.fit.floor && fit.avg > best.fit.avg)) best = { fit, seat, trial };
  }
  if (!best) { console.log(`  ${c.label}: skip (item clash)`); continue; }
  const combos = detectTactics(best.trial.map(profileFromSet)).slice(0, 3).map(t => t.name);
  rows.push({ ...c, fit: best.fit, seat: team[best.seat]!.species, combos });
  console.log(`  ${c.label.padEnd(16)} ${c.canon ? 'calc✓' : 'custom~'}  floor ${String(Math.round(best.fit.floor)).padStart(5)} avg ${String(Math.round(best.fit.avg)).padStart(4)}${KEEP ? ` over ${team[best.seat]!.species}` : ''}   ${c.odd}`);
}

rows.sort((a, b) => (a.fit.floor !== b.fit.floor ? b.fit.floor - a.fit.floor : b.fit.avg - a.fit.avg));
console.log(`\n=== ranked (vs current floor ${Math.round(base.floor)} / avg ${Math.round(base.avg)}) ===`);
for (const r of rows) {
  const verdict = r.fit.floor >= base.floor - 50 ? (r.fit.floor >= base.floor ? 'HOLDS' : 'close') : 'drops';
  console.log(`  ${r.label.padEnd(16)} ${r.canon ? 'trust ' : 'approx'} floor ${String(Math.round(r.fit.floor)).padStart(5)} avg ${String(Math.round(r.fit.avg)).padStart(4)}  ${verdict}${KEEP ? ` (over ${r.seat})` : ''}  · ${r.combos.join(', ') || '—'}`);
}
pool.close();
