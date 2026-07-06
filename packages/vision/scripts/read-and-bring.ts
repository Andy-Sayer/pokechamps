// Wire the VISION team-read into the ACTUAL bring engine. Sprite-match the opponent's
// six from a preview frame (or take a sight-confirmed --species override), then run the
// SAME bringNash + bringThreats the TUI/bring-lookup use. The output is the ENGINE's
// bring — sim-derived Nash mix + dossier threats — NOT a freehand call. Instant once the
// species are confirmed, so it fits the ~90s preview clock.
//
//   npx tsx packages/vision/scripts/read-and-bring.ts \
//     [--frame <png=fixtures/live/latest.png>] [--team <slug=TalonFlameAndyBoy>] \
//     [--species "Sp1,Sp2,Sp3,Sp4,Sp5,Sp6"]   # sight-confirmed override (recommended)
//
// The vision read is LOW-confidence with the current 58-ref table, so the intended flow
// is: run it once to get the vision proposal + confidence per slot, eyeball the frame,
// then re-run with --species to lock the six and get the engine bring.
import { readOppTeamFromFrame } from '../src/oppTeamRead.js';
import { bringNash, bringThreats } from '@pokechamps/core/domain/bringRecommend.js';
import { dataDirPath } from '@pokechamps/core/domain/data.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (f: string, d?: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const CONF = 0.7;
const here = dirname(fileURLToPath(import.meta.url));
const framePath = resolve(arg('--frame', join(here, '../fixtures/live/latest.png'))!);
const team = arg('--team', 'TalonFlameAndyBoy')!;
const speciesOverride = arg('--species');
const pct = (x: number) => `${Math.round(x * 100)}%`;

// --- 1) the six: sight-confirmed override, else the vision sprite-match ---
let species: string[];
if (speciesOverride) {
  species = speciesOverride.split(',').map(s => s.trim()).filter(Boolean);
  console.log(`opponent (sight-confirmed): ${species.join(', ')}`);
} else {
  // Shared, layout-aware read (auto-detects direct vs GameShare inset).
  const got = await readOppTeamFromFrame(framePath);
  species = got.map(g => g.name || '?');
  console.log(`vision read (${got.filter(g => g.score >= CONF).length}/6 confident):`);
  got.forEach(g => console.log(`  ${g.slot}. ${g.name.padEnd(16)} ${(g.score * 100).toFixed(0)}%${g.score < CONF ? '  ⚠ CONFIRM' : ''}`));
  const low = got.filter(g => g.score < CONF).length;
  if (low) console.log(`\n⚠ ${low}/6 low-confidence — eyeball the frame, then re-run with --species "A,B,C,D,E,F" to lock them before trusting the bring.`);
}

// --- 2) my six (for the threats read when no matrix exists) ---
const teamPath = join(dataDirPath(), 'my-teams', `${team}.json`);
if (!existsSync(teamPath)) { console.error(`no team file ${teamPath}`); process.exit(1); }
const mySpecies: string[] = (JSON.parse(readFileSync(teamPath, 'utf8')) as { species: string }[]).map(m => m.species);

// --- 3) the ENGINE bring: Nash from the matrix corpus (exact/closest), else proxy by
//        identical species set, else fall back to the dossier threats read alone. ---
let nash = bringNash(team, species);
let proxy = '';
if (!nash) {
  // TalonFlameAndyBoy shares its six species with rain-mb-final — borrow that corpus for
  // the bring COMPOSITION (spreads differ; flagged). Any same-species team works.
  proxy = 'rain-mb-final';
  nash = bringNash(proxy, species);
}

console.log('');
if (nash) {
  const src = proxy ? `${proxy} corpus (same species, spreads differ — bring composition only)` : `${team} corpus`;
  console.log(`ENGINE BRING  [${nash.exact ? 'EXACT anchor' : 'NOVEL → closest by role'}] via ${src}`);
  console.log(`  vs ${nash.anchor}   matchup ${pct(nash.value)}   ·   safest single bring (maximin) ${pct(nash.maximinValue)}:`);
  console.log(`    → ${nash.maximinBring.join(' / ')}`);
  console.log(`  Nash mix (vary across games so you can't be counter-brought):`);
  nash.mix.forEach(x => console.log(`    ${pct(x.p).padStart(4)}  ${x.bring.join(' / ')}`));
  if (nash.noAnalog.length) console.log(`  ⚠ no safe analog for: ${nash.noAnalog.join(', ')} — scout it: npm run bring-matrix -- ${team}.json "${species.join(',')}"`);
} else {
  console.log(`no matrix corpus for ${team} (or proxy) — dossier THREATS only (build one: npm run bring-matrix -- ${team}.json).`);
}

// --- 4) threats read (dossier-driven, ALWAYS available) vs the recommended bring ---
const myBring = nash ? nash.maximinBring : mySpecies;
console.log(`\nTHREATS vs ${nash ? 'your safest bring' : 'your six'} (${myBring.join('/')}):`);
for (const t of bringThreats(species, myBring)) {
  if (!t.known) { console.log(`  ? ${t.species.padEnd(15)} not in dossier`); continue; }
  const se = t.se ? `${t.se.mult}× ${t.se.type}→${t.se.target}` : '';
  console.log(`  ${t.se ? '⚠' : ' '} ${t.species.padEnd(15)} ${se.padEnd(22)} {${t.roles.join(',') || 'attacker'}}${t.inferred ? '  (inferred moves)' : ''}`);
}
console.log(`\nnote: this is the ENGINE's read (bringNash + bringThreats) — the same functions the TUI uses, not a freehand call.`);
