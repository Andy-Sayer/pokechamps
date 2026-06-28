// Engine/data-driven meta analysis for the active Champions regulation set.
// Reads the cached Pikalytics dump (offline, deterministic — NO network, NO LLM
// judgement) and reports: a freshness verdict, the top-usage ranking with win
// rates, and an unweighted mechanic-prevalence tally over the top mons. The
// tally mirrors the original Reg M-A meta-priorities analysis so we can see
// whether the M-B field shifts any battle-mechanic porting priority.
//
//   npx tsx packages/core/src/scripts/mb-meta-report.ts [--top N]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirPath, CHAMPIONS_PIKA_FORMAT } from '../domain/data.js';
import type { PikalyticsFile, PikalyticsEntry } from './refresh-pikalytics.js';

const argNum = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const TOP = argNum('--top', 25);

const file = join(dataDirPath(), `pikalytics.${CHAMPIONS_PIKA_FORMAT}.json`);
const data = JSON.parse(readFileSync(file, 'utf8')) as PikalyticsFile;
const names = data.topPokemon.slice(0, TOP);
const entry = (n: string): PikalyticsEntry | undefined => data.pokemon[n];

// --- Freshness verdict ----------------------------------------------------
// The /ai header's "Data Date" field is unreliable (templated). The real proof
// the dump is live post-launch M-B play is the presence of M-B-only species /
// formes that could not appear pre-rotation.
const MB_ONLY = ['Swampert', 'Staraptor', 'Grimmsnarl', 'Gholdengo', 'Annihilape', 'Floette-Eternal', 'Scrafty', 'Eelektross'];
const present = MB_ONLY.filter(n => entry(n));
console.log(`# Champions meta report — ${CHAMPIONS_PIKA_FORMAT}`);
console.log(`fetched ${data.fetchedAt} · ${data.topPokemon.length} mons cached`);
console.log(`freshness: ${present.length >= 3 ? 'FRESH ✓' : 'SUSPECT ⚠'} — M-B-only species present: ${present.join(', ') || '(none!)'}\n`);

// --- Top usage ranking ----------------------------------------------------
console.log(`## Top ${TOP} by usage rank (usage% is N/A in M-B; win rate shown)`);
for (const n of names) {
  const e = entry(n);
  if (!e) continue;
  const wr = e.winRate != null ? `${e.winRate.toFixed(1)}% WR` : `${e.usage}% usage`;
  const item = e.items[0]?.name ?? '?';
  const ability = e.abilities[0]?.name ?? '?';
  console.log(`  ${String(e.rank).padStart(2)}. ${n.padEnd(18)} ${wr.padEnd(11)} ${ability} @ ${item}`);
}

// --- Mechanic prevalence --------------------------------------------------
// Each detector returns a short carrier annotation (the relevant %) or null.
const abil = (e: PikalyticsEntry, ...n: string[]) => e.abilities.find(a => n.includes(a.name));
const move = (e: PikalyticsEntry, n: string, min = 5) => e.moves.find(m => m.name === n && m.pct >= min);
const item = (e: PikalyticsEntry, pred: (n: string) => boolean, min = 5) => e.items.find(i => pred(i.name) && i.pct >= min);
const RESIST_BERRY = (n: string) => /Berry$/.test(n) && !['Sitrus Berry', 'Lum Berry', 'Aguav Berry', 'Figy Berry'].includes(n);
const CHOICE = (n: string) => /^Choice (Scarf|Band|Specs)$/.test(n);
const WEATHER = ['Drizzle', 'Drought', 'Sand Stream', 'Snow Warning', 'Orichalcum Pulse'];
const TERRAIN = ['Electric Surge', 'Grassy Surge', 'Psychic Surge', 'Misty Surge', 'Hadron Engine'];
const PROTO = ['Protosynthesis', 'Quark Drive'];

const MECHANICS: { label: string; hit: (e: PikalyticsEntry) => string | null }[] = [
  { label: 'Prankster (priority status)', hit: e => abil(e, 'Prankster') ? 'ability' : null },
  { label: 'Intimidate', hit: e => abil(e, 'Intimidate') ? 'ability' : null },
  { label: 'Fake Out (turn-1 flinch)', hit: e => { const m = move(e, 'Fake Out'); return m ? `${m.pct}%` : null; } },
  { label: 'Tailwind', hit: e => { const m = move(e, 'Tailwind'); return m ? `${m.pct}%` : null; } },
  { label: 'Trick Room', hit: e => { const m = move(e, 'Trick Room'); return m ? `${m.pct}%` : null; } },
  { label: 'Choice lock (Scarf/Band/Specs)', hit: e => { const i = item(e, CHOICE); return i ? `${i.name} ${i.pct}%` : null; } },
  { label: 'Unburden + White Herb', hit: e => abil(e, 'Unburden') && item(e, n => n === 'White Herb', 1) ? 'yes' : null },
  { label: 'Resist berry', hit: e => { const i = item(e, RESIST_BERRY); return i ? `${i.name} ${i.pct}%` : null; } },
  { label: 'Weather setter (ability)', hit: e => { const a = abil(e, ...WEATHER); return a ? a.name : null; } },
  { label: 'Terrain setter (ability)', hit: e => { const a = abil(e, ...TERRAIN); return a ? a.name : null; } },
  { label: 'Protosynthesis / Quark Drive', hit: e => { const a = abil(e, ...PROTO); return a ? a.name : null; } },
];

console.log(`\n## Mechanic prevalence among top ${TOP} (carriers — confirms porting priority)`);
for (const m of MECHANICS) {
  const carriers: string[] = [];
  for (const n of names) {
    const e = entry(n);
    if (!e) continue;
    const tag = m.hit(e);
    if (tag) carriers.push(tag === 'ability' || tag === 'yes' ? n : `${n} (${tag})`);
  }
  console.log(`  ${m.label.padEnd(32)} ${String(carriers.length).padStart(2)}  ${carriers.join(', ') || '—'}`);
}

console.log(`\n## Notes`);
console.log(`  - usage% is N/A in the M-B /ai export; rank = raw game volume, win rate is the quality signal.`);
console.log(`  - mechanic ports are already shipped (see project_meta_priorities); this confirms which stay relevant.`);
