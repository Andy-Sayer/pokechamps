/**
 * fetch-replay.ts — download Pokémon Showdown replay logs and cache them under
 * `packages/core/tests/replays/` so the ingest tests run offline (J.5's corpus).
 *
 * Run: `npx tsx packages/core/src/scripts/fetch-replay.ts <id-or-url>`
 *   or  `npx tsx … fetch-replay.ts --search <format> [count]`
 *   e.g. fetch-replay.ts gen9vgc2026regfbo3-2573268519
 *        fetch-replay.ts --search gen9vgc2026regfbo3 8
 *
 * Prints a parse + ingest summary per game so a bad fixture is obvious before
 * commit. Search mode skips ids already cached.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReplayLog } from '../domain/showdownReplay.js';
import { ingestTranscript } from '../domain/replayDriver.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'replays');

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: fetch-replay.ts <replay-id-or-url> | --search <format> [count]');
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  if (arg === '--search') {
    const format = process.argv[3];
    const count = parseInt(process.argv[4] ?? '5', 10);
    if (!format) { console.error('--search needs a format id'); process.exit(1); }
    const res = await fetch(`https://replay.pokemonshowdown.com/search.json?format=${encodeURIComponent(format)}`);
    if (!res.ok) { console.error(`[fetch-replay] search HTTP ${res.status}`); process.exit(1); }
    const list = (await res.json()) as { id: string }[];
    let fetched = 0;
    for (const entry of list) {
      if (fetched >= count) break;
      if (existsSync(join(outDir, `${entry.id}.log`))) continue;
      await fetchOne(entry.id);
      fetched += 1;
    }
    return;
  }
  const id = arg.replace(/^https?:\/\/replay\.pokemonshowdown\.com\//, '').replace(/\.(json|log)$/, '');
  await fetchOne(id);
}

async function fetchOne(id: string) {
  const url = `https://replay.pokemonshowdown.com/${id}.log`;
  console.log(`[fetch-replay] GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[fetch-replay] HTTP ${res.status}`);
    return;
  }
  const log = await res.text();
  const outFile = join(outDir, `${id}.log`);
  writeFileSync(outFile, log, 'utf8');
  console.log(`[fetch-replay] wrote ${outFile} (${log.split('\n').length} lines)`);

  // Sanity: parse + ingest and summarise, so a fixture that breaks the
  // pipeline is caught at fetch time, not in CI.
  try {
    summarize(log);
  } catch (e) {
    console.error(`[fetch-replay] ${id} CRASHED the pipeline: ${e instanceof Error ? e.message : String(e)} — fixture kept for triage`);
  }
}

function summarize(log: string) {
  const t = parseReplayLog(log);
  console.log(`[fetch-replay] format: ${t.format ?? '?'} · ${t.players.p1 ?? '?'} vs ${t.players.p2 ?? '?'}`);
  console.log(`[fetch-replay] teams: p1 ${t.teams.p1.length} mons, p2 ${t.teams.p2.length} mons · ${t.turns.length} turns · winner: ${t.winner ?? '-'}`);
  const r = ingestTranscript(t);
  console.log(`[fetch-replay] ingest: ${r.match.turns.length} turns driven, ${r.flags.length} legality flag(s), ${r.notes.length} note(s)`);
  for (const f of r.flags) console.log(`  flag [${f.kind}] turn ${f.turn}: ${f.who} — ${f.detail}`);
  for (const n of r.notes.slice(0, 10)) console.log(`  note: ${n}`);
  // J.3 damage-consistency summary: every observed hit vs the reachable envelope.
  const counts = { in: 0, out: 0, skipped: 0 };
  for (const d of r.damage) counts[d.verdict] += 1;
  console.log(`[fetch-replay] damage checks: ${counts.in} in · ${counts.out} OUT · ${counts.skipped} skipped (of ${r.damage.length})`);
  for (const d of r.damage.filter(x => x.verdict === 'out')) {
    console.log(`  OUT turn ${d.turn}: ${d.attacker} ${d.move} → ${d.defender}: observed ${d.observedPct.toFixed(0)}%, envelope ${d.minPct.toFixed(0)}–${d.maxPct.toFixed(0)}% — ${d.note ?? ''}`);
  }
  for (const d of r.damage.filter(x => x.verdict === 'skipped')) {
    console.log(`  skip turn ${d.turn}: ${d.attacker} ${d.move} → ${d.defender} — ${d.note ?? ''}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
