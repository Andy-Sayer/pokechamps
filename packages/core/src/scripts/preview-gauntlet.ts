// Preview the opponent gauntlet bring-matrix fights — the hand-built anti-meta
// threats (mbThreats.ts) + the GROUNDED real teams reconstructed from Pikalytics
// featured teams (records-weighted). Eyeball "what we go against" before a long run.
//   npm run preview-gauntlet [-- --minCore N]
import { loadPikaData, groundedTeams } from '../domain/metaTeams.js';
import { MB_THREATS } from './mbThreats.js';

const arg = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const minCore = arg('--minCore', 4);
const pika = loadPikaData();
const grounded = groundedTeams(pika, { minCore });

console.log(`GAUNTLET = ${MB_THREATS.length} hand threats + ${grounded.length} grounded real teams (minCore=${minCore})\n`);
console.log('hand-built anti-meta threats:');
for (const t of MB_THREATS) console.log(`  ${t.anchor.padEnd(26)} ${t.sets.map(s => s.species).join('/')}`);
console.log('\ngrounded real teams (record · #real mons · headline · team):');
for (const t of grounded) console.log(`  ${t.record.padStart(5)} · ${t.core} real · ${t.anchor.split(' [')[0]!.padEnd(13)} ${t.sets.map(s => s.species).join('/')}`);
process.exit(0);
