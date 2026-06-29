// Matchup autopsy — WHY do we lose a matchup, from data not opinion. Runs the
// real piloted playout (our search policy vs the opponent's pilot policy, the
// same wiring bringWinRate uses) with the battle log traced, parses faints, and
// aggregates the kill pattern: how many of their 4 we KO vs how many of ours die,
// which of our mons faint to what, and a representative losing timeline.
//   npx tsx packages/core/src/scripts/matchup-autopsy.ts [team.json] [oppAnchorSubstr] [--games N]
// Opponent is found by anchor substring in the hand threats first, then the real
// meta gauntlet. Default team anti-meta-mb.json, default opponent "Blaziken".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath } from '../domain/data.js';
import { loadPikaData, metaTeams } from '../domain/metaTeams.js';
import { scoreBrings } from '../domain/bring.js';
import { entryOf } from '../domain/teamSim.js';
import { playGame, makeSearchPolicy, makePilotPolicy, derivePilotPlan, type GameResult } from '../domain/simPlayout.js';
import { MB_THREATS } from './mbThreats.js';
import type { PokemonSet } from '../domain/types.js';

const argNum = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const positional = process.argv.slice(2).filter(a => !a.startsWith('--') && process.argv[process.argv.indexOf(a) - 1]?.startsWith('--') !== true);
const TEAM = positional[0]?.endsWith('.json') ? positional[0]! : 'anti-meta-mb.json';
const OPP = positional.find(a => !a.endsWith('.json') && !/^\d+$/.test(a)) ?? 'Blaziken';
const GAMES = argNum('--games', 30);

const myTeam = JSON.parse(readFileSync(join(dataDirPath(), 'my-teams', TEAM), 'utf8')) as PokemonSet[];
const pika = loadPikaData();
const pool = [
  ...MB_THREATS.map(m => ({ anchor: m.anchor, sets: m.sets })),
  ...metaTeams(pika, 12, 4).map(m => ({ anchor: m.anchor, sets: m.sets })),
];
const opp = pool.find(g => g.anchor.toLowerCase().includes(OPP.toLowerCase()));
if (!opp) { console.error(`no opponent matching "${OPP}". Anchors: ${pool.map(g => g.anchor).join(', ')}`); process.exit(1); }

const myBring = scoreBrings(myTeam, opp.sets.map(entryOf))[0]!.myIndices.map(i => myTeam[i]!);
const oppBring = scoreBrings(opp.sets, myTeam.map(entryOf))[0]!.myIndices.map(i => opp.sets[i]!);

// --- log parsing ---------------------------------------------------------
interface Cause { by: string; move: string }
const ident = (s: string) => { const m = /^(p[12])[a-c]: (.+)$/.exec(s.trim()); return m ? { side: m[1]!, name: m[2]! } : null; };
const slotOf = (s: string) => /^(p[12][a-c])/.exec(s.trim())?.[1];

interface FaintEvent { side: string; name: string; cause: Cause; turn: number }
function autopsy(log: string[]): { winner: string; faints: FaintEvent[] } {
  let turn = 0; let cur: Cause = { by: '?', move: '?' };
  const lastHit: Record<string, Cause> = {};
  const faints: FaintEvent[] = [];
  let winner = '';
  for (const line of log) {
    const p = line.split('|'); // leading '' at p[0]
    const type = p[1];
    if (type === 'turn') turn = Number(p[2]) || turn;
    else if (type === 'move') {
      const atk = ident(p[2] ?? ''); cur = { by: atk?.name ?? '?', move: p[3] ?? '?' };
      const tgt = slotOf(p[4] ?? ''); if (tgt) lastHit[tgt] = cur;
    } else if (type === '-damage') {
      const slot = slotOf(p[2] ?? ''); if (!slot) continue;
      const from = p.find(x => x.startsWith('[from]'));
      lastHit[slot] = from ? { by: from.replace('[from] ', '').trim() || 'residual', move: '(residual)' } : (lastHit[slot] ?? cur);
    } else if (type === 'faint') {
      const id = ident(p[2] ?? ''); const slot = slotOf(p[2] ?? '');
      if (id && slot) faints.push({ side: id.side, name: id.name, cause: lastHit[slot] ?? cur, turn });
    } else if (type === 'win') winner = (p[2] ?? '').trim();
  }
  return { winner, faints };
}

// --- run -----------------------------------------------------------------
const policy = makeSearchPolicy(myBring, oppBring, 2);
const p2Policy = makePilotPolicy(myBring, oppBring, 2, derivePilotPlan(oppBring));
const seed = (i: number): [number, number, number, number] => [i * 7 + 1, i * 13 + 3, i * 17 + 5, i * 23 + 7];

console.log(`autopsy · ${TEAM} vs [${opp.anchor}] · ${GAMES} games · piloted`);
console.log(`my bring : ${myBring.map(s => s.species).join(', ')}`);
console.log(`opp bring: ${oppBring.map(s => s.species).join(', ')}\n`);

let wins = 0, myKOs = 0, oppKOs = 0;
const myFaintCause = new Map<string, number>(); // "Mon <- By Move"
const myFaintByMon = new Map<string, number>();
let sampleLoss: FaintEvent[] | null = null;

for (let i = 0; i < GAMES; i++) {
  const r = await playGame(myBring, oppBring, { seed: seed(i), policy, p2Policy, trace: true }) as GameResult;
  if ('error' in (r as object)) { console.error((r as unknown as { error: string }).error); process.exit(1); }
  if (!r.log) continue;
  const { faints } = autopsy(r.log); // faint events; winner resolved via r.winner (the log's |win| is the player name)
  const weWon = r.winner === 'p1';
  if (weWon) wins++;
  for (const f of faints) {
    if (f.side === 'p2') oppKOs++;
    else {
      myKOs++;
      myFaintByMon.set(f.name, (myFaintByMon.get(f.name) ?? 0) + 1);
      const key = `${f.name.padEnd(11)} <- ${f.cause.by} ${f.cause.move}`;
      myFaintCause.set(key, (myFaintCause.get(key) ?? 0) + 1);
    }
  }
  if (!weWon && !sampleLoss) sampleLoss = faints;
}

const pct = (n: number) => `${Math.round((n / GAMES) * 100)}%`;
console.log(`win rate: ${pct(wins)} (${wins}/${GAMES})`);
console.log(`avg KOs dealt: ${(oppKOs / GAMES).toFixed(1)} / 4   ·   avg KOs taken: ${(myKOs / GAMES).toFixed(1)} / 4\n`);

console.log('our mons by faint frequency:');
[...myFaintByMon.entries()].sort((a, b) => b[1] - a[1]).forEach(([m, c]) => console.log(`  ${m.padEnd(11)} died in ${Math.round((c / GAMES) * 100)}% of games`));

console.log('\ntop kill causes (who kills us with what):');
[...myFaintCause.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([k, c]) => console.log(`  ${String(c).padStart(3)}×  ${k}`));

if (sampleLoss) {
  console.log('\nrepresentative losing game — faint order:');
  for (const f of sampleLoss) console.log(`  T${f.turn} ${f.side === 'p1' ? 'OURS ' : 'opp  '} ${f.name.padEnd(11)} <- ${f.cause.by} ${f.cause.move}`);
}
