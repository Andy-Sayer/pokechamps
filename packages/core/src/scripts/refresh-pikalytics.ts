// Pulls usage stats for the top-10 Pokemon in the active Champions format from
// Pikalytics's /ai/pokedex/* markdown endpoint (no HTML scraping needed).
// Writes data/pikalytics.<format>.json. Run with: npm run refresh-pikalytics
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', '..', '..', '..', 'data');

const FORMAT = 'gen9championsvgc2026regma';
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

// Parse the format index. We only need the top-N species names.
function parseTopN(md: string, n: number): string[] {
  const out: string[] = [];
  // Rows look like: "| 1 | **Sneasler** | 43.80% | [View](...) | [AI](...) |"
  const re = /^\|\s*(\d+)\s*\|\s*\*\*([^*]+)\*\*\s*\|\s*([\d.]+)%/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const rank = parseInt(m[1]!, 10);
    if (rank > n) break;
    out.push(m[2]!.trim());
    if (out.length >= n) break;
  }
  return out;
}

// "- **Name**: 99.540%" lines under a "## Common <Section>" header.
function parsePercentSection(md: string, header: string): PercentRow[] {
  const sec = sectionBody(md, `## ${header}`);
  if (!sec) return [];
  const out: PercentRow[] = [];
  const re = /^-\s+\*\*([^*]+)\*\*:\s+([\d.]+)%/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sec)) !== null) {
    out.push({ name: m[1]!.trim(), pct: parseFloat(m[2]!) });
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
// configuration accounts for 22.880% of competitive builds."
function parseTopSpread(md: string): Spread | undefined {
  const re = /\*\*([A-Za-z]+)\*\*\s+nature\s+with\s+an\s+EV\s+spread\s+of\s+`(\d+\/\d+\/\d+\/\d+\/\d+\/\d+)`[^%]*?([\d.]+)%/;
  const m = md.match(re);
  if (!m) return undefined;
  const parts = m[2]!.split('/').map(s => parseInt(s, 10)) as [number, number, number, number, number, number];
  return { nature: m[1]!, sp: parts, pct: parseFloat(m[3]!) };
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
  const top = parseTopN(indexMd, TOP_N);
  if (!top.length) throw new Error('Could not parse top-N species from format index — markup may have changed.');
  console.log(`[refresh-pikalytics] Top ${top.length}: ${top.join(', ')}`);

  // Rebuild the usage percentages from the index in the same single pass.
  const usageByRank = new Map<string, { rank: number; usage: number }>();
  const re = /^\|\s*(\d+)\s*\|\s*\*\*([^*]+)\*\*\s*\|\s*([\d.]+)%/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(indexMd)) !== null) {
    const rank = parseInt(m[1]!, 10);
    if (rank > TOP_N) break;
    usageByRank.set(m[2]!.trim(), { rank, usage: parseFloat(m[3]!) });
  }

  const pokemon: Record<string, PikalyticsEntry> = {};
  for (const species of top) {
    const url = `${BASE}/${FORMAT}/${encodeURIComponent(species)}`;
    const meta = usageByRank.get(species) ?? { rank: 0, usage: 0 };
    console.log(`  - ${species} (rank ${meta.rank}, ${meta.usage}%)`);
    try {
      const md = await fetchText(url);
      pokemon[species] = { rank: meta.rank, usage: meta.usage, ...parseEntry(md, species) };
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
