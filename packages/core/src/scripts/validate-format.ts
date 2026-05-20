// Validate format.champions.json against both @pkmn/dex (legality data lookup)
// and @smogon/calc (damage calc construction). Surfaces typos, missing dex
// entries, and species names whose forme indexing differs between the two
// libraries (e.g. calc has "Aegislash-Shield" but not bare "Aegislash").

import { Dex } from '@pkmn/dex';
import { Generations, Pokemon as CalcPokemon } from '@smogon/calc';
import { loadFormat, getSpecies } from '../domain/data.js';
import { CALC_SPECIES_OVERRIDES, calcSpeciesName } from '../domain/damage.js';

const gen = Dex.forGen(9).includeData();
const calcGen = Generations.get(9);
const fmt = loadFormat();

function check(label: string, ids: string[], resolve: (id: string) => boolean) {
  const unknown = ids.filter(id => !resolve(id));
  console.log(`${label}: ${ids.length} entries, ${unknown.length} unknown`);
  if (unknown.length) {
    for (const u of unknown) console.log(`  ! ${u}`);
  }
}

check('species (dex)', fmt.legality.allow, id => {
  const s = gen.species.get(id);
  return !!s?.exists;
});

check('items (dex)', fmt.items.allow, id => {
  const i = gen.items.get(id);
  return !!i?.exists;
});

// Calc construction check. Mismatches surface here. Each new mismatch needs
// a CALC_SPECIES_OVERRIDES entry in src/domain/damage.ts. We test names
// post-override so handled ones are reported as OK.
const calcFailures: string[] = [];
const calcHandled: string[] = [];
for (const id of fmt.legality.allow) {
  const name = getSpecies(id)?.name ?? id;
  const overridden = CALC_SPECIES_OVERRIDES[name];
  try {
    const p = new CalcPokemon(calcGen, calcSpeciesName(name), {
      level: 50,
      evs: { hp: 4 } as any,
      ivs: { hp: 31 } as any,
      moves: ['Tackle'] as any,
    });
    if (!p.maxHP() || !Number.isFinite(p.maxHP())) throw new Error('invalid maxHP');
    if (overridden) calcHandled.push(`${name} → ${overridden}`);
  } catch (e) {
    calcFailures.push(`${id} -> "${name}": ${(e as Error).message}`);
  }
}
console.log(`species (calc): ${fmt.legality.allow.length} entries, ${calcFailures.length} unresolved, ${calcHandled.length} handled by override`);
for (const f of calcFailures) console.log(`  ! ${f}  (add to CALC_SPECIES_OVERRIDES in src/domain/damage.ts)`);
for (const h of calcHandled) console.log(`  · override: ${h}`);
