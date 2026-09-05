// Per-mon dossier — the data the bring fallback needs to classify a faced opponent
// (known or novel): base stats, types, ability, offensive orientation, role tags, and
// a LIKELY MOVESET. Moves are AUTHORITATIVE from Pikalytics usage (every move run
// ≥25% of the time) where we have it; elsewhere they're inferred from a rational
// heuristic that only captures stat/ability-DERIVABLE patterns (STAB by orientation,
// spread coverage, Fake Out, priority, weather/terrain context, Trick Room by speed,
// recovery, and the ability biases below: -ate retyping, No Guard, Sharpness / Tough
// Claws / Iron Fist / Strong Jaw / Mega Launcher / Punk Rock, Technician)
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

// ---- ability -> move-choice biases -----------------------------------------
// The generic scorer prices a move by BP x stat x STAB x accuracy. Several
// abilities move that ranking so far that ignoring them yields a set the mon
// would never run — Mega Salamence's signature is Aerilate Double-Edge, which
// the plain Normal-coverage penalty buries entirely. These are all
// stat/ability-DERIVABLE, so they stay inside this note's "never fabricate an
// exact set" contract.

/** Abilities that retype the holder's NORMAL moves (and add x1.2). The "-ate"
 *  family plus Champions' custom Dragonize (Feraligatr-Mega). */
const ATE_ABILITY: Record<string, string> = {
  aerilate: 'Flying', pixilate: 'Fairy', refrigerate: 'Ice', galvanize: 'Electric', dragonize: 'Dragon',
};
/** Ability -> the move flag it powers up, and by how much. */
const FLAG_BOOST: Record<string, { flag: string; mult: number }> = {
  sharpness: { flag: 'slicing', mult: 1.5 },      // Absol-Mega-Z: Night Slash / Psycho Cut
  toughclaws: { flag: 'contact', mult: 1.3 },     // Barbaracle-Mega
  ironfist: { flag: 'punch', mult: 1.2 },
  strongjaw: { flag: 'bite', mult: 1.5 },
  megalauncher: { flag: 'pulse', mult: 1.5 },
  punkrock: { flag: 'sound', mult: 1.3 },
};
/** Auto-terrain abilities: the terrain's own x1.3 on that type. Rillaboom's
 *  Grassy Glide is the case this exists for. */
const TERRAIN_ABIL_TYPE: Record<string, string> = {
  grassysurge: 'Grass', electricsurge: 'Electric', psychicsurge: 'Psychic',
};
/** Auto-weather abilities: x1.5 on the favoured type, x0.5 on the opposed one. */
const WEATHER_ABIL_TYPES: Record<string, { up: string; down: string }> = {
  drizzle: { up: 'Water', down: 'Fire' }, primordialsea: { up: 'Water', down: 'Fire' },
  drought: { up: 'Fire', down: 'Water' }, desolateland: { up: 'Fire', down: 'Water' },
  orichalcumpulse: { up: 'Fire', down: 'Water' },
};

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
      // Rest is a real recovery move but a bad VGC one (two turns asleep), so it
      // should never outrank Roost/Recover/Synthesis for the one recovery slot.
      else if (RECOVERY.has(id)) s = ((b.hp + b.def + b.spd >= 300) ? 78 : 30) * (id === 'rest' ? 0.6 : 1);
      else if (STATUS_CTRL.has(id)) s = supportLean ? 70 : 35;
      else if (id === 'wideguard' || id === 'quickguard') s = 45;
      else if (PIVOT.has(id)) s = supportLean ? 90 : 45;
      else s = 8;
      cands.push({ id, name: m.name, score: s, kind });
    } else {
      if (id === 'fakeout') { cands.push({ id, name: m.name, score: 95, kind: 'util' }); continue; }
      const stat = cat === 'Physical' ? b.atk : b.spa;
      // -ate retype FIRST: it changes the move's TYPE, so STAB and the
      // Normal-coverage penalty both follow from the new type, plus x1.2 power.
      const ateType = abils.map(a => ATE_ABILITY[a]).find(Boolean);
      const retyped = !!ateType && toId(mtype) === 'normal';
      const effType = retyped ? ateType! : mtype;
      const stab = types.map(toId).includes(toId(effType)) ? 1.5 : 1;
      const mh = (m as any).multihit;
      const hits = Array.isArray(mh) ? (mh[0] + mh[1]) / 2 : (typeof mh === 'number' ? mh : 1);
      const eff = bp * hits;
      const filler = stab === 1 && eff <= 60 && !PIVOT.has(id) && !PRIORITY_MV.has(id) ? 0.55 : 1;
      const normalCov = toId(effType) === 'normal' && stab === 1 && !PRIORITY_MV.has(id) ? 0.35 : 1;
      // Ability biases. No Guard pins accuracy at 100 (a 50%-accurate nuke stops
      // being a gamble and becomes the best move); the flag / terrain / weather
      // tables reprice the move classes the holder's ability actually rewards.
      const noGuard = abils.includes('noguard');
      const flagBoost = abils.map(a => FLAG_BOOST[a])
        .filter((x): x is { flag: string; mult: number } => !!x)
        .reduce((acc2, x) => acc2 * ((m as any).flags?.[x.flag] ? x.mult : 1), 1);
      const technician = abils.includes('technician') && bp <= 60 ? 1.5 : 1;
      const ateBoost = retyped ? 1.2 : 1;
      const terrainType = abils.map(a => TERRAIN_ABIL_TYPE[a]).find(Boolean);
      const terrainBoost = terrainType && toId(effType) === toId(terrainType) ? 1.3 : 1;
      const wx = abils.map(a => WEATHER_ABIL_TYPES[a]).find(Boolean);
      const weatherBoost = !wx ? 1 : toId(effType) === toId(wx.up) ? 1.5 : toId(effType) === toId(wx.down) ? 0.5 : 1;
      const abilityMult = flagBoost * technician * ateBoost * terrainBoost * weatherBoost;
      const tgt = (m as any).target;
      const spread = (tgt === 'allAdjacentFoes' || tgt === 'allAdjacent') ? 1.4 : 1;
      let s = eff * (stat / 100) * stab * (noGuard ? 1 : acc) * (DMG_PENALTY[id] ?? 1) * filler * normalCov * spread * abilityMult;
      if (hasWeatherAbil && (id === 'weatherball' || id === 'solarbeam' || id === 'solarblade')) s = Math.max(s, 125);
      if (PRIORITY_MV.has(id)) s += 40;
      if (id === 'knockoff') s += 30;
      if (PIVOT.has(id)) s += 25;
      cands.push({ id, name: m.name, score: s, kind: stab > 1 ? 'stab' : 'coverage', type: effType, cat });
    }
  }

  // Dedup attacks by type+category (keeps Draco Meteor AND Dragon Claw), keep it
  // generous. PRIORITY moves get their own bucket: Grassy Glide and Wood Hammer
  // are both Grass/Physical, but they are different tools and Rillaboom runs
  // both — collapsing them loses the priority that makes the mon.
  const CAP = 8;
  const bestPerTC = new Map<string, Cand>();
  for (const c of cands) {
    if (c.kind !== 'stab' && c.kind !== 'coverage') continue;
    const key = `${toId(c.type ?? '')}|${c.cat ?? ''}|${PRIORITY_MV.has(c.id) ? 'prio' : ''}`;
    const cur = bestPerTC.get(key);
    if (!cur || cur.score < c.score) bestPerTC.set(key, c);
  }
  const attacks = [...bestPerTC.values()].sort((a, b2) => b2.score - a.score);
  const stabs = attacks.filter(a => a.kind === 'stab');
  const cover = attacks.filter(a => a.kind === 'coverage');
  const utils = cands.filter(c => c.kind === 'util').sort((a, b2) => b2.score - a.score);
  const protect = cands.find(c => c.id === 'protect') ?? cands.find(c => c.kind === 'protect');

  // COMPOSITION. Scores alone let utilities flood the list: a 164 SpA mega
  // scores every setup move it learns above the bar, so Lucario-Mega-Z came out
  // as six setup moves and one attack — not a set anyone would bring. Two rules
  // fix it: a real set runs at most ONE move from each of these classes, and
  // attacks are guaranteed slots before utilities can take them all.
  const CLASS_CAP: Array<[Set<string>, number]> = [
    [RECOVERY, 1],      // rest + roost + wish is never a real set
    [SETUP, 1],
    [SPEED_CTRL, 1],    // Tailwind and Trick Room are mutually exclusive anyway
    [PIVOT, 1],
    [SCREENS, 2],       // Light Screen + Reflect do get paired
  ];
  const classCount = new Map<Set<string>, number>();
  const classAllows = (c: Cand) => {
    for (const [set, cap] of CLASS_CAP) {
      if (!set.has(c.id)) continue;
      if ((classCount.get(set) ?? 0) >= cap) return false;
    }
    return true;
  };
  const noteClasses = (c: Cand) => {
    for (const [set] of CLASS_CAP) if (set.has(c.id)) classCount.set(set, (classCount.get(set) ?? 0) + 1);
  };

  const picks: Cand[] = [];
  const push = (c?: Cand, limit = CAP) => {
    if (!c || picks.length >= limit || picks.some(p => p.id === c.id)) return;
    if (c.kind === 'util' && !classAllows(c)) return;
    noteClasses(c);
    picks.push(c);
  };
  push(protect);
  // Reserve room for attacks so the utility pass can't consume the whole set.
  const minAttacks = Math.min(supportLean ? 2 : 3, stabs.length + cover.length);
  const utilLimit = Math.max(1, CAP - minAttacks);
  const utilBar = supportLean ? 40 : 55;
  for (const x of utils) if (x.score >= utilBar) push(x, utilLimit);
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
    // Pikalytics keys megas under the base name, so the base's usage list would
    // otherwise be pinned onto EVERY one of its mega formes. That is right when
    // the mega plays the same way (Charizard-Mega-Y is the special attacker the
    // Charizard usage describes) and wrong when it doesn't: Garchomp's usage is
    // a physical Scarf/Sash set, but Garchomp-Mega-Z is a 141 SpA Levitating
    // mono-Dragon — inheriting Earthquake/Rock Slide there is a fabricated set,
    // and it is the NEW megas (no usage of their own for weeks after a rotation)
    // that get it most wrong. So a mega only inherits usage when its offensive
    // orientation matches the base's; otherwise it falls back to inference.
    const rawUsage = usageById.get(toId(baseName));
    const orientationMatches = !forme
      || orientationOf(b) === orientationOf(getSpecies(baseName).baseStats as Stats);
    const usage = rawUsage && orientationMatches ? rawUsage : undefined;
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
    // Regional formes (Alola/Galar/Hisui/Paldea) are legal via base-fallback but are
    // DISTINCT species — own types/stats/learnset (Ninetales-Alola is Ice/Fairy, not
    // Fire). Add each as its own entry, not a variant of the base.
    for (const forme of ((getSpecies(name) as { otherFormes?: string[] }).otherFormes ?? [])) {
      if (!/-(Alola|Galar|Hisui|Paldea)/.test(forme)) continue;
      const r = entryFor(forme);
      if (r) out.push(r);
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
