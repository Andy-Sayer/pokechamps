// Live bring lookup — the preview-time "what do I bring?" CLI. Thin wrapper over the
// shared domain/bringRecommend: the sim-derived Nash bring (exact for a known gauntlet
// team, else role-aware closest, flagged) + a dossier THREATS read for the faced 6
// (roles + which of their mons hits YOUR bring super-effectively). Instant — fits the
// ~90s preview clock; the exact matrix is a scout-ahead job. The TUI preview screen
// uses the same bringNash/bringThreats functions.
//   npx tsx packages/core/src/scripts/bring-lookup.ts [team.json] "<anchor | Sp1,Sp2,...>"
import { bringNash, bringThreats } from '../domain/bringRecommend.js';

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const TEAM = positional.find(a => a.endsWith('.json')) ?? 'anti-meta-mb.json';
const teamSlug = TEAM.replace(/\.json$/, '');
const OPP = positional.find(a => !a.endsWith('.json')) ?? '';
if (!OPP) { console.error('usage: bring-lookup.ts [team.json] "<anchor | Sp1,Sp2,...>"'); process.exit(1); }

const pct = (x: number) => `${Math.round(x * 100)}%`;
const oppInput = OPP.includes(',') ? OPP.split(',').map(s => s.trim()) : [OPP];
const nash = bringNash(teamSlug, oppInput);
if (!nash) { console.error(`no matrix corpus for ${teamSlug} (run: bring-matrix ${TEAM}), or no opponent match for "${OPP}".`); process.exit(1); }

// Threats are about the ACTUAL faced 6: the comma-list as typed, else the matched anchor's 6.
const facedSpecies = OPP.includes(',') ? oppInput : nash.faced;
const myBring = nash.maximinBring;

console.log(`${teamSlug} vs ${nash.anchor}  (${nash.exact ? 'exact match' : 'NOVEL → closest by role'})`);
console.log(`  matchup value (Nash): ${pct(nash.value)}   ·   single safest bring (maximin): ${pct(nash.maximinValue)} — ${myBring.join('/')}`);
console.log(`  BRING (Nash mix — vary across games):`);
nash.mix.forEach(x => console.log(`    ${pct(x.p).padStart(4)}  ${x.bring.join('/')}`));

console.log(`\n  THREATS vs your safest bring (${myBring.join('/')}):`);
for (const t of bringThreats(facedSpecies, myBring)) {
  if (!t.known) { console.log(`    ? ${t.species.padEnd(15)} unknown species (not in dossier)`); continue; }
  const novel = !nash.faced.map(s => s.toLowerCase()).includes(t.species.toLowerCase());
  const flag = t.se ? '⚠' : novel ? '?' : ' ';
  const se = t.se ? `${t.se.mult}× ${t.se.type}→${t.se.target}` : '';
  console.log(`    ${flag} ${t.species.padEnd(15)} ${se.padEnd(20)} {${t.roles.join(',') || 'attacker'}}${novel ? '  [novel]' : ''}${t.inferred ? '  (inferred moves)' : ''}`);
}
if (nash.exact) console.log(`  confidence: EXACT — this opponent is in the gauntlet.`);
else {
  console.log(`  confidence: APPROXIMATE — borrowed from ${nash.anchor}.`);
  if (nash.noAnalog.length) console.log(`    ⚠ no safe analog for: ${nash.noAnalog.join(', ')} — treat with caution; scout it: bring-matrix ${TEAM} "${OPP}"`);
}
