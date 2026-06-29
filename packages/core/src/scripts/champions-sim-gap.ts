// Enumerate the EXACT Champions-mega coverage gap in the installed @pkmn/sim:
// for every Champions-legal mega stone, does the sim know the forme? (Abilities
// are confirmed complete after 0.10.11: Eelevate + Fire Mane.) Prints the formes
// the sim still lacks — the only thing a tiny local mod would need until upstream
// finishes staging Champions content.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSimLoaded, simHasSpecies } from '../domain/simBridge.js';
import { dataDirPath } from '../domain/data.js';
import { Dex } from '@pkmn/dex';

await ensureSimLoaded();
const dex = Dex.forGen(9).includeData();
const fmt = JSON.parse(readFileSync(join(dataDirPath(), 'format.champions.json'), 'utf8')) as { items: { allow: string[] } };
const legalItems: string[] = fmt.items.allow;

const megas: { stone: string; forme: string }[] = [];
for (const name of legalItems) {
  const it = dex.items.get(name) as unknown as { megaStone?: Record<string, string> };
  if (it?.megaStone) for (const forme of Object.values(it.megaStone)) megas.push({ stone: name, forme });
}
megas.sort((a, b) => a.forme.localeCompare(b.forme));

const missing = megas.filter(m => !simHasSpecies(m.forme));
console.log(`Champions-legal mega stones: ${megas.length}  ·  sim knows the forme for ${megas.length - missing.length}  ·  MISSING ${missing.length}`);
console.log('\nMISSING formes (sim lacks these — would need a local mod):');
for (const m of missing) console.log(`  ${m.forme.padEnd(22)} (stone: ${m.stone})`);
