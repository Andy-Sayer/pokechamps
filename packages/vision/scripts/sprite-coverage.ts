// Sprite-ref coverage report: which species have a colour-hist ref vs which are still
// missing, prioritised by whether they actually appear (dossier moveSource='usage' =
// real meta). Drives which VODs to harvest next. Megas share the base-forme preview
// sprite, so only base species + regional formes are targets.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId, CHAMPIONS_PIKA_FORMAT } from '@pokechamps/core/domain/data.js';
import { loadDossier } from '@pokechamps/core/domain/monDossier.js';

const covered = new Set((JSON.parse(readFileSync(join(dataDirPath(), 'sprite-refs.json'), 'utf8')).refs as { name: string }[]).map(r => toId(r.name)));
const dossier = loadDossier();
const targets = dossier.filter(e => !e.forme); // base species + regional formes (mega = base sprite)

const meta = targets.filter(e => e.moveSource === 'usage');
const tail = targets.filter(e => e.moveSource === 'inferred' && !/-(Alola|Galar|Hisui|Paldea)/.test(e.label));
const regional = targets.filter(e => /-(Alola|Galar|Hisui|Paldea)/.test(e.label));
const miss = (list: typeof targets) => list.filter(e => !covered.has(toId(e.label)));

console.log(`sprite-refs: ${covered.size} · targets: ${targets.length} (${meta.length} meta / ${tail.length} long-tail / ${regional.length} regional)\n`);
console.log(`META (real usage) — ${meta.length - miss(meta).length}/${meta.length} covered. MISSING ${miss(meta).length} (harvest priority):`);
console.log('  ' + miss(meta).map(e => e.label).join(', '));
console.log(`\nREGIONAL — ${regional.length - miss(regional).length}/${regional.length}. MISSING:`);
console.log('  ' + (miss(regional).map(e => e.label).join(', ') || '(none)'));
console.log(`\nLONG-TAIL (inferred, low priority): ${miss(tail).length}/${tail.length} missing.`);
console.log(`\nHAVE: ${[...covered].sort().join(', ')}`);
process.exit(0);
