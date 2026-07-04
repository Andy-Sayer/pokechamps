// Live bring lookup — the preview-time "what do I bring?" tool. Reads the precomputed
// 4v4 matrices (data/matrices/<team>/, from bring-matrix) and returns the recommended
// NASH bring (mix) + win-rate. Exact for a known gauntlet team; for a NOVEL opponent it
// borrows the closest known matrix — chosen by role-aware analog (the dossier), not blind
// species count — and prints a THREATS read for the faced 6 (roles + which of their mons
// hits YOUR bring super-effectively) plus an honest confidence flag. Instant (no playouts)
// so it's usable inside the ~90s preview clock; the exact matrix is a scout-ahead job.
//   npx tsx packages/core/src/scripts/bring-lookup.ts [team.json] "<anchor | Sp1,Sp2,...>"
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId } from '../domain/data.js';
import { solveMatrixGame } from '../domain/bringMatrixGame.js';
import { loadDossier, dossierBase, nearestAnalog, bestSEAgainst, type DossierEntry } from '../domain/monDossier.js';
import { speciesTypes } from '../domain/typechart.js';

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const TEAM = positional.find(a => a.endsWith('.json')) ?? 'anti-meta-mb.json';
const teamSlug = TEAM.replace(/\.json$/, '');
const OPP = positional.find(a => !a.endsWith('.json')) ?? '';
if (!OPP) { console.error('usage: bring-lookup.ts [team.json] "<anchor | Sp1,Sp2,...>"'); process.exit(1); }

interface Mat { anchor: string; myBrings: string[]; theirBrings: string[]; M: number[][] }
const dir = join(dataDirPath(), 'matrices', teamSlug);
if (!existsSync(dir)) { console.error(`no data/matrices/${teamSlug}/ yet — run: bring-matrix ${TEAM} (the gauntlet run fills it).`); process.exit(1); }
const mats: Mat[] = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Mat);
if (!mats.length) { console.error(`data/matrices/${teamSlug}/ is empty — the gauntlet run is still warming up.`); process.exit(1); }

const oppSpeciesNames = (m: Mat) => [...new Set(m.theirBrings.flatMap(b => b.split('/')))];
const pct = (x: number) => `${Math.round(x * 100)}%`;
const dossier = loadDossier();
const entriesOf = (names: string[]) => names.map(dossierBase).filter((e): e is DossierEntry => !!e);

// Resolve the faced opponent → a matrix to borrow + the faced 6 species.
const lower = OPP.toLowerCase();
let chosen = mats.find(m => m.anchor.toLowerCase().includes(lower));
let note = 'exact match';
let facedNames: string[];
if (chosen) {
  facedNames = oppSpeciesNames(chosen);
} else {
  facedNames = OPP.includes(',') ? OPP.split(',').map(s => s.trim()) : [OPP];
  const facedEntries = entriesOf(facedNames);
  if (dossier.length && facedEntries.length) {
    // Role-aware: pick the anchor whose mons are the nearest analogs to the faced 6.
    const ranked = mats.map(m => {
      const pool = entriesOf(oppSpeciesNames(m));
      const dist = facedEntries.reduce((s, e) => { const n = nearestAnalog(e, pool); return s + (n ? n.dist : 5); }, 0);
      return { m, dist };
    }).sort((a, b) => a.dist - b.dist);
    chosen = ranked[0]!.m;
    note = `NOVEL → closest by role: ${chosen.anchor}`;
  } else {
    // No dossier baked: fall back to blind species overlap.
    const want = new Set(facedNames.map(toId));
    const ranked = mats.map(m => ({ m, shared: oppSpeciesNames(m).map(toId).filter(s => want.has(s)).length })).sort((a, b) => b.shared - a.shared);
    chosen = ranked[0]!.m;
    note = `NOVEL → closest by species: ${chosen.anchor} (no dossier — run build-dossier for role matching)`;
  }
}
if (!chosen) { console.error(`no match for "${OPP}". Known: ${mats.map(m => m.anchor).join(', ')}`); process.exit(1); }

const sol = solveMatrixGame(chosen.M);
const mix = sol.nashRow.map((p, i) => ({ bring: chosen!.myBrings[i]!, p })).filter(x => x.p > 0.03).sort((a, b) => b.p - a.p);
console.log(`${teamSlug} vs ${chosen.anchor}  (${note})`);
console.log(`  matchup value (Nash): ${pct(sol.value)}   ·   single safest bring (maximin): ${pct(sol.maximinValue)} — ${chosen.myBrings[sol.maximinRow]}`);
console.log(`  BRING (Nash mix — vary across games):`);
mix.forEach(x => console.log(`    ${pct(x.p).padStart(4)}  ${x.bring}`));

// ---- dossier threat layer: what to watch for, and how far to trust the number ----
if (dossier.length) {
  const safest = chosen.myBrings[sol.maximinRow]!;
  const myTypes = safest.split('/').map(n => ({ name: n, types: speciesTypes(n) }));
  const anchorIds = new Set(oppSpeciesNames(chosen).map(toId));
  console.log(`\n  THREATS vs your safest bring (${safest}):`);
  for (const name of facedNames) {
    const e = dossierBase(name);
    if (!e) { console.log(`    ? ${name.padEnd(15)} unknown species (not in dossier)`); continue; }
    let worst = { mult: 1, type: '', target: '' };
    for (const mm of myTypes) { const se = bestSEAgainst(e, mm.types); if (se.mult > worst.mult) worst = { mult: se.mult, type: se.type, target: mm.name }; }
    const novel = !anchorIds.has(toId(name));
    const flag = worst.mult >= 2 ? '⚠' : novel ? '?' : ' ';
    const se = worst.mult >= 2 ? `${worst.mult}× ${worst.type}→${worst.target}` : '';
    const src = e.moveSource === 'inferred' ? 'inferred moves' : '';
    console.log(`    ${flag} ${name.padEnd(15)} ${se.padEnd(20)} {${e.roles.join(',') || 'attacker'}}${novel ? '  [novel]' : ''}${src ? '  (' + src + ')' : ''}`);
  }
  if (note === 'exact match') {
    console.log(`  confidence: EXACT — this opponent is in the gauntlet.`);
  } else {
    const novelCount = facedNames.filter(n => !anchorIds.has(toId(n))).length;
    const noAnalog = entriesOf(facedNames).filter(e => { const n = nearestAnalog(e, entriesOf(oppSpeciesNames(chosen!))); return !n || !n.safe; }).map(e => e.label);
    console.log(`  confidence: APPROXIMATE — borrowed from ${chosen.anchor}; ${novelCount}/${facedNames.length} of their mons differ.`);
    if (noAnalog.length) console.log(`    ⚠ no safe analog for: ${noAnalog.join(', ')} — treat the number with caution; scout it: bring-matrix ${TEAM} "${OPP}"`);
  }
}
