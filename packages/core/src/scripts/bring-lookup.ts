// Live bring lookup — the preview-time "what do I bring?" tool. Reads the
// precomputed 4v4 matrices (data/matrices/, from bring-matrix) and returns the
// recommended NASH bring (mix) + win-rate for the opponent you're facing. Exact
// for a known gauntlet team; for a novel opponent it falls back to the CLOSEST
// known team by shared species, clearly flagged (with the command to compute the
// exact matrix). Instant — no playouts — so it's usable at the preview clock.
//   npx tsx packages/core/src/scripts/bring-lookup.ts [team.json] "<anchor | Sp1,Sp2,...>"
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, toId } from '../domain/data.js';
import { solveMatrixGame } from '../domain/bringMatrixGame.js';

// [team.json] selects WHICH team's matrices to read: bring-matrix namespaces its
// output by team slug (data/matrices/<slug>/), so the reader MUST match or it finds
// nothing. Defaults to the same team bring-matrix defaults to. The matrices encode
// my brings, so beyond the team only the opponent is needed.
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

// Each matrix's theirBrings (4-of-6 combos) union to the opponent's species set.
const oppSpeciesOf = (m: Mat) => new Set(m.theirBrings.flatMap(b => b.split('/').map(toId)));
const pct = (x: number) => `${Math.round(x * 100)}%`;

// Resolve the faced opponent: exact anchor substring, else closest by shared species.
const lower = OPP.toLowerCase();
let chosen = mats.find(m => m.anchor.toLowerCase().includes(lower));
let note = chosen ? 'exact match' : '';
if (!chosen && OPP.includes(',')) {
  const want = new Set(OPP.split(',').map(s => toId(s.trim())));
  const ranked = mats.map(m => ({ m, shared: [...oppSpeciesOf(m)].filter(s => want.has(s)).length })).sort((a, b) => b.shared - a.shared);
  chosen = ranked[0]!.m;
  note = `NOVEL opponent → closest known: ${chosen.anchor} (${ranked[0]!.shared}/${want.size} species shared) — run bring-matrix on these species for an exact answer`;
}
if (!chosen) { console.error(`no match for "${OPP}". Known: ${mats.map(m => m.anchor).join(', ')}`); process.exit(1); }

const sol = solveMatrixGame(chosen.M);
const mix = sol.nashRow.map((p, i) => ({ bring: chosen!.myBrings[i]!, p })).filter(x => x.p > 0.03).sort((a, b) => b.p - a.p);
console.log(`${teamSlug} vs ${chosen.anchor}  (${note})`);
console.log(`  matchup value (Nash): ${pct(sol.value)}   ·   single safest bring (maximin): ${pct(sol.maximinValue)} — ${chosen.myBrings[sol.maximinRow]}`);
console.log(`  BRING (Nash mix — vary across games):`);
mix.forEach(x => console.log(`    ${pct(x.p).padStart(4)}  ${x.bring}`));
