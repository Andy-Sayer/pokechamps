// Synthesizes a demo team from cached Pikalytics data so we always have a
// known-good PokemonSet[] to load into the TUI (useful for rendering /
// inference smoke tests). Picks the top-used mon plus its 5 most popular
// teammates — all of which are in our top-10 cache today, so every set is
// built from real consensus data rather than placeholder defaults.
//
// Run with: npm run demo-team
import { getPikalytics, evFromSp } from '../domain/pikalytics.js';
import { saveTeam } from '../domain/storage.js';
import type { PokemonSet, Stats } from '../domain/types.js';

const ALL_31_IVS: Stats = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };

const ANCHOR_SPECIES = 'Sneasler';
const TEAM_NAME = 'demo';

function setFromPikalytics(species: string): PokemonSet | null {
  const pik = getPikalytics(species);
  if (!pik) return null;
  // Skip "Other" rollups when picking the top item / ability.
  const topItem = pik.items.find(i => i.name.toLowerCase() !== 'other');
  const topAbility = pik.abilities.find(a => a.name.toLowerCase() !== 'other');
  const topMoves = pik.moves
    .filter(m => m.name.toLowerCase() !== 'other')
    .slice(0, 4)
    .map(m => m.name);
  const spread = pik.topSpread;
  const evs: Stats = spread
    ? {
        hp: evFromSp(spread.sp[0]),
        atk: evFromSp(spread.sp[1]),
        def: evFromSp(spread.sp[2]),
        spa: evFromSp(spread.sp[3]),
        spd: evFromSp(spread.sp[4]),
        spe: evFromSp(spread.sp[5]),
      }
    : { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  return {
    species,
    level: 50,
    item: topItem?.name,
    ability: topAbility?.name,
    nature: spread?.nature ?? 'Hardy',
    evs,
    ivs: ALL_31_IVS,
    moves: topMoves,
  };
}

function main() {
  const anchor = getPikalytics(ANCHOR_SPECIES);
  if (!anchor) {
    console.error(`No Pikalytics data for ${ANCHOR_SPECIES}. Run \`npm run refresh-pikalytics\` first.`);
    process.exit(1);
  }
  const teammates = anchor.teammates
    .filter(t => t.name.toLowerCase() !== 'other')
    .slice(0, 5)
    .map(t => t.name);
  const speciesList = [ANCHOR_SPECIES, ...teammates];

  const team: PokemonSet[] = [];
  const missing: string[] = [];
  for (const sp of speciesList) {
    const set = setFromPikalytics(sp);
    if (set) team.push(set);
    else missing.push(sp);
  }
  if (missing.length) {
    console.warn(`No Pikalytics entry for: ${missing.join(', ')} — these were skipped.`);
  }
  if (team.length === 0) {
    console.error('Could not synthesize any sets.');
    process.exit(1);
  }
  const path = saveTeam(TEAM_NAME, team);
  console.log(`Wrote ${team.length}-mon demo team to ${path}`);
  for (const s of team) {
    console.log(`  ${s.species} @ ${s.item ?? '(no item)'} — ${s.ability} — ${s.nature}`);
    console.log(`    EVs ${s.evs.hp}/${s.evs.atk}/${s.evs.def}/${s.evs.spa}/${s.evs.spd}/${s.evs.spe}`);
    console.log(`    Moves: ${s.moves.join(', ')}`);
  }
}

main();
