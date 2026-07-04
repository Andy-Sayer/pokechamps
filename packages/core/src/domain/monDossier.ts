// Per-mon dossier — the data the bring fallback needs to classify a faced opponent
// (known or novel): base stats, types, ability, offensive orientation, role tags, and
// a LIKELY MOVESET. Moves are AUTHORITATIVE from Pikalytics usage (every move run
// ≥25% of the time) where we have it; elsewhere they're inferred from a rational
// heuristic that only captures stat/ability-DERIVABLE patterns (STAB by orientation,
// spread coverage, Fake Out, priority, weather-context, Trick Room by speed, recovery)
// — never a fabricated exact set. Mega-capable mons get an entry per legal mega forme
// (mega stats/types/ability + base learnset), since that's how they're played.
// Generated offline by scripts/build-dossier.ts; read at preview time.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getSpecies, getLearnset, getMove, loadFormat, isLegalItem, toId, dataDirPath, CHAMPIONS_PIKA_FORMAT } from './data.js';
import { loadPikaData } from './metaTeams.js';
import { getMegaOptions, megaFormeAbility } from './gimmicks/mega.js';
import { effectiveness } from './typechart.js';
import type { ChampionsFormat, Stats } from './types.js';

const S = (arr: string[]) => new Set(arr.map(toId));
const PROTECT_CORE = S(['protect', 'detect']);
const SPEED_CTRL = S(['tailwind', 'trickroom', 'icywind', 'electroweb', 'bulldoze', 'rocktomb', 'thunderwave', 'scaryface', 'cottonspore', 'stringshot']);
const REDIRECT = S(['followme', 'ragepowder']);
const PIVOT = S(['uturn', 'voltswitch', 'flipturn', 'partingshot', 'teleport', 'batonpass']);
const SETUP = S(['swordsdance', 'nastyplot', 'dragondance', 'calmmind', 'quiverdance', 'bulkup', 'shellsmash', 'tailglow', 'irondefense', 'victorydance', 'agility']);
const STATUS_CTRL = S(['willowisp', 'thunderwave', 'taunt', 'encore', 'yawn', 'spore', 'sleeppowder', 'hypnosis', 'haze', 'clearsmog']);
const SCREENS = S(['lightscreen', 'reflect', 'auroraveil']);
const RECOVERY = S(['recover', 'roost', 'softboiled', 'moonlight', 'morningsun', 'synthesis', 'slackoff', 'wish', 'strengthsap', 'rest', 'lifedew', 'junglehealing']);
const WEATHER_MV = S(['raindance', 'sunnyday', 'snowscape', 'chillyreception', 'sandstorm']);
const WEATHER_ABIL = S(['drizzle', 'drought', 'snowwarning', 'sandstream', 'orichalcumpulse', 'desolateland', 'primordialsea']);
const PRIORITY_MV = S(['suckerpunch', 'aquajet', 'bulletpunch', 'extremespeed', 'grassyglide', 'iceshard', 'machpunch', 'shadowsneak', 'vacuumwave', 'jetpunch', 'quickattack', 'watershuriken', 'feint', 'accelerock', 'firstimpression']);
// Non-competitive damage moves (recharge / charge / self-KO / gimmick) — a multiplier
// on effective power so a 95-BP spammable beats a 150-BP recharge.
const DMG_PENALTY: Record<string, number> = {};
for (const id of ['hyperbeam', 'gigaimpact', 'blastburn', 'hydrocannon', 'frenzyplant', 'roaroftime', 'prismaticlaser', 'meteorassault', 'eternabeam', 'gigatonhammer']) DMG_PENALTY[toId(id)] = 0.22;
for (const id of ['selfdestruct', 'explosion', 'mistyexplosion', 'finalgambit']) DMG_PENALTY[toId(id)] = 0.28;
for (const id of ['solarbeam', 'solarblade', 'skullbash', 'skyattack', 'freezeshock', 'iceburn', 'razorwind', 'meteorbeam', 'electroshot', 'dig', 'fly', 'bounce', 'dive', 'phantomforce', 'shadowforce', 'skydrop']) DMG_PENALTY[toId(id)] = 0.5;
for (const id of ['outrage', 'thrash', 'petaldance', 'ragingfury']) DMG_PENALTY[toId(id)] = 0.82;
for (const id of ['focuspunch', 'lastresort', 'dreameater', 'synchronoise', 'bide', 'spitup']) DMG_PENALTY[toId(id)] = 0.25;

export type RoleTag = 'weather' | 'speedControl' | 'trickRoom' | 'redirect' | 'intimidate' | 'fakeOut' | 'pivot' | 'priority' | 'setup' | 'wall';
export type Orientation = 'physical' | 'special' | 'mixed';
export interface DossierEntry {
  species: string;        // base species name
  forme?: string;         // mega forme name when this entry is the mega
  label: string;          // forme ?? species (display + analog key)
  types: string[];
  baseStats: Stats;
  ability?: string;       // mega ability when forme, else the dex primary
  orientation: Orientation;
  supportLean: boolean;
  roles: RoleTag[];
  moves: string[];        // move ids; ≥25%-usage union (usage) or inferred likely set
  moveSource: 'usage' | 'inferred';
}

interface Cand { id: string; name: string; score: number; kind: 'stab' | 'coverage' | 'protect' | 'util'; type?: string; cat?: string; }

/** True when the mon is played as a support/pivot rather than a raw attacker. */
function isSupportLean(b: Stats, abils: string[]): boolean {
  const offense = Math.max(b.atk, b.spa);
  const hasWeatherAbil = abils.some(a => WEATHER_ABIL.has(a));
  return offense < 95
    || abils.some(a => a === 'prankster' || a === 'friendguard' || a === 'regenerator')
    || (hasWeatherAbil && offense < 110)               // offensive weather setters stay attackers
    || (b.hp + b.def + b.spd >= 340 && offense < 110);
}

/** Rational likely-set inference for a mon with NO usage data — derivable patterns only. */
function inferLikelyMoves(baseName: string, forme: string | undefined, types: string[], b: Stats, abils: string[]): string[] {
  const supportLean = isSupportLean(b, abils);
  const hasWeatherAbil = abils.some(a => WEATHER_ABIL.has(a));
  const cands: Cand[] = [];
  for (const mv of getLearnset(baseName)) {
    let m: ReturnType<typeof getMove>;
    try { m = getMove(mv); } catch { continue; }
    if (!m) continue;
    const id = toId(m.name);
    const bp = (m as any).basePower ?? 0;
    const cat = (m as any).category as string;
    const mtype = (m as any).type as string;
    const accRaw = (m as any).accuracy;
    const acc = (accRaw === true || accRaw == null ? 100 : accRaw) / 100;

    if (cat === 'Status' || bp === 0) {
      let s = 0; let kind: Cand['kind'] = 'util';
      if (PROTECT_CORE.has(id)) { s = 200; kind = 'protect'; }
      else if (REDIRECT.has(id)) s = supportLean ? 150 : 15;
      else if (id === 'helpinghand') s = supportLean ? 95 : 30;
      else if (id === 'trickroom') s = b.spe <= 50 ? 115 : b.spe <= 70 ? 85 : b.spe <= 90 ? 62 : 8;
      else if (id === 'tailwind') s = supportLean ? 110 : b.spe >= 95 ? 68 : 38;
      else if (SPEED_CTRL.has(id)) s = supportLean ? 95 : 45;
      else if (SETUP.has(id)) s = Math.max(b.atk, b.spa) >= 120 ? 65 : Math.max(b.atk, b.spa) >= 100 ? 38 : 12;
      else if (SCREENS.has(id)) s = supportLean ? 60 : 20;
      else if (WEATHER_MV.has(id)) s = hasWeatherAbil ? 15 : supportLean ? 60 : 35;
      else if (RECOVERY.has(id)) s = (b.hp + b.def + b.spd >= 300) ? 78 : 30;
      else if (STATUS_CTRL.has(id)) s = supportLean ? 70 : 35;
      else if (id === 'wideguard' || id === 'quickguard') s = 45;
      else if (PIVOT.has(id)) s = supportLean ? 90 : 45;
      else s = 8;
      cands.push({ id, name: m.name, score: s, kind });
    } else {
      if (id === 'fakeout') { cands.push({ id, name: m.name, score: 95, kind: 'util' }); continue; }
      const stat = cat === 'Physical' ? b.atk : b.spa;
      const stab = types.map(toId).includes(toId(mtype)) ? 1.5 : 1;
      const mh = (m as any).multihit;
      const hits = Array.isArray(mh) ? (mh[0] + mh[1]) / 2 : (typeof mh === 'number' ? mh : 1);
      const eff = bp * hits;
      const filler = stab === 1 && eff <= 60 && !PIVOT.has(id) && !PRIORITY_MV.has(id) ? 0.55 : 1;
      const normalCov = toId(mtype) === 'normal' && stab === 1 && !PRIORITY_MV.has(id) ? 0.35 : 1;
      const tgt = (m as any).target;
      const spread = (tgt === 'allAdjacentFoes' || tgt === 'allAdjacent') ? 1.4 : 1;
      let s = eff * (stat / 100) * stab * acc * (DMG_PENALTY[id] ?? 1) * filler * normalCov * spread;
      if (hasWeatherAbil && (id === 'weatherball' || id === 'solarbeam' || id === 'solarblade')) s = Math.max(s, 125);
      if (PRIORITY_MV.has(id)) s += 40;
      if (id === 'knockoff') s += 30;
      if (PIVOT.has(id)) s += 25;
      cands.push({ id, name: m.name, score: s, kind: stab > 1 ? 'stab' : 'coverage', type: mtype, cat });
    }
  }

  // Dedup attacks by type+category (keeps Draco Meteor AND Dragon Claw), keep it generous.
  const CAP = 8;
  const bestPerTC = new Map<string, Cand>();
  for (const c of cands) {
    if (c.kind !== 'stab' && c.kind !== 'coverage') continue;
    const key = `${toId(c.type ?? '')}|${c.cat ?? ''}`;
    const cur = bestPerTC.get(key);
    if (!cur || cur.score < c.score) bestPerTC.set(key, c);
  }
  const attacks = [...bestPerTC.values()].sort((a, b2) => b2.score - a.score);
  const stabs = attacks.filter(a => a.kind === 'stab');
  const cover = attacks.filter(a => a.kind === 'coverage');
  const utils = cands.filter(c => c.kind === 'util').sort((a, b2) => b2.score - a.score);
  const protect = cands.find(c => c.id === 'protect') ?? cands.find(c => c.kind === 'protect');

  const picks: Cand[] = [];
  const push = (c?: Cand) => { if (c && picks.length < CAP && !picks.some(p => p.id === c.id)) picks.push(c); };
  push(protect);
  const utilBar = supportLean ? 40 : 55;
  for (const x of utils) if (x.score >= utilBar) push(x);
  for (const a of stabs) push(a);
  let nc = 0; const coverTarget = supportLean ? 1 : 3;
  for (const c of cover) { if (nc >= coverTarget) break; push(c); nc++; }
  for (const c of [...cover, ...utils]) push(c);
  return picks.slice(0, CAP).map(p => p.id);
}

/** Role tags from a moveset (usage or inferred) + ability + stats. */
function rolesFrom(moveIds: string[], abils: string[], b: Stats): RoleTag[] {
  const mv = new Set(moveIds.map(toId));
  const has = (set: Set<string>) => [...mv].some(m => set.has(m));
  const roles: RoleTag[] = [];
  if (abils.some(a => WEATHER_ABIL.has(a)) || has(WEATHER_MV)) roles.push('weather');
  if (has(SPEED_CTRL)) roles.push('speedControl');
  if (mv.has('trickroom')) roles.push('trickRoom');
  if (has(REDIRECT)) roles.push('redirect');
  if (abils.includes('intimidate')) roles.push('intimidate');
  if (mv.has('fakeout')) roles.push('fakeOut');
  if (has(PIVOT)) roles.push('pivot');
  if (has(PRIORITY_MV) || abils.includes('galewings')) roles.push('priority');
  if (has(SETUP)) roles.push('setup');
  if (b.hp + b.def + b.spd >= 320 && has(RECOVERY)) roles.push('wall');
  return roles;
}

const orientationOf = (b: Stats): Orientation =>
  b.atk - b.spa >= 20 ? 'physical' : b.spa - b.atk >= 20 ? 'special' : 'mixed';

/** Build the dossier for every legal species + legal mega forme. */
export function buildDossier(format: ChampionsFormat = loadFormat()): DossierEntry[] {
  const pika = loadPikaData();
  const usageById = new Map<string, string[]>();
  for (const [name, d] of Object.entries(pika.pokemon)) {
    const moves = (d as any).moves as { name: string; pct: number }[] | undefined;
    if (moves?.length) usageById.set(toId(name), moves.filter(m => m.pct >= 25).map(m => toId(m.name)));
  }
  const ids = [...new Set(format.legality.allow.map(toId))];
  const out: DossierEntry[] = [];

  const entryFor = (baseName: string, forme?: string): DossierEntry | null => {
    let sp; try { sp = getSpecies(forme ?? baseName); } catch { return null; }
    if (!sp?.baseStats) return null;
    const b = sp.baseStats as Stats;
    const types: string[] = sp.types ?? [];
    const abils = forme ? [toId(megaFormeAbility(forme) ?? '')].filter(Boolean) : (Object.values(sp.abilities ?? {}) as string[]).map(toId);
    // Pikalytics keys megas under the base name, so both base and mega map to the same usage list.
    const usage = usageById.get(toId(baseName));
    const moves = usage ?? inferLikelyMoves(baseName, forme, types, b, abils);
    return {
      species: getSpecies(baseName).name, forme, label: forme ?? getSpecies(baseName).name,
      types, baseStats: b, ability: abils[0],
      orientation: orientationOf(b), supportLean: isSupportLean(b, abils),
      roles: rolesFrom(moves, abils, b), moves, moveSource: usage ? 'usage' : 'inferred',
    };
  };

  for (const id of ids) {
    let name; try { name = getSpecies(id).name; } catch { continue; }
    const base = entryFor(name);
    if (base) out.push(base);
    for (const opt of getMegaOptions(name)) {
      if (!isLegalItem(opt.stone)) continue;
      const mega = entryFor(name, opt.forme);
      if (mega) out.push(mega);
    }
  }
  return out;
}

// ---- consumers: read the baked dossier + classify a faced opponent ----

let _cache: DossierEntry[] | null = null;
/** Load the baked dossier (data/mon-dossier.<format>.json). Empty if not built yet. */
export function loadDossier(): DossierEntry[] {
  if (_cache) return _cache;
  const path = join(dataDirPath(), `mon-dossier.${CHAMPIONS_PIKA_FORMAT}.json`);
  _cache = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as DossierEntry[] : [];
  return _cache;
}
/** Base-forme dossier entry for a species (the primary classification). */
export function dossierBase(species: string): DossierEntry | undefined {
  const id = toId(species);
  return loadDossier().find(e => !e.forme && toId(e.species) === id);
}

const HEAVY_ROLES: RoleTag[] = ['weather', 'speedControl', 'redirect', 'intimidate'];
const SOFT_ROLES: RoleTag[] = ['trickRoom', 'fakeOut', 'pivot', 'priority', 'setup', 'wall'];
/** Role+type+orientation distance for analog matching (lower = more alike). A HEAVY-role
 *  mismatch dominates — a weather setter is NOT interchangeable with a sweeper. */
export function monDistance(a: DossierEntry, b: DossierEntry): number {
  let d = 0;
  for (const r of HEAVY_ROLES) if (a.roles.includes(r) !== b.roles.includes(r)) d += 3;
  for (const r of SOFT_ROLES) if (a.roles.includes(r) !== b.roles.includes(r)) d += 0.6;
  if (a.orientation !== b.orientation) d += 0.8;
  const sb = new Set(b.types);
  const inter = a.types.filter(t => sb.has(t)).length;
  const uni = new Set([...a.types, ...b.types]).size || 1;
  return d - 2 * (inter / uni);
}
/** The nearest analog to `mon` among `pool`, with its distance. `safe` = a genuinely
 *  close match (no HEAVY-role mismatch and small distance) — else "no safe analog". */
export function nearestAnalog(mon: DossierEntry, pool: DossierEntry[]): { analog: DossierEntry; dist: number; safe: boolean } | null {
  let best: { analog: DossierEntry; dist: number } | null = null;
  for (const p of pool) {
    if (toId(p.species) === toId(mon.species) && p.forme === mon.forme) continue;
    const dist = monDistance(mon, p);
    if (!best || dist < best.dist) best = { analog: p, dist };
  }
  if (!best) return null;
  const heavyMiss = HEAVY_ROLES.some(r => best!.analog.roles.includes(r) !== mon.roles.includes(r));
  return { ...best, safe: !heavyMiss && best.dist <= 1.5 };
}

/** The strongest type-effectiveness this mon's LIKELY moves get vs a defender's types. */
export function bestSEAgainst(attacker: DossierEntry, defenderTypes: string[]): { mult: number; type: string } {
  let best = { mult: 1, type: '' };
  for (const mid of attacker.moves) {
    let m: ReturnType<typeof getMove>;
    try { m = getMove(mid); } catch { continue; }
    const t = (m as any)?.type as string | undefined;
    const cat = (m as any)?.category as string | undefined;
    if (!t || cat === 'Status') continue;
    const mult = effectiveness(t, defenderTypes);
    if (mult > best.mult) best = { mult, type: t };
  }
  return best;
}
