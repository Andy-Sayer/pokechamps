// Lightweight (no-sim) legality + sanity check for candidate teams. Reg M-B:
// item + species clauses ON, exactly one Mega per team. Validates each team file
// in data/my-teams against the Champions allow-lists and flags build errors
// (illegal species/item, duplicate items/species, multiple megas, a mega stone
// that doesn't match its holder). Use before investing gauntlet time in a team.
//   npx tsx packages/core/src/scripts/check-teams-legal.ts [team1 team2 ...]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, isLegalSpecies, isLegalItem, getItem, toId } from '../domain/data.js';
import type { PokemonSet } from '../domain/types.js';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const teams = args.length ? args.map(a => a.replace(/\.json$/, '')) : [
  'anti-meta-mb', 'upgrade-4-basculegion', 'upgrade-5-incineroar', 'upgrade-6-kingambit',
  'fairy-aura-mb', 'rain-mb', 'tr-start', 'hc-current',
];

// This dex stores megaStone as a base-id -> mega-forme-name map (custom megas).
const megaStoneOf = (item?: string): Record<string, string> | string | null => {
  if (!item) return null;
  const it = getItem(item) as { megaStone?: Record<string, string> | string; megaEvolves?: string } | null;
  return it?.megaStone ?? null;
};

for (const name of teams) {
  const path = join(dataDirPath(), 'my-teams', name + '.json');
  if (!existsSync(path)) { console.log(`${name.padEnd(24)} MISSING`); continue; }
  let team: PokemonSet[];
  try { team = JSON.parse(readFileSync(path, 'utf8')); } catch { console.log(`${name.padEnd(24)} UNREADABLE JSON`); continue; }

  const issues: string[] = [];
  const species = team.map(m => m.species);
  const items = team.map(m => m.item).filter(Boolean) as string[];

  const dupSp = [...new Set(species.filter((s, i) => species.indexOf(s) !== i))];
  if (dupSp.length) issues.push(`dup species (species clause): ${dupSp.join(',')}`);
  const dupIt = [...new Set(items.filter((s, i) => items.indexOf(s) !== i))];
  if (dupIt.length) issues.push(`dup items (item clause): ${dupIt.join(',')}`);

  let megaCount = 0;
  for (const m of team) {
    if (!isLegalSpecies(toId(m.species))) issues.push(`illegal species: ${m.species}`);
    if (m.item && !isLegalItem(toId(m.item))) issues.push(`illegal item: ${m.item} (${m.species})`);
    const stone = megaStoneOf(m.item);
    if (stone) {
      megaCount++;
      const matches = typeof stone === 'object' ? Object.keys(stone).some(s => toId(s) === toId(m.species)) : true;
      if (!matches) issues.push(`${m.item} doesn't mega-evolve ${m.species}`);
    }
  }
  if (megaCount > 1) issues.push(`${megaCount} megas — violates one-mega-per-team`);
  if (megaCount === 0) issues.push('no mega (legal, but the format allows one — leaving value on the table)');

  console.log(`${name.padEnd(24)} mega:${megaCount}  ${issues.length ? 'FLAGS: ' + issues.join(' · ') : 'LEGAL ✓'}`);
}
