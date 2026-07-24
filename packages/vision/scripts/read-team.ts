// Import a full team from the in-game Team summary screens (both pages) → PokemonSet[].
//   npx tsx scripts/read-team.ts <moves.png> <stats.png> [--name myteam] [--save] [--dump]
//   npx tsx scripts/read-team.ts --live [--name myteam] [--save]
// --live grabs the two pages off the running capture tap: sit on "Moves & More",
// press Enter, flip to "Stats" (R), press Enter. --dump writes every OCR crop to
// fixtures/team-summary-debug/ for region calibration.
import { createInterface } from 'node:readline';
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Jimp } from 'jimp';
import { loadFrame } from '../src/decode.js';
import { TesseractOcrReader } from '../src/ocr.js';
import { cropRegion } from '../src/visionSource.js';
import { readSummaryMoves, readSummaryStats, assembleTeamSummary } from '../src/teamSummary.js';
import { DEFAULT_LIVE_TAP } from '../src/oppTeamRead.js';
import { formatShowdownTeamSP } from '@pokechamps/core/domain/showdown.js';
import { saveTeam } from '@pokechamps/core/domain/storage.js';
import { spFromEv } from '@pokechamps/core/domain/pikalytics.js';

const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const files = argv.filter(a => !a.startsWith('--') && a !== opt('--name'));

async function grabLive(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  await new Promise<void>(r => rl.question(`${prompt} — press Enter…`, () => r()));
  rl.close();
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/live');
  const out = join(dir, `team-page-${Date.now()}.png`);
  copyFileSync(DEFAULT_LIVE_TAP, out);
  return out;
}

let movesPath: string, statsPath: string;
if (flag('--live')) {
  movesPath = await grabLive('showing the "Moves & More" page?');
  statsPath = await grabLive('flip to "Stats" (R)');
} else {
  if (files.length < 2) { console.error('usage: read-team.ts <moves.png> <stats.png> [--name n] [--save] [--dump] | --live'); process.exit(2); }
  [movesPath, statsPath] = [files[0]!, files[1]!];
}

const movesFrame = await loadFrame(movesPath);
const statsFrame = await loadFrame(statsPath);
const ocr = new TesseractOcrReader();

if (flag('--dump')) {
  const dbg = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/team-summary-debug');
  try { rmSync(dbg, { recursive: true, force: true }); } catch { /* fresh */ }
  mkdirSync(dbg, { recursive: true });
  const { default: mod } = { default: await import('../src/teamSummary.js') };
  const dump = async (frame: typeof movesFrame, name: string, rect: { x: number; y: number; w: number; h: number }) => {
    const c = cropRegion(frame, rect);
    const img = new Jimp({ width: c.width, height: c.height });
    img.bitmap.data = Buffer.from(c.data);
    await img.write(join(dbg, `${name}.png`) as `${string}.png`);
  };
  // Internal rect helpers aren't exported — dump via the readers' own geometry by
  // re-deriving from the module would duplicate; keep dump simple: full cards.
  for (let i = 0; i < 6; i++) {
    const cx = [185, 985][i % 2]! / 1920, cy = [292, 510, 728][Math.floor(i / 2)]! / 1080;
    await dump(movesFrame, `card${i + 1}-moves`, { x: cx, y: cy, w: 745 / 1920, h: 195 / 1080 });
    await dump(statsFrame, `card${i + 1}-stats`, { x: cx, y: cy, w: 745 / 1920, h: 195 / 1080 });
  }
  void mod;
  console.error(`[read-team] card crops → ${dbg}`);
}

console.error('[read-team] reading Moves & More page…');
const movesCards = await readSummaryMoves(movesFrame, ocr);
console.error('[read-team] reading Stats page…');
const statsCards = await readSummaryStats(statsFrame, ocr);
await ocr.close();

const { team, warnings } = assembleTeamSummary(movesCards, statsCards);

for (const w of warnings) console.error(`  ⚠ ${w}`);
console.error('');
for (const set of team) {
  const sp = (Object.entries(set.evs) as ['hp', number][]).filter(([, v]) => v > 0).map(([k, v]) => `${spFromEv(v)} ${k.toUpperCase()}`).join(' / ');
  console.error(`  ${set.species} @ ${set.item ?? '(none)'} · ${set.ability ?? '?'} · ${set.nature} · ${sp || 'no investment'} · ${set.moves.join(', ')}`);
}
console.error('');
console.log(formatShowdownTeamSP(team));

if (flag('--save')) {
  const name = opt('--name') ?? 'imported';
  const path = saveTeam(name, team);
  console.error(`[read-team] saved ${team.length} mons → ${path}`);
}
