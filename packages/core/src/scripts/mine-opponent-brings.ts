// Mine the gauntlet matrices for ADOPTION CANDIDATES — the opponent teams/brings
// that beat OUR team hardest. Every 4v4 cell is symmetric data (M = our win-rate,
// 1-M = theirs), so the opponents we score lowest against are proven-strong configs
// worth piloting ourselves (their winning 4 + 2 complements → our own 6). Playout-
// free: just reads the saved matrices + solves the small zero-sum games.
//   npx tsx packages/core/src/scripts/mine-opponent-brings.ts [team-slug]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { solveMatrixGame } from '../domain/bringMatrixGame.js';

const TEAM = (process.argv[2] ?? 'anti-meta-mb').replace(/\.json$/, '');
const dir = join(dataDirPath(), 'matrices', TEAM);
if (!existsSync(dir)) { console.error(`no matrices for "${TEAM}" at ${dir} — run bring-matrix first`); process.exit(1); }

interface Mat { anchor: string; myBrings: string[]; theirBrings: string[]; M: number[][] }
const mats = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Mat);
const pct = (x: number) => `${Math.round(x * 100)}%`;

const rows = mats.map(m => {
  const sol = solveMatrixGame(m.M);
  // The opponent's go-to bring = the column they weight most in the Nash mix.
  let bj = 0; for (let j = 1; j < sol.nashCol.length; j++) if ((sol.nashCol[j] ?? 0) > (sol.nashCol[bj] ?? 0)) bj = j;
  return { anchor: m.anchor, ourNash: sol.value, theirBring: m.theirBrings[bj] ?? '?', theirP: sol.nashCol[bj] ?? 0 };
}).sort((a, b) => a.ourNash - b.ourNash);

console.log(`Opponent teams ranked by how hard they beat ${TEAM} — adoption candidates for our own 6:\n`);
console.log(`  ourNash  opponent                      their go-to 4 (the core to consider stealing)`);
for (const r of rows) console.log(`  ${pct(r.ourNash).padStart(5)}   ${r.anchor.padEnd(28)}  ${r.theirBring}`);
