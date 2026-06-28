// Pulls usage stats for the top-10 Pokemon in the active Champions format from
// Pikalytics's /ai/pokedex/* markdown endpoint (no HTML scraping needed).
// Writes data/pikalytics.<format>.json. Run with: npm run refresh-pikalytics
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAMPIONS_PIKA_FORMAT } from '../domain/data.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', '..', '..', '..', 'data');

const FORMAT = CHAMPIONS_PIKA_FORMAT;
const TOP_N = 60;
const BASE = 'https://www.pikalytics.com/ai/pokedex';
const REQUEST_DELAY_MS = 200; // be polite to pikalytics across the per-species fetches

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface PercentRow { name: string; pct: number }
interface Spread { nature: string; sp: [number, number, number, number, number, number]; pct: number }
interface BaseStats { hp: number; atk: number; def: number; spa: number; spd: number; spe: number }
interface FeaturedSet { player: string; record: string; item?: string; ability?: string; moves: string[] }

export interface PikalyticsEntry {
  rank: number;
  usage: number;
  // Reg M-B's /ai index reports usage as "N/A" and ranks by raw game volume,
  // exposing win rate + W-L-T record instead. These carry that signal so the
  // meta report has a quantitative metric when `usage` is 0.
  winRate?: number;
  record?: string;
  baseStats?: BaseStats;
  moves: PercentRow[];
  abilities: PercentRow[];
  items: PercentRow[];
  teammates: PercentRow[];
  topSpread?: Spread;
  featuredSets: FeaturedSet[];
}

export interface PikalyticsFile {
  format: string;
  fetchedAt: string;
  topPokemon: string[];
  pokemon: Record<string, PikalyticsEntry>;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'pokechamps-tui/0.1 (refresh-pikalytics)' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return await res.text();
}

interface IndexRow { rank: number; name: string; usage: number; winRate?: number; record?: string }

// Parse the format index's usage table. Reg M-A rows are
// "| 1 | **Sneasler** | 43.80% | [View](...) | [AI](...) |" (usage %), while
// Reg M-B reports "| 1 | **Garchomp** | N/A% | 52.366% | 15196-13822-15 | ... |"
// — usage is "N/A", the table is ranked by raw game volume, and win rate +
// W-L-T record follow. Tolerate both: usage falls back to 0 on "N/A"; win
// rate / record are captured when the extra columns are present.
export function parseIndexRows(md: string, n: number): IndexRow[] {
  const out: IndexRow[] = [];
  const re = /^\|\s*(\d+)\s*\|\s*\*\*([^*]+)\*\*\s*\|\s*([\d.]+|N\/A)%\s*(?:\|\s*([\d.]+)%\s*\|\s*([\d-]+))?/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const rank = parseInt(m[1]!, 10);
    if (rank > n) break;
    out.push({
      rank,
      name: m[2]!.trim(),
      usage: m[3] === 'N/A' ? 0 : parseFloat(m[3]!),
      winRate: m[4] ? parseFloat(m[4]) : undefined,
      record: m[5]?.trim(),
    });
    if (out.length >= n) break;
  }
  return out;
}

// "- **Name**: 99.540%" lines under a "## Common <Section>" header. Reg M-B's
// Common Teammates section renders "- **Whimsicott**: undefined%" (the names
// are correct and correlation-ordered, only the percentage is absent), so a
// non-numeric percentage is tolerated as 0 — keeping the name is what matters
// for teammate-correlation team composition.
function parsePercentSection(md: string, header: string): PercentRow[] {
  const sec = sectionBody(md, `## ${header}`);
  if (!sec) return [];
  const out: PercentRow[] = [];
  const re = /^-\s+\*\*([^*]+)\*\*:\s+([\d.]+|undefined)%/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sec)) !== null) {
    out.push({ name: m[1]!.trim(), pct: m[2] === 'undefined' ? 0 : parseFloat(m[2]!) });
  }
  return out;
}

function sectionBody(md: string, headerLine: string): string | null {
  const start = md.indexOf(headerLine);
  if (start < 0) return null;
  const after = md.slice(start + headerLine.length);
  // Stop at the next "## " heading (same or higher level).
  const nextH2 = after.search(/\n##\s/);
  return nextH2 < 0 ? after : after.slice(0, nextH2);
}

function parseBaseStats(md: string): BaseStats | undefined {
  // Inside the FAQ table: "| HP | 80 |" etc.
  const wanted: Array<[string, keyof BaseStats]> = [
    ['HP', 'hp'], ['Attack', 'atk'], ['Defense', 'def'],
    ['Sp. Atk', 'spa'], ['Sp. Def', 'spd'], ['Speed', 'spe'],
  ];
  const out: Partial<BaseStats> = {};
  for (const [label, key] of wanted) {
    const re = new RegExp(`\\|\\s*${label.replace('.', '\\.')}\\s*\\|\\s*(\\d+)\\s*\\|`);
    const m = md.match(re);
    if (m) out[key] = parseInt(m[1]!, 10);
  }
  return Object.keys(out).length === 6 ? (out as BaseStats) : undefined;
}

// FAQ phrasing: "Jolly nature with an EV spread of `2/32/0/0/0/32`. This
// configuration accounts for 22.880% of competitive builds." Reg M-B leaves the
// nature BLANK ("a **** nature with an EV spread of ..."), so the nature group
// is optional and inferred from the spread shape when absent — a neutral
// fallback would understate offensive sets and make the gauntlet artificially
// weak (the wrong direction for an anti-meta stress test).
function parseTopSpread(md: string): Spread | undefined {
  const re = /\*\*([A-Za-z]*)\*\*\s+nature\s+with\s+an\s+EV\s+spread\s+of\s+`(\d+\/\d+\/\d+\/\d+\/\d+\/\d+)`[^%]*?([\d.]+)%/;
  const m = md.match(re);
  if (!m) return undefined;
  const sp = m[2]!.split('/').map(s => parseInt(s, 10)) as [number, number, number, number, number, number];
  const nature = m[1]! || inferNatureFromSp(sp);
  return { nature, sp, pct: parseFloat(m[3]!) };
}

// Reg M-B's /ai export omits the nature label, so derive a sensible one purely
// from the EV-spread SHAPE (deterministic, no meta judgement): a speed-invested
// offensive build gets the +Spe nature cutting its unused attacking stat
// (Jolly / Timid); a no-speed offensive build the +offence nature (Adamant /
// Modest); a defensive build a +bulk nature cutting the unused attacking stat
// (Bold / Impish / Calm / Careful). SP units are 0–32. Imperfect at the
// Jolly-vs-Adamant margin, but far better than a neutral fallback.
export function inferNatureFromSp(sp: number[]): string {
  const [, atk = 0, def = 0, spa = 0, spd = 0, spe = 0] = sp;
  const INVEST = 8; // ≈60 EV — the floor for "built for this stat"
  const physical = atk >= spa; // tie → treat as physical
  const maxOff = Math.max(atk, spa);
  if (maxOff >= INVEST && spe >= INVEST) return physical ? 'Jolly' : 'Timid';
  if (maxOff >= INVEST) return physical ? 'Adamant' : 'Modest';
  // Bulky / no real offence: boost the bigger defence, cut the smaller attack.
  const cutAtk = atk <= spa;
  return def >= spd ? (cutAtk ? 'Bold' : 'Impish') : (cutAtk ? 'Calm' : 'Careful');
}

function parseFeaturedSets(md: string, species: string): FeaturedSet[] {
  const sec = sectionBody(md, `## Featured Teams with ${species}`);
  if (!sec) return [];
  const out: FeaturedSet[] = [];
  // Each team block starts with "### Team N by <player>" and includes a
  // "**<species> Set**:" subsection with bullet lines for Ability/Item/Moves.
  const blocks = sec.split(/\n###\s+Team\s+\d+\s+by\s+/).slice(1);
  for (const raw of blocks) {
    const player = raw.split('\n')[0]?.trim() ?? 'unknown';
    const record = raw.match(/\*Record:\s+([^*]+)\*/)?.[1]?.trim() ?? '';
    const setStart = raw.indexOf(`**${species} Set**`);
    if (setStart < 0) continue;
    const setBlock = raw.slice(setStart);
    const ability = setBlock.match(/\*\*Ability\*\*:\s*([^\n]+)/)?.[1]?.trim();
    const item = setBlock.match(/\*\*Item\*\*:\s*([^\n]+)/)?.[1]?.trim();
    const movesRaw = setBlock.match(/\*\*Moves\*\*:\s*([^\n]+)/)?.[1] ?? '';
    const moves = movesRaw.split(',').map(s => s.trim()).filter(Boolean);
    out.push({ player, record, item, ability, moves });
  }
  return out;
}

export function parseEntry(md: string, species: string): Omit<PikalyticsEntry, 'rank' | 'usage'> {
  return {
    baseStats: parseBaseStats(md),
    moves: parsePercentSection(md, 'Common Moves'),
    abilities: parsePercentSection(md, 'Common Abilities'),
    items: parsePercentSection(md, 'Common Items'),
    teammates: parsePercentSection(md, 'Common Teammates'),
    topSpread: parseTopSpread(md),
    featuredSets: parseFeaturedSets(md, species),
  };
}

async function main() {
  console.log(`[refresh-pikalytics] Fetching format index for ${FORMAT}...`);
  const indexMd = await fetchText(`${BASE}/${FORMAT}`);
  const rows = parseIndexRows(indexMd, TOP_N);
  if (!rows.length) throw new Error('Could not parse top-N species from format index — markup may have changed.');
  const top = rows.map(r => r.name);
  console.log(`[refresh-pikalytics] Top ${top.length}: ${top.join(', ')}`);

  const pokemon: Record<string, PikalyticsEntry> = {};
  for (const row of rows) {
    const url = `${BASE}/${FORMAT}/${encodeURIComponent(row.name)}`;
    const metric = row.usage > 0 ? `${row.usage}% usage` : row.winRate != null ? `${row.winRate}% WR` : 'no metric';
    console.log(`  - ${row.name} (rank ${row.rank}, ${metric})`);
    try {
      const md = await fetchText(url);
      pokemon[row.name] = {
        rank: row.rank, usage: row.usage, winRate: row.winRate, record: row.record,
        ...parseEntry(md, row.name),
      };
    } catch (e) {
      console.warn(`    skipped: ${(e as Error).message}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  const out: PikalyticsFile = {
    format: FORMAT,
    fetchedAt: new Date().toISOString().slice(0, 10),
    topPokemon: top,
    pokemon,
  };
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, `pikalytics.${FORMAT}.json`);
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`[refresh-pikalytics] Wrote ${path}`);
}

// Run when invoked directly.
const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
