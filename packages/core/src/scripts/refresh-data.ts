import { Dex } from '@pkmn/dex';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Materialize Gen 9 data from @pkmn/dex into editable JSON files under data/.
// Re-running this overwrites species/moves/items/abilities/natures/types but
// preserves data/format.champions.json so manual rule overrides are not lost.

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', '..', '..', '..', 'data');
mkdirSync(dataDir, { recursive: true });

const gen = Dex.forGen(9).includeData();

// Champions corrections @pkmn/dex doesn't have (yet). Upstream ships the
// custom megas tagged isNonstandard:'Future', occasionally with placeholder
// abilities; the OFFICIAL announcements win. Applied after every dump so a
// refresh never silently regresses them. Verified 2026-06: Mega Raichu X =
// Electric Surge, Mega Raichu Y = No Guard (pokemon.com, 2026-06-03 news).
const SPECIES_PATCHES: Record<string, { abilities?: Record<string, string> }> = {
  raichumegax: { abilities: { 0: 'Electric Surge' } },
  raichumegay: { abilities: { 0: 'No Guard' } },
  // Reg M-B custom megas: the @pkmn/dex dump ships these with PLACEHOLDER
  // base-forme abilities, so pin the real Champions ability (a single-slot
  // object collapses the forme to one ability, like raichumegay above). Only
  // two are publicly named pre-launch; effect emulation is tracked separately
  // in docs/notes/champions-custom-data.md.
  eelektrossmega: { abilities: { 0: 'Eelevate' } },    // CUSTOM effect (Levitate + Beast Boost) — emulated in damage.ts/search
  pyroarmega: { abilities: { 0: 'Fire Mane' } },       // CUSTOM effect (×1.5 Fire) — emulated in damage.ts
  // The remaining M-B megas use STANDARD abilities (no emulation needed). All
  // confirmed 2026-06-18 (The Game Haus / Pokéos / PLDH); Staraptor independently
  // seen in live footage. Full set now pinned — no blanks remain.
  staraptormega: { abilities: { 0: 'Contrary' } },
  scolipedemega: { abilities: { 0: 'Shell Armor' } },
  scraftymega: { abilities: { 0: 'Intimidate' } },
  malamarmega: { abilities: { 0: 'Contrary' } },
  barbaraclemega: { abilities: { 0: 'Tough Claws' } },
  dragalgemega: { abilities: { 0: 'Regenerator' } },
  falinksmega: { abilities: { 0: 'Defiant' } },
};

// Champions move-DATA rebalances @pkmn/dex doesn't have (mainline data ≠
// Champions custom data). Same survival contract as SPECIES_PATCHES: re-applied
// after every dump so `npm run refresh-data` never silently reverts them.
// Shallow merge — include the WHOLE top-level field (e.g. all of `self`), not
// just the nested key you're changing. Verified 2026-06-28 (Reg M-B patch
// notes): Make It Rain accuracy 100→95, self SpA drop −1→−2.
const MOVE_PATCHES: Record<string, Record<string, unknown>> = {
  makeitrain: {
    accuracy: 95,
    self: { boosts: { spa: -2 } },
    desc: 'Lowers the user\'s Special Attack by 2 stages.',
    shortDesc: 'Lowers the user\'s Sp. Atk by 2. Hits foe(s).',
  },
};

function dump<T>(filename: string, entries: Iterable<T>, getId: (e: T) => string, patches?: Record<string, Partial<T>>) {
  const out: Record<string, T> = {};
  for (const e of entries) {
    const id = getId(e);
    if (!id) continue;
    out[id] = e;
  }
  for (const [id, patch] of Object.entries(patches ?? {})) {
    if (out[id]) { out[id] = { ...out[id], ...patch }; console.log(`patched ${filename}/${id}`); }
  }
  writeFileSync(join(dataDir, filename), JSON.stringify(out, null, 2));
  console.log(`wrote ${filename} (${Object.keys(out).length} entries)`);
}

dump('species.json', gen.species.all(), s => s.id as string, SPECIES_PATCHES as never);
dump('moves.json', gen.moves.all(), m => m.id as string, MOVE_PATCHES as never);
dump('items.json', gen.items.all(), i => i.id as string);
dump('abilities.json', gen.abilities.all(), a => a.id as string);
dump('natures.json', gen.natures.all(), n => n.id as string);
dump('types.json', gen.types.all(), t => t.id as string);

// Learnsets are async in @pkmn/dex. Walk every species and snapshot the
// list of move ids. Stored as `{ speciesId: [moveId, ...] }`. Consumed by
// data.ts → getLearnset() for autocomplete and validation.
async function dumpLearnsets() {
  const out: Record<string, string[]> = {};
  let count = 0;
  for (const species of gen.species.all()) {
    const id = species.id as string;
    try {
      const ls = await gen.learnsets.get(id);
      const moves = ls && (ls as any).learnset ? Object.keys((ls as any).learnset) : [];
      if (moves.length) {
        out[id] = moves;
        count++;
      }
    } catch { /* species without learnset — skip */ }
  }
  writeFileSync(join(dataDir, 'learnsets.json'), JSON.stringify(out));
  console.log(`wrote learnsets.json (${count} entries)`);
}

await dumpLearnsets();

const formatPath = join(dataDir, 'format.champions.json');
if (!existsSync(formatPath)) {
  const seed = {
    __notes:
      'Pokemon Champions ruleset. Champions uses a cut-down dex of species and items and ' +
      'uses Mega Evolution (not Terastallization). ' +
      'Fill `legality.allow` with the legal species ids; if empty the framework treats all as legal. ' +
      'Fill `items.allow` with the legal item ids. ban lists are subtractive overlays.',
    level: 50,
    teamSize: 6,
    bringSize: 4,
    gameType: 'doubles',
    gimmick: 'mega',
    gimmickAllowancePerSide: 1,
    openTeamSheets: true,
    itemClause: true,
    speciesClause: true,
    legality: {
      allow: [] as string[],
      ban: [] as string[],
    },
    items: {
      allow: [] as string[],
      ban: [] as string[],
    },
    moves: {
      ban: [] as string[],
    },
  };
  writeFileSync(formatPath, JSON.stringify(seed, null, 2));
  console.log('wrote format.champions.json (seed)');
} else {
  console.log('format.champions.json exists — preserving manual edits');
}
