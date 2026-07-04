// Bake the per-mon dossier (data/mon-dossier.<format>.json) — base stats, types,
// ability, orientation, role tags, and a likely moveset for every legal species +
// legal mega forme. Moves are Pikalytics ≥25% usage where we have it (authoritative),
// else inferred. Re-run after `npm run refresh-pikalytics` so the meta core stays current.
//   npm run build-dossier
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, CHAMPIONS_PIKA_FORMAT } from '../domain/data.js';
import { buildDossier } from '../domain/monDossier.js';

const dossier = buildDossier();
const path = join(dataDirPath(), `mon-dossier.${CHAMPIONS_PIKA_FORMAT}.json`);
writeFileSync(path, JSON.stringify(dossier, null, 0) + '\n', 'utf8');

const usage = dossier.filter(d => d.moveSource === 'usage').length;
const megas = dossier.filter(d => d.forme).length;
console.log(`built ${dossier.length} entries (${megas} mega formes) → data/mon-dossier.${CHAMPIONS_PIKA_FORMAT}.json`);
console.log(`  move source: ${usage} usage-backed · ${dossier.length - usage} inferred`);
// Sample a spread so the output can be eyeballed.
const show = ['Charizard-Mega-Y', 'Incineroar', 'Whimsicott', 'Gardevoir', 'Torkoal', 'Mamoswine', 'Volcarona', 'Amoonguss'];
console.log('\nsample:');
for (const label of show) {
  const e = dossier.find(d => d.label === label);
  if (!e) { console.log(`  ${label}: (n/a)`); continue; }
  console.log(`  ${e.label.padEnd(17)} [${e.types.join('/')}] ${e.orientation.padEnd(8)} {${e.roles.join(',') || 'attacker'}} (${e.moveSource})`);
  console.log(`      ${e.moves.join(', ')}`);
}
