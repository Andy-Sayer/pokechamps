// Bring search — is a bad matchup actually a bad BRING choice? Maximin-evaluates
// ALL our brings (exhaustive) against the opponent's top-K brings via piloted
// playout, and contrasts the searched best with what scoreBrings top-1 (the
// heuristic the gauntlet/live currently trusts for OUR bring) would send.
//   npx tsx packages/core/src/scripts/bring-search.ts [team.json] [opp] [--games N]
// opp = an anchor substring (single, detailed ranking) OR "hand" / "meta" / "all"
// (sweep the hand threats / meta gauntlet / both, summary contrasting current vs best).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams, buildSet } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { PlayoutPool } from '../domain/playoutPool.js';
import { bestBringVsOpponent } from '../domain/bringEval.js';
import { MB_THREATS } from './mbThreats.js';
import type { PokemonSet } from '../domain/types.js';

const argNum = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const TEAM = positional[0]?.endsWith('.json') ? positional[0]! : 'anti-meta-mb.json';
const OPP = positional.find(a => !a.endsWith('.json')) ?? 'Blaziken';
const GAMES = argNum('--games', 16);
const OPP_K = argNum('--oppK', 2);
const SAVE = (() => { const i = process.argv.indexOf('--save'); return i >= 0 ? process.argv[i + 1] : undefined; })();

// Per-opponent playout ground truth (every bring's maximin wr) — the fixed target
// the heuristic is calibrated against. Saved with --save for offline iteration.
const truth: { anchor: string; brings: { species: string[]; maximinWr: number }[] }[] = [];

const myTeam = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', TEAM), 'utf8')) as PokemonSet[];
const pika = loadPikaData();
const hand = MB_THREATS.map(m => ({ anchor: m.anchor, sets: m.sets }));
const meta = metaTeams(pika, 12, 4).map(m => ({ anchor: m.anchor, sets: m.sets }));
const all = [...hand, ...meta];
const lower = OPP.toLowerCase();
let opponents = lower === 'hand' ? hand : lower === 'meta' ? meta : lower === 'all' ? all
  : all.filter(g => g.anchor.toLowerCase().includes(lower));
// Arbitrary opponent: a comma-separated species list (the 6 you actually face at
// preview) → build their probable sets from Pikalytics so the sim can recommend
// our bring vs the real team, not just a known gauntlet anchor.
if (opponents.length === 0 && OPP.includes(',')) {
  const species = OPP.split(',').map(s => s.trim()).filter(Boolean);
  const used = new Set<string>();
  const sets: PokemonSet[] = [];
  for (const sp of species) {
    const set = buildSet(pika, sp, used);
    if (set) { sets.push(set); if (set.item) used.add(set.item); }
  }
  if (sets.length >= 4) opponents = [{ anchor: `custom (${species.join('/')})`, sets }];
  else console.error(`built only ${sets.length}/${species.length} sets from Pikalytics — check species names`);
}
if (opponents.length === 0) { console.error(`no opponent matching "${OPP}" (anchor substring, hand/meta/all, or a comma-separated species list)`); process.exit(1); }

const key = (b: PokemonSet[]) => b.map(s => s.species).sort().join(',');
const pct = (x: number) => `${Math.round(x * 100)}%`;
const pp = new PlayoutPool();

const rows: { anchor: string; curWr: number; bestWr: number; bestBring: PokemonSet[]; curBring: PokemonSet[] }[] = [];
const single = opponents.length === 1;
console.log(`bring search · ${TEAM} · ${opponents.length} opponent(s) · ${GAMES} games/cell · ALL 15 brings × opp top-${OPP_K} · piloted\n`);

for (const opp of opponents) {
  const cur = scoreBrings(myTeam, opp.sets.map(entryOf))[0]!.myIndices.map(i => myTeam[i]!);
  const rec = await bestBringVsOpponent(pp, myTeam, opp.sets, { myBringK: 15, oppBringK: OPP_K, games: GAMES, pilotP2: true });
  const curWr = rec.shortlist.find(s => key(s.bring) === key(cur))?.maximinWr ?? NaN;
  rows.push({ anchor: opp.anchor, curWr, bestWr: rec.maximinWr, bestBring: rec.bring, curBring: cur });
  truth.push({ anchor: opp.anchor, brings: rec.shortlist.map(s => ({ species: s.bring.map(b => b.species), maximinWr: s.maximinWr })) });

  if (single) {
    const ranked = rec.shortlist.slice().sort((a, b) => b.maximinWr - a.maximinWr);
    console.log(`[${opp.anchor}] all brings by maximin win-rate:`);
    for (const s of ranked) {
      const mark = key(s.bring) === key(cur) ? '  <- scoreBrings top-1 (current)' : '';
      console.log(`  ${pct(s.maximinWr).padStart(4)}  ${s.bring.map(b => b.species).join(', ').padEnd(46)}${mark}`);
    }
  } else {
    const delta = rec.maximinWr - curWr;
    console.log(`  ${opp.anchor.padEnd(30)} current ${pct(curWr).padStart(4)} → best ${pct(rec.maximinWr).padStart(4)}  (${delta >= 0 ? '+' : ''}${Math.round(delta * 100)}pp)  best: ${rec.bring.map(b => b.species).join('/')}`);
  }
}
pp.close();

if (SAVE) {
  writeFileSync(join(dataDirPath(), SAVE), JSON.stringify(truth, null, 2) + '\n', 'utf8');
  console.log(`\nsaved playout ground truth (${truth.length} opponents × ${truth[0]?.brings.length ?? 0} brings) → data/${SAVE}`);
}

if (!single) {
  const curFloor = Math.min(...rows.map(r => r.curWr)), bestFloor = Math.min(...rows.map(r => r.bestWr));
  const curAvg = rows.reduce((a, r) => a + r.curWr, 0) / rows.length, bestAvg = rows.reduce((a, r) => a + r.bestWr, 0) / rows.length;
  console.log(`\nUNDER scoreBrings top-1: floor ${pct(curFloor)}  avg ${pct(curAvg)}`);
  console.log(`UNDER searched bring   : floor ${pct(bestFloor)}  avg ${pct(bestAvg)}`);
  console.log(`\nbiggest bring-selection misses (where the heuristic leaves the most on the table):`);
  rows.slice().sort((a, b) => (b.bestWr - b.curWr) - (a.bestWr - a.curWr)).slice(0, 5)
    .forEach(r => console.log(`  +${Math.round((r.bestWr - r.curWr) * 100)}pp  ${r.anchor.padEnd(30)} bring ${r.bestBring.map(b => b.species).join('/')} not ${r.curBring.map(b => b.species).join('/')}`));
}
