// Export a saved team for BUILDING. Champions takes Stat Points (SP 0-32) in the
// in-game editor, not Showdown EVs, so print an SP table (the exact spFromEv
// rounding) alongside a Showdown paste (for import into the TUI / Showdown).
//
//   npx tsx packages/core/src/scripts/export-team.ts [team.json]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { spFromEv } from '../domain/pikalytics.js';
import type { PokemonSet, StatID } from '../domain/types.js';

const arg = process.argv.slice(2).find(a => a.endsWith('.json')) ?? 'anti-meta-mb.json';
const path = arg.includes('/') || arg.includes('\\') ? arg : join(dataDirPath(), 'my-teams', arg);
const team: PokemonSet[] = JSON.parse(readFileSync(path, 'utf8'));

const ORDER: [StatID, string, string][] = [['hp', 'HP', 'HP'], ['atk', 'Atk', 'Atk'], ['def', 'Def', 'Def'], ['spa', 'SpA', 'SpA'], ['spd', 'SpD', 'SpD'], ['spe', 'Spe', 'Spe']];

console.log(`=== ${arg} — Champions build sheet (Stat Points, 0-32) ===`);
console.log('Level 50 · all IVs 31 (max). Enter these SP per stat in the in-game editor.\n');
for (const s of team) {
  const sp = ORDER.map(([k, lbl]) => { const v = spFromEv(s.evs[k] ?? 0); return v > 0 ? `${lbl} ${v}` : null; }).filter(Boolean).join(' / ');
  const total = ORDER.reduce((t, [k]) => t + spFromEv(s.evs[k] ?? 0), 0);
  console.log(`${s.species}  @ ${s.item || '(no item)'}`);
  console.log(`  Ability: ${s.ability}   Nature: ${s.nature}`);
  console.log(`  SP: ${sp}   (total ${total}/66)`);
  console.log(`  Moves: ${s.moves.join(' · ')}\n`);
}

console.log('=== Showdown paste (for TeamPaste / Showdown import) ===\n');
const lines: string[] = [];
for (const s of team) {
  lines.push(`${s.species}${s.item ? ` @ ${s.item}` : ''}`);
  lines.push(`Ability: ${s.ability}`);
  lines.push('Level: 50');
  const evStr = ORDER.map(([k, , lbl]) => (s.evs[k] ? `${s.evs[k]} ${lbl}` : null)).filter(Boolean).join(' / ');
  if (evStr) lines.push(`EVs: ${evStr}`);
  lines.push(`${s.nature} Nature`);
  for (const m of s.moves) lines.push(`- ${m}`);
  lines.push('');
}
console.log(lines.join('\n'));
