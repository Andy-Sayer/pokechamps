// Regulation switch-day readiness report. Answers, in one command, "what is
// still wrong with the active format?" — written for the Reg M-C switch
// (Sept 8, 2026) but format-agnostic, so it serves every future rotation.
//
//   npx tsx packages/core/src/scripts/regulation-readiness.ts
//
// It checks the five things that have actually bitten us on a rotation:
//   1. every legal species/item resolves, and every legal species builds in
//      @smogon/calc (a forme the calc can't build silently kills its damage);
//   2. no legal mega forme is running an UNREVEALED ability (the explicit
//      MEGA_ABILITY_UNREVEALED registry in gimmicks/mega.ts) — every regulation
//      so far has shipped @pkmn/dex placeholders that silently poison damage;
//   3. @pkmn/sim agrees with our pinned abilities (a mismatch means /exact is
//      resolving that forme wrong, even though the calc path is right);
//   4. the Pikalytics dump matches the active format slug (a stale dump means
//      the gauntlet is scoring against the PREVIOUS regulation's meta);
//   5. the hand-built threat gauntlet is legal and covers the new stones.
//
// Exit code is 0 when everything is clean, 1 when any BLOCKER is present, so it
// can gate a switch-day commit. Warnings (unpinned abilities that upstream has
// not published yet, a sim that predates a reveal) do not fail the run.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Generations, Pokemon as CalcPokemon } from '@smogon/calc';
import {
  loadFormat, getSpecies, getItem, dataDirPath, toId, CHAMPIONS_PIKA_FORMAT,
} from '../domain/data.js';
import { calcSpeciesName } from '../domain/damage.js';
import { megaFormeAbility, MEGA_ABILITY_OVERRIDES, MEGA_ABILITY_UNREVEALED } from '../domain/gimmicks/mega.js';
import { ensureSimLoaded, simHasSpecies, buildBattle } from '../domain/simBridge.js';
import { ALL_THREATS } from './mcThreats.js';

const GEN = Generations.get(9);
const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const blockers: string[] = [];
const warnings: string[] = [];
const ok = (s: string) => console.log(`  ok    ${s}`);
const warn = (s: string) => { warnings.push(s); console.log(`  WARN  ${s}`); };
const block = (s: string) => { blockers.push(s); console.log(`  FAIL  ${s}`); };

interface SpeciesEntry { name: string; baseSpecies?: string; forme?: string; abilities?: Record<string, string>; baseStats?: unknown }

async function main() {
  const fmt = loadFormat() as unknown as {
    __notes?: string;
    gimmick?: string; level?: number; teamSize?: number; bringSize?: number;
    legality: { allow: string[] }; items: { allow: string[] };
  };

  console.log('=== format ===');
  console.log(`  gimmick=${fmt.gimmick}  level=${fmt.level}  team=${fmt.teamSize} bring=${fmt.bringSize}`);
  console.log(`  species allowed: ${fmt.legality.allow.length}   items allowed: ${fmt.items.allow.length}`);

  // ---- 1. everything resolves, and the calc can build it -------------------
  console.log('\n=== 1. dex + calc resolution ===');
  const unknownSpecies = fmt.legality.allow.filter(id => !(getSpecies(id) as SpeciesEntry | undefined)?.baseStats);
  const unknownItems = fmt.items.allow.filter(id => !getItem(id));
  if (unknownSpecies.length) block(`species not in the dex dump: ${unknownSpecies.join(', ')}`);
  if (unknownItems.length) block(`items not in the dex dump: ${unknownItems.join(', ')}`);
  if (!unknownSpecies.length && !unknownItems.length) ok(`all ${fmt.legality.allow.length} species / ${fmt.items.allow.length} items resolve`);

  const unbuildable: string[] = [];
  for (const id of fmt.legality.allow) {
    const sp = getSpecies(id) as SpeciesEntry | undefined;
    if (!sp) continue;
    try { new CalcPokemon(GEN, calcSpeciesName(sp.name), { level: fmt.level ?? 50 }); }
    catch { unbuildable.push(sp.name); }
  }
  if (unbuildable.length) block(`@smogon/calc cannot build: ${unbuildable.join(', ')}`);
  else ok('every legal species builds in @smogon/calc');

  // ---- 2. mega abilities pinned -------------------------------------------
  // Legal stones -> the mega formes they enable.
  console.log('\n=== 2. mega forme abilities ===');
  const formes: { forme: string; stone: string; base: string }[] = [];
  for (const id of fmt.items.allow) {
    const item = getItem(id) as { name: string; megaStone?: Record<string, string> } | undefined;
    if (!item?.megaStone) continue;
    for (const [base, forme] of Object.entries(item.megaStone)) formes.push({ forme, stone: item.name, base });
  }
  console.log(`  ${formes.length} legal mega formes`);
  // A mega keeping its base ability is COMMON and often correct, so that alone
  // proves nothing. The authority is the explicit MEGA_ABILITY_UNREVEALED
  // registry; the base-ability match is only used to build a quieter "worth a
  // second look" list of Champions-INVENTED formes (isNonstandard 'Future')
  // we have never pinned — canonical ('Past') megas are mainline-authoritative.
  const review: string[] = [];
  for (const { forme, stone, base } of formes) {
    const ability = megaFormeAbility(forme);
    if (!ability) { block(`${forme} (${stone}) has NO ability`); continue; }
    if (MEGA_ABILITY_UNREVEALED.has(forme)) {
      warn(`${forme} runs PLACEHOLDER "${ability}" — Champions has not published its ability (damage/search/exact are all guessing)`);
      continue;
    }
    if (MEGA_ABILITY_OVERRIDES[forme]) continue;          // explicitly pinned + verified
    const sp = getSpecies(forme) as (SpeciesEntry & { isNonstandard?: string }) | undefined;
    if (sp?.isNonstandard !== 'Future') continue;         // canonical mega — mainline data is authoritative
    const baseAbilities = Object.values((getSpecies(base) as SpeciesEntry | undefined)?.abilities ?? {}).map(norm);
    if (baseAbilities.includes(norm(ability))) review.push(`${forme}=${ability}`);
  }
  if (review.length) {
    console.log(`  note  ${review.length} invented formes keep their base ability and were never explicitly pinned`);
    console.log(`        (M-A/M-B era, corroborated by play — listed for audit, not a blocker): ${review.join(', ')}`);
  }
  if (![...MEGA_ABILITY_UNREVEALED].some(f => formes.some(x => x.forme === f))) ok('no legal mega forme is running an unrevealed ability');

  // ---- 3. sim parity -------------------------------------------------------
  console.log('\n=== 3. @pkmn/sim parity (drives /exact) ===');
  if (!(await ensureSimLoaded())) {
    warn('@pkmn/sim did not load — skipping parity check');
  } else {
    const missing = formes.filter(f => !simHasSpecies(f.forme)).map(f => f.forme);
    if (missing.length) block(`sim does not know: ${missing.join(', ')}`);
    else ok(`sim knows all ${formes.length} legal mega formes`);

    const battle = buildBattle({
      p1team: [{ species: 'Garchomp', moves: ['Earthquake'], level: 50 }, { species: 'Dragonite', moves: ['Outrage'], level: 50 }],
      p2team: [{ species: 'Talonflame', moves: ['Brave Bird'], level: 50 }, { species: 'Sableye', moves: ['Knock Off'], level: 50 }],
      p1active: [0, 1], p2active: [0, 1],
    });
    const dx = (battle as unknown as { dex: { species: { get(n: string): { abilities?: Record<string, string> } } } }).dex;
    let diverged = 0;
    for (const { forme } of formes) {
      const ours = megaFormeAbility(forme);
      const theirs = dx.species.get(forme)?.abilities?.['0'];
      if (norm(ours) !== norm(theirs)) {
        diverged++;
        warn(`${forme}: we say "${ours}", sim says "${theirs}" — /exact will resolve it wrong`);
      }
    }
    if (!diverged) ok('sim abilities match ours for every legal mega forme');
  }

  // ---- 4. Pikalytics freshness --------------------------------------------
  console.log('\n=== 4. Pikalytics priors ===');
  const pikaPath = join(dataDirPath(), `pikalytics.${CHAMPIONS_PIKA_FORMAT}.json`);
  if (existsSync(pikaPath)) ok(`${CHAMPIONS_PIKA_FORMAT} dump present`);
  else warn(`no dump for the active slug ${CHAMPIONS_PIKA_FORMAT} — run refresh-pikalytics (expect no usage for ~2 weeks after a rotation)`);
  const notes = fmt.__notes ?? '';
  const slugRegSuffix = CHAMPIONS_PIKA_FORMAT.match(/reg([a-z]+)$/)?.[1]?.toUpperCase();
  if (slugRegSuffix && !new RegExp(`M-${slugRegSuffix[slugRegSuffix.length - 1]}`, 'i').test(notes.slice(-1200))) {
    warn(`format __notes mention a newer regulation than the Pikalytics slug (${CHAMPIONS_PIKA_FORMAT}) — repoint CHAMPIONS_PIKA_FORMAT on switch-day`);
  }

  // ---- 5. gauntlet ---------------------------------------------------------
  console.log('\n=== 5. hand-built threat gauntlet ===');
  let illegal = 0;
  for (const t of ALL_THREATS) {
    for (const s of t.sets) {
      if (s.item && !fmt.items.allow.includes(toId(s.item))) { block(`[${t.anchor}] ${s.species} holds illegal ${s.item}`); illegal++; }
      if (!fmt.legality.allow.includes(toId(s.species))) { block(`[${t.anchor}] ${s.species} is not legal`); illegal++; }
    }
  }
  if (!illegal) ok(`${ALL_THREATS.length} threat teams, all legal in the active format`);
  const covered = new Set(ALL_THREATS.flatMap(t => t.sets.map(s => toId(s.item ?? ''))));
  const uncoveredStones = formes.filter(f => !covered.has(toId(f.stone))).map(f => f.stone);
  if (uncoveredStones.length) {
    console.log(`  note  ${uncoveredStones.length}/${formes.length} legal stones have no threat team (fine — the gauntlet samples, it doesn't enumerate)`);
  }

  // ---- verdict -------------------------------------------------------------
  console.log('\n=== verdict ===');
  if (blockers.length) {
    console.log(`  ${blockers.length} BLOCKER(S):`);
    for (const b of blockers) console.log(`    - ${b}`);
  }
  if (warnings.length) {
    console.log(`  ${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`    - ${w}`);
  }
  if (!blockers.length && !warnings.length) console.log('  clean — the active format is switch-day ready.');
  else if (!blockers.length) console.log('  no blockers; the warnings above are the known-pending items.');
  process.exit(blockers.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
