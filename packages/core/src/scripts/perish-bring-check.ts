// Does the BRING layer catch the perish trap at team preview, on the real board?
//   npx tsx packages/core/src/scripts/perish-bring-check.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { scoreBrings } from '../domain/bring.js';
import type { OpponentEntry, PokemonSet } from '../domain/types.js';

const team: PokemonSet[] = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', 'TalonFlameAndyBoy.json'), 'utf8'));
// Their preview six, exactly as the match snapshot recorded it.
const OPP = ['Archaludon', 'Blastoise', 'Pelipper', 'Gengar', 'Meowscarada', 'Incineroar'];
const opponent: OpponentEntry[] = OPP.map(species => ({ species, knownMoves: [], candidates: [] } as unknown as OpponentEntry));

const scores = scoreBrings(team, opponent);
const name = (i: number) => team[i]!.species;
const ACTUAL = ['Talonflame', 'Garchomp', 'Meowscarada', 'Dragonite'];

console.log('Opponent preview:', OPP.join(', '));
console.log('\n--- top 5 brings ---');
for (const s of scores.slice(0, 5)) {
  console.log(`  ${String(Math.round(s.total)).padStart(5)}  ${s.myIndices.map(name).join(', ')}`);
  for (const r of s.rationale.filter(r => /perish/i.test(r))) console.log(`          ${r}`);
}

const actual = scores.find(s => {
  const set = new Set(s.myIndices.map(name));
  return ACTUAL.every(n => set.has(n)) && set.size === 4;
});
console.log(`\n--- the bring I ACTUALLY made: ${ACTUAL.join(', ')} ---`);
console.log(`  rank ${scores.indexOf(actual!) + 1}/${scores.length}, score ${Math.round(actual!.total)}`);
for (const r of actual!.rationale.filter(r => /perish|answer/i.test(r))) console.log(`  ${r}`);

console.log('\n--- how every bring is judged on the perish threat ---');
const tally = { none: 0, thin: 0, covered: 0 };
for (const s of scores) {
  const line = s.rationale.find(r => /perish/i.test(r)) ?? '';
  if (/ONLY ONE/.test(line)) tally.thin++;
  else if (/No answer/.test(line)) tally.none++;
  else if (/Covers/.test(line)) tally.covered++;
}
console.log(`  covered (2+ answers): ${tally.covered}   THIN (1 answer, deniable): ${tally.thin}   none: ${tally.none}`);

// --- and WHICH TWO to lead -------------------------------------------------
import { leadAdvice } from '../domain/bring.js';
const best = scores[0]!;
const advice = leadAdvice(best.myIndices.map(i => team[i]!), opponent);
console.log('\n--- lead advice for the top bring ---');
if (!advice) console.log('  (no perish threat, or they cannot deny a turn — lead normally)');
else {
  console.log(`  LEAD: ${advice.lead.join(' + ')}`);
  console.log(`  HOLD: ${advice.hold.join(', ')}`);
  for (const r of advice.reasons) console.log(`  · ${r}`);
}
