// A gauntlet-ready set for a mon with NO usage data.
//
// THE PROBLEM. Every opponent-team builder bottoms out in metaTeams.buildSet,
// whose second line is `if (!pika.pokemon[name]) return null`. For the first ~2
// weeks after a regulation rotation that is true of every newly-legal species,
// so groundedTeams / composeTeam / creatorIntel all silently drop exactly the
// mons the rotation is about. creatorIntel feels this worst: its whole purpose
// is to be a LEADING indicator ahead of Pikalytics' lagging usage, and it could
// not construct the emerging mon it exists to catch ("built only N sets (no
// Pikalytics data for: ...)").
//
// THE APPROACH. Do not invent a spread. Use the dossier's nearestAnalog to find
// the mechanically closest mon that DOES have usage — same heavy roles, similar
// types and offensive orientation — and borrow that analog's real spread, nature
// and item, while keeping the new mon's OWN inferred moves and ability. So the
// shape of the set comes from something a human actually played; only the moves
// are inferred, and monDossier already owns that inference.
//
// PROVENANCE IS NOT OPTIONAL. PokemonSet matches the Showdown export field for
// field, so there is nowhere to stash "this was inferred" on the set itself.
// Instead every entry point returns the source alongside the set, and callers
// are expected to surface it. A synthetic opponent that silently passes for a
// real one is how a gauntlet quietly starts lying — see the benched-anchor
// defect in docs/notes/regulation-m-c.md for what that costs.
//
// SEPARATE MODULE ON PURPOSE. monDossier imports metaTeams, so metaTeams cannot
// import monDossier back. This module sits above both.
import { getMove, getSpecies, isLegalItem, loadFormat, toId } from './data.js';
import { evFromSp } from './pikalytics.js';
import { loadPikaData, buildSet, baseSpeciesFor, type PikaData } from './metaTeams.js';
import { loadDossier, dossierBase, nearestAnalog, rolesFrom, type DossierEntry } from './monDossier.js';
import { getMegaOptions } from './gimmicks/mega.js';
import type { PokemonSet } from './types.js';

const MAX_IVS = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
const ITEMLESS = new Set(['noitem', 'nothing', 'none', '']);

/** Where a set's numbers came from. 'usage' = real Pikalytics data; 'analog' =
 *  spread borrowed from the nearest mon that has usage; 'derived' = no usable
 *  analog, spread computed from base stats alone (the weakest tier). */
export type SetSource = 'usage' | 'analog' | 'derived';

export interface SourcedSet { set: PokemonSet; source: SetSource; analog?: string; safe: boolean }

/** Mons the dossier built from REAL usage — the only valid analog pool. An entry
 *  whose own moves were inferred cannot lend credibility to another. */
function analogPool(): DossierEntry[] {
  return loadDossier().filter(e => e.moveSource === 'usage' && !e.forme);
}

/** Fully-derived spread: no analog was close enough, so fall back to base stats.
 *  Deliberately blunt — a 252/252 shape keyed on orientation and speed tier. It
 *  is a placeholder for a real set, and `source: 'derived'` says so. */
function derivedSpread(e: DossierEntry): { nature: string; evs: PokemonSet['evs'] } {
  const b = e.baseStats;
  const phys = e.orientation === 'physical' || (e.orientation === 'mixed' && b.atk >= b.spa);
  const evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  if (e.supportLean) {
    // Support mons are played for bulk, not for a stat. Invest in HP + the
    // weaker defence so the mon survives long enough to do its job.
    evs.hp = 252;
    if (b.def <= b.spd) { evs.def = 252; return { nature: 'Bold', evs }; }
    evs.spd = 252; return { nature: 'Calm', evs };
  }
  if (phys) evs.atk = 252; else evs.spa = 252;
  if (b.spe >= 90) { evs.spe = 252; return { nature: phys ? 'Jolly' : 'Timid', evs }; }
  evs.hp = 252;
  // A genuinely slow attacker is a Trick Room piece, so the -Spe nature is the
  // right default rather than a mistake.
  if (b.spe <= 55) return { nature: phys ? 'Brave' : 'Quiet', evs };
  return { nature: phys ? 'Adamant' : 'Modest', evs };
}

/** First legal, unused item from a preference list; '' when none is available. */
function pickItem(prefs: (string | undefined)[], usedItems: Set<string>): string {
  const format = loadFormat();
  for (const p of prefs) {
    const name = p ?? '';
    if (!name || ITEMLESS.has(toId(name))) continue;
    if (usedItems.has(toId(name))) continue;
    if (!isLegalItem(toId(name), format)) continue;
    return name;
  }
  return '';
}

/** Move ids -> display names, dropping anything the dex cannot resolve. */
function resolveNames(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    try {
      const n = (getMove(id) as { name?: string } | undefined)?.name;
      if (n && !out.includes(n)) out.push(n);
    } catch { /* an id the dex dropped — skip it */ }
  }
  return out;
}

/** Choose 4 moves from the dossier's CANDIDATE POOL.
 *
 *  DossierEntry.moves is a pool of ~8, ordered by the dossier's own scoring —
 *  it is a classification aid, not a chosen set. Taking the first four is wrong
 *  in a specific, silent way: it can drop the move that earned the mon its role.
 *  Rillaboom's pool is [protect, fakeout, bulkup, woodhammer, grassyglide, ...],
 *  so first-four yields a Grassy Surge mon with NO priority move, while the same
 *  dossier entry is tagged `priority`. The set then contradicts its own label,
 *  and every downstream read (bring scoring, THREATS) inherits the contradiction.
 *
 *  So: seed with the moves that realise the entry's roles, then fill in pool
 *  order. Role realisation is checked with the dossier's OWN rolesFrom, so this
 *  cannot drift from how roles are assigned in the first place. */
function pickMoves(entry: DossierEntry, abils: string[]): string[] {
  const pool = entry.moves.filter(id => { try { return !!getMove(id); } catch { return false; } });
  const picked: string[] = [];
  const rolesOf = (ids: string[]) => new Set(rolesFrom(ids, abils, entry.baseStats));
  for (const role of entry.roles) {
    if (picked.length >= 4) break;
    if (rolesOf(picked).has(role)) continue;
    const add = pool.find(id => !picked.includes(id) && rolesOf([...picked, id]).has(role));
    if (add) picked.push(add);
  }
  for (const id of pool) {
    if (picked.length >= 4) break;
    if (!picked.includes(id)) picked.push(id);
  }
  return resolveNames(picked).slice(0, 4);
}

/** Build a set for a species with no usage data, from its dossier entry.
 *  Returns null when the dossier has nothing (i.e. the species is not legal, or
 *  the dossier predates it and needs `npm run build-dossier`). */
export function inferredSet(
  species: string,
  usedItems: Set<string>,
  opts: { megaAvailable?: boolean } = {},
): SourcedSet | null {
  const entry = dossierBase(species);
  if (!entry) return null;
  const abils = [entry.ability ?? ''].map(a => toId(a)).filter(Boolean);
  const moves = pickMoves(entry, abils);
  if (moves.length < 4) return null;

  const format = loadFormat();
  const name = baseSpeciesFor((getSpecies(toId(species)) as { name?: string } | undefined)?.name ?? species);

  // Spread: prefer a real one borrowed from the closest mon that has usage.
  const near = nearestAnalog(entry, analogPool());
  const pika = loadPikaData();
  const analogData = near?.safe ? pika.pokemon[near.analog.species] : undefined;
  const top = analogData?.topSpread;

  let nature: string;
  let evs: PokemonSet['evs'];
  let source: SetSource;
  if (top?.sp) {
    const sp = top.sp;
    evs = {
      hp: evFromSp(sp[0] ?? 0), atk: evFromSp(sp[1] ?? 0), def: evFromSp(sp[2] ?? 0),
      spa: evFromSp(sp[3] ?? 0), spd: evFromSp(sp[4] ?? 0), spe: evFromSp(sp[5] ?? 0),
    };
    nature = top.nature ?? 'Hardy';
    source = 'analog';
  } else {
    ({ nature, evs } = derivedSpread(entry));
    source = 'derived';
  }

  // Item: in a Mega format a mon that HAS a stone is usually played with it, so
  // the stone wins when the team has not already spent its mega. Otherwise take
  // the analog's real item, then a small generic fallback.
  const stone = opts.megaAvailable
    ? getMegaOptions(name).map(m => m.stone).find(s => isLegalItem(toId(s), format) && !usedItems.has(toId(s)))
    : undefined;
  const analogItem = analogData?.featuredSets?.[0]?.item
    ?? analogData?.items?.find(i => i.name !== 'Other')?.name;
  const item = pickItem([stone, analogItem, 'Sitrus Berry', 'Leftovers', 'Focus Sash'], usedItems);

  const ability = entry.ability
    ?? Object.values((getSpecies(toId(name)) as { abilities?: Record<string, string> } | undefined)?.abilities ?? {})[0]
    ?? '';

  if (item) usedItems.add(toId(item));
  return {
    set: { species: name, level: format.level, nature, ability, item: item || undefined, evs, ivs: { ...MAX_IVS }, moves },
    source,
    analog: near?.safe ? (near.analog.forme ?? near.analog.species) : undefined,
    safe: source === 'analog',
  };
}

/** buildSet, with the dossier as a fallback instead of returning null.
 *  Real usage always wins; inference only fills the hole a rotation leaves. */
export function buildSetOrInfer(
  pika: PikaData,
  name: string,
  usedItems: Set<string>,
  opts: { megaAvailable?: boolean } = {},
): SourcedSet | null {
  const real = buildSet(pika, name, usedItems);
  if (real) return { set: real, source: 'usage', safe: true };
  return inferredSet(name, usedItems, opts);
}

/** One-line provenance summary for a built team — what a caller should print so
 *  a synthetic opponent never passes for a real one. */
export function describeSources(sourced: SourcedSet[]): string {
  const n = (s: SetSource) => sourced.filter(x => x.source === s).length;
  const parts = [`${n('usage')} from usage`];
  const analogs = sourced.filter(x => x.source === 'analog');
  if (analogs.length) parts.push(`${analogs.length} analog-spread (${analogs.map(a => `${a.set.species}~${a.analog}`).join(', ')})`);
  if (n('derived')) parts.push(`${n('derived')} stat-derived (${sourced.filter(x => x.source === 'derived').map(x => x.set.species).join(', ')})`);
  return parts.join(' · ');
}
