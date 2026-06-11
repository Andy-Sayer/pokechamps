/**
 * fetch-replay.ts — download a Pokémon Showdown replay log and cache it under
 * `packages/core/tests/replays/` so the ingest tests run offline (J.5's corpus
 * grows one fixture at a time).
 *
 * Run: `npx tsx packages/core/src/scripts/fetch-replay.ts <id-or-url>`
 *   e.g. npx tsx … fetch-replay.ts gen9vgc2026regfbo3-2573268519
 *        npx tsx … fetch-replay.ts https://replay.pokemonshowdown.com/xyz-123
 *
 * Prints a parse + ingest summary so a bad fixture is obvious before commit.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReplayLog } from '../domain/showdownReplay.js';
import { ingestTranscript } from '../domain/replayDriver.js';

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: fetch-replay.ts <replay-id-or-url>');
    process.exit(1);
  }
  const id = arg.replace(/^https?:\/\/replay\.pokemonshowdown\.com\//, '').replace(/\.(json|log)$/, '');
  const url = `https://replay.pokemonshowdown.com/${id}.log`;
  console.log(`[fetch-replay] GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[fetch-replay] HTTP ${res.status}`);
    process.exit(1);
  }
  const log = await res.text();

  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'replays');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${id}.log`);
  writeFileSync(outFile, log, 'utf8');
  console.log(`[fetch-replay] wrote ${outFile} (${log.split('\n').length} lines)`);

  // Sanity: parse + ingest and summarise, so a fixture that breaks the
  // pipeline is caught at fetch time, not in CI.
  const t = parseReplayLog(log);
  console.log(`[fetch-replay] format: ${t.format ?? '?'} · ${t.players.p1 ?? '?'} vs ${t.players.p2 ?? '?'}`);
  console.log(`[fetch-replay] teams: p1 ${t.teams.p1.length} mons, p2 ${t.teams.p2.length} mons · ${t.turns.length} turns · winner: ${t.winner ?? '-'}`);
  const r = ingestTranscript(t);
  console.log(`[fetch-replay] ingest: ${r.match.turns.length} turns driven, ${r.flags.length} legality flag(s), ${r.notes.length} note(s)`);
  for (const f of r.flags) console.log(`  flag [${f.kind}] turn ${f.turn}: ${f.who} — ${f.detail}`);
  for (const n of r.notes.slice(0, 10)) console.log(`  note: ${n}`);
}

main().catch(e => { console.error(e); process.exit(1); });
