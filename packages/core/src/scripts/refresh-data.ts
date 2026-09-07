import { Dex } from '@pkmn/dex';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEGA_ABILITY_OVERRIDES } from '../domain/gimmicks/mega.js';

// Materialize Gen 9 data from @pkmn/dex into editable JSON files under data/.
// Re-running this overwrites species/moves/items/abilities/natures/types but
// preserves data/format.champions.json so manual rule overrides are not lost.

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', '..', '..', '..', 'data');
mkdirSync(dataDir, { recursive: true });

const gen = Dex.forGen(9).includeData();

// Champions corrections @pkmn/dex does not have (yet), for species that are NOT
// mega formes. Every mega ability pin lives in MEGA_ABILITY_OVERRIDES and is
// merged in below — do not add one here, it would be shadowed by the derived
// half and drift out of sync with what the engine actually reads.
const EXTRA_SPECIES_PATCHES: Record<string, { abilities?: Record<string, string> }> = {
  // (empty — all current patches are mega abilities)
};

// The mega half of the patch table is DERIVED, not hand-maintained. Pinning a
// mega's real Champions ability used to mean editing two tables that had no
// mechanical link (this one and MEGA_ABILITY_OVERRIDES in gimmicks/mega.ts) —
// the domain read one, the dump carried the other, and forgetting either half
// left them silently disagreeing. MEGA_ABILITY_OVERRIDES is now the single
// source of truth: pin there, run refresh-data, done. regulation-readiness
// BLOCKS if data/species.json and the table ever drift apart.
const megaIdOf = (forme: string) => forme.toLowerCase().replace(/[^a-z0-9]/g, "");
const SPECIES_PATCHES: Record<string, { abilities?: Record<string, string> }> = {
  ...EXTRA_SPECIES_PATCHES,
  ...Object.fromEntries(Object.entries(MEGA_ABILITY_OVERRIDES)
    .map(([forme, ability]) => [megaIdOf(forme), { abilities: { 0: ability } }])),
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
