// Scaffold a team JSON from a "Species:Item" list using Pikalytics featured sets
// for moves/spread/nature/ability, then override the item per spec. A STARTING
// POINT to confirm/edit against your real Showdown export — the movesets/EVs/
// natures come from meta usage, not your build.
//   npx tsx packages/core/src/scripts/scaffold-team.ts <outName> "Talonflame:, Pelipper:Damp Rock, Garchomp:Choice Scarf, Kingambit:Chople Berry, Dragonite:Dragoninite, Meowscarada:Focus Sash"
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, buildSet } from '../domain/metaTeams.js';
import type { PokemonSet } from '../domain/types.js';

const out = process.argv[2];
const spec = process.argv[3];
if (!out || !spec) { console.error('usage: scaffold-team.ts <outName> "Species:Item, Species:Item, ..."'); process.exit(1); }

const pika = loadPikaData();
const team: PokemonSet[] = [];
for (const pair of spec.split(',')) {
  const [sp, ...itemParts] = pair.split(':');
  const species = (sp ?? '').trim();
  const item = itemParts.join(':').trim(); // empty = itemless
  if (!species) continue;
  const set = buildSet(pika, species, new Set());
  if (!set) { console.error(`! no meta set for "${species}" (legal but no Pikalytics usage data) — needs your real set; skipping`); continue; }
  set.item = item || undefined; // override with the specified item (undefined = itemless)
  team.push(set);
}
const path = join(dataDirPath(), 'my-teams', `${out}.json`);
writeFileSync(path, JSON.stringify(team, null, 2) + '\n', 'utf8');
console.log(`scaffolded ${team.length} mons → data/my-teams/${out}.json`);
for (const s of team) console.log(`  ${s.species.padEnd(13)} ${(s.item ?? '(itemless)').padEnd(14)} ${s.ability?.padEnd(14)} ${s.nature?.padEnd(8)} ${s.moves.join(', ')}`);
