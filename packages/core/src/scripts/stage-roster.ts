// Switch-day helper: turn an official roster list (pasted from MetaVGC / Serebii)
// into a validated, paste-ready `legality.allow` block + a diff vs the current
// format, so a regulation rotation is "paste-and-validate" instead of a manual
// alphabetise-and-wrap. Pure functions are exported for testing; the CLI is a
// thin wrapper. PRINT-ONLY by default — it never mutates the format file, you
// paste the block between the [ ] of "legality": { "allow": [ … ] }.
//
//   # paste the official list (names or ids, any separators) then Ctrl-D:
//   npx tsx packages/core/src/scripts/stage-roster.ts --mode replace
//   # or from a file, additive (only NEW species in the file):
//   npx tsx packages/core/src/scripts/stage-roster.ts --in roster.txt --mode add
//
// modes:  replace = the input IS the full new allow-list (shows removals too)
//         add     = the input is only the additions (merged into current)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSpecies, toId, dataDirPath } from '../domain/data.js';

const INDENT = '      ';   // 6 spaces — matches data/format.champions.json
const PER_LINE = 7;        // ids per line — matches the existing wrapping

/** Liberally split a pasted roster into ids: any of newline / comma / tab /
 *  multiple-space separators, bullet/number prefixes stripped, then toId. */
export function parseRoster(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\n,\t]+/)) {
    const cleaned = raw.replace(/^[\s*\-•\d.)]+/, '').trim();   // drop bullets / "1." / "-" prefixes
    if (!cleaned) continue;
    const id = toId(cleaned);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

interface SpeciesEntry { baseStats?: unknown; exists?: boolean; requiredItem?: string; forme?: string; }

/** Sort ids into: real base species (belong in legality.allow), mega/forme
 *  species reached via an item (do NOT belong here — they go to items.allow),
 *  and ids that don't resolve in the dex at all (typos / not yet in the dump). */
export function classifyIds(ids: string[]): { species: string[]; megaFormes: string[]; unresolved: string[] } {
  const species: string[] = [], megaFormes: string[] = [], unresolved: string[] = [];
  for (const id of ids) {
    const sp = getSpecies(id) as SpeciesEntry | undefined;
    if (!sp || !sp.baseStats || sp.exists === false) { unresolved.push(id); continue; }
    // A held-stone forme (every Champions mega has requiredItem) is enabled by
    // the item, not by legality.allow — flag rather than silently include.
    if (sp.requiredItem || /mega/i.test(sp.forme ?? '')) { megaFormes.push(id); continue; }
    species.push(id);
  }
  return { species, megaFormes, unresolved };
}

/** Diff resolved species vs the current allow-list. In `add` mode the input is
 *  treated as additions (nothing removed); in `replace` mode the input is the
 *  authoritative new list, so anything current-but-absent is a removal. */
export function diffAllow(current: string[], incoming: string[], mode: 'add' | 'replace'): { added: string[]; removed: string[]; merged: string[] } {
  const cur = new Set(current);
  const inc = new Set(incoming);
  const added = incoming.filter(id => !cur.has(id));
  const merged = mode === 'replace' ? [...inc] : [...new Set([...current, ...incoming])];
  const removed = mode === 'replace' ? current.filter(id => !inc.has(id)) : [];
  merged.sort();
  return { added: [...new Set(added)].sort(), removed: removed.sort(), merged };
}

/** Format an id list exactly like the format file's array body: 6-space indent,
 *  7 quoted ids per line, comma-terminated except after the final id. */
export function formatAllowBlock(ids: string[]): string {
  const sorted = [...new Set(ids)].sort();
  const lines: string[] = [];
  for (let i = 0; i < sorted.length; i += PER_LINE) {
    const chunk = sorted.slice(i, i + PER_LINE).map(id => `"${id}"`);
    const isLast = i + PER_LINE >= sorted.length;
    lines.push(INDENT + chunk.join(', ') + (isLast ? '' : ','));
  }
  return lines.join('\n');
}

function currentAllow(): string[] {
  const f = JSON.parse(readFileSync(join(dataDirPath(), 'format.champions.json'), 'utf8'));
  return f.legality.allow as string[];
}

function main(): void {
  const argv = process.argv;
  const mode = (argv.includes('--mode') ? argv[argv.indexOf('--mode') + 1] : 'replace') as 'add' | 'replace';
  const inFlag = argv.indexOf('--in');
  const text = inFlag >= 0 ? readFileSync(argv[inFlag + 1]!, 'utf8') : readFileSync(0, 'utf8'); // fd 0 = stdin

  const ids = parseRoster(text);
  const { species, megaFormes, unresolved } = classifyIds(ids);
  const current = currentAllow();
  const { added, removed, merged } = diffAllow(current, species, mode);

  const log = (s = '') => process.stdout.write(s + '\n');
  log(`=== M-B roster staging (mode: ${mode}) ===`);
  log(`input tokens: ${ids.length}  ·  resolved species: ${species.length}  ·  current allow-list: ${current.length}`);
  log();
  if (unresolved.length) { log(`⚠ UNRESOLVED — NOT added, fix these (typo or not in the dex dump yet):`); log(`   ${unresolved.join(', ')}`); log(); }
  if (megaFormes.length) { log(`ℹ mega/forme species SKIPPED (enable via items.allow stone, not legality.allow):`); log(`   ${megaFormes.join(', ')}`); log(); }
  log(`+ added (${added.length}): ${added.join(', ') || '—'}`);
  if (mode === 'replace') log(`- removed (${removed.length}): ${removed.join(', ') || '—'}`);
  log();
  log(`new legality.allow (${merged.length} ids) — paste between the [ ] of "legality": { "allow": [ … ] }:`);
  log('-'.repeat(72));
  log(formatAllowBlock(merged));
  log('-'.repeat(72));
  if (unresolved.length) process.exitCode = 1;   // make a bad paste a hard signal
}

// Run only as a CLI (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('stage-roster.ts')) {
  main();
}
