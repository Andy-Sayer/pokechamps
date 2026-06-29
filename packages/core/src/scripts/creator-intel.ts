// Creator-intel driver (LLM-free). From a creator video's CAPTIONS (fetch first
// with fetch-captions.ts) or a confirmed --species list, build a gauntlet-ready
// OPPONENT threat team and save it to data/threats/<name>.json — a leading-meta
// threat to tune/test our team against (mb-team-check picks these up via
// loadCreatorThreats). Transcript extraction over-collects (it's a candidate
// list); pass --species to pin the confirmed 6.
//   npx tsx packages/core/src/scripts/creator-intel.ts --name <label> [--vtt <file>] [--species "A,B,C,D,E,F"]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { parseVtt, extractMentionedSpecies, buildThreatTeam } from '../domain/creatorIntel.js';

const argv = process.argv;
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const name = opt('--name') ?? 'creator';
const vttPath = opt('--vtt');
const speciesArg = opt('--species');

let species: string[] = [];
if (vttPath) {
  const text = parseVtt(readFileSync(vttPath, 'utf8'));
  const mentioned = extractMentionedSpecies(text);
  console.log(`transcript: ${text.length} chars · ${mentioned.length} legal species mentioned`);
  console.log('top mentions: ' + mentioned.slice(0, 12).map(m => `${m.species}(${m.count})`).join(', '));
  species = mentioned.slice(0, 6).map(m => m.species); // rough heuristic; confirm with --species
  console.log(`\n⚠ using the 6 most-mentioned as a ROUGH team guess — pass --species to pin the confirmed 6\n`);
}
if (speciesArg) species = speciesArg.split(',').map(s => s.trim()).filter(Boolean);
if (!species.length) { console.error('need --vtt <captions> or --species "A,B,C,D,E,F"'); process.exit(1); }

const res = buildThreatTeam(species, name);
if ('error' in res) { console.error(`✗ ${res.error}`); process.exit(1); }
const t = res.team;
console.log(`threat team "${t.anchor}": ${t.sets.map(s => `${s.species}@${s.item || '-'}`).join(', ')}`);

const outDir = join(dataDirPath(), 'threats'); mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${name.replace(/[^a-z0-9-]/gi, '_')}.json`);
writeFileSync(outPath, JSON.stringify(t, null, 2));
console.log(`\nsaved → ${outPath}  ·  add to the gauntlet via loadCreatorThreats() (tag [creator])`);
