// Multi-part tactic detection for Champions doubles (Reg M-A).
//
// A "tactic" is a combo whose payoff needs more than one piece: two mons, or
// one mon + a specific move/ability/item conjunction (Perish Song + trapping,
// Speed Boost + Baton Pass, Trick Room + slow nuke, …). Detection is purely
// data-driven over the legal lists + learnsets — no LLM judgement anywhere.
//
// Profiles come in two modes:
//   - ACTUAL  (profileFromSet): my team's real moves/ability/item. A tactic
//     fires only if the pieces are genuinely on the sets — used for bring
//     synergy scoring.
//   - POTENTIAL (profileFromSpecies): full learnset + every legal ability,
//     item unknown. A tactic fires if the species COULD run it — used for
//     opponent threat detection and the format-wide catalog.
//
// Scores are explainable 0–100 heuristics from base stats — they rank combos
// within a pattern; cross-pattern comparison is rough by design.
import { getSpecies, getItem, getMove, getLearnset, loadFormat, toId } from './data.js';
import type { PokemonSet } from './types.js';

export interface MonProfile {
  /** Display species name ('Espathra', 'Charizard-Mega-Y'). */
  species: string;
  /** Move ids available to this mon. */
  moves: ReadonlySet<string>;
  /** Ability ids — exactly one in actual mode, all slots in potential mode. */
  abilities: readonly string[];
  /** Item id when known (actual mode / mega formes); null = unknown. */
  item: string | null;
  /** True when built from learnsets (anything-goes mode). */
  potential: boolean;
}

export interface TacticPiece {
  species: string;
  /** What this piece contributes ('singer', 'trapper', 'setter', 'abuser', …). */
  role: string;
  move?: string;
  ability?: string;
  item?: string;
}

export interface TacticInstance {
  /** Pattern id, e.g. 'perish-trap'. */
  pattern: string;
  /** Human-readable pattern name. */
  name: string;
  pieces: TacticPiece[];
  /** Turns of setup before the payoff starts mattering. */
  setupTurns: number;
  payoff: string;
  counters: string[];
  score: number;
}

interface SpeciesInfo {
  baseStats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
  types: string[];
  abilities: Record<string, string>;
}

function info(species: string): SpeciesInfo | null {
  const sp = getSpecies(species) as unknown as SpeciesInfo | undefined;
  return sp?.baseStats ? sp : null;
}

const offense = (s: SpeciesInfo) => Math.max(s.baseStats.atk, s.baseStats.spa);
const bulk = (s: SpeciesInfo) => s.baseStats.hp + s.baseStats.def + s.baseStats.spd;
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

// ---------------------------------------------------------------------------
// Move / ability / item knowledge tables (ids).
// ---------------------------------------------------------------------------

/** Setup moves → total boost stages and whether they raise Speed.
 *  Stage totals drive Baton Pass / Stored Power value. */
export const SETUP_MOVES: Record<string, { stages: number; spe: boolean }> = {
  swordsdance: { stages: 2, spe: false },
  nastyplot: { stages: 2, spe: false },
  calmmind: { stages: 2, spe: false },
  bulkup: { stages: 2, spe: false },
  irondefense: { stages: 2, spe: false },
  amnesia: { stages: 2, spe: false },
  agility: { stages: 2, spe: true },
  autotomize: { stages: 2, spe: true },
  rockpolish: { stages: 2, spe: true },
  dragondance: { stages: 2, spe: true },
  quiverdance: { stages: 3, spe: true },
  shellsmash: { stages: 4, spe: true },
  shiftgear: { stages: 3, spe: true },
  victorydance: { stages: 3, spe: true },
  bellydrum: { stages: 6, spe: false },
  filletaway: { stages: 6, spe: true },
  clangoroussoul: { stages: 5, spe: true },
  noretreat: { stages: 5, spe: true },
  growth: { stages: 2, spe: false },
  workup: { stages: 2, spe: false },
  curse: { stages: 2, spe: false },
  honeclaws: { stages: 2, spe: false },
  cosmicpower: { stages: 2, spe: false },
  stockpile: { stages: 2, spe: false },
};

const TRAP_MOVES = ['block', 'meanlook', 'jawlock', 'anchorshot', 'spiritshackle', 'thousandwaves', 'fairylock', 'octolock'];
const TRAP_ABILITIES = ['shadowtag', 'arenatrap'];
const REDIRECT_MOVES = ['followme', 'ragepowder'];
const GUARANTEED_CRIT_MOVES = ['frostbreath', 'stormthrow', 'wickedblow', 'surgingstrikes', 'flowertrick'];

const WEATHER_SET_ABILITIES: Record<string, 'sun' | 'rain' | 'sand' | 'snow'> = {
  drought: 'sun', orichalcumpulse: 'sun', drizzle: 'rain', sandstream: 'sand', snowwarning: 'snow',
  // Champions custom: Mega Sol is a PERSONAL sun (only the holder benefits) —
  // detector treats it as a self-only sun source.
  megasol: 'sun',
};
const WEATHER_SET_MOVES: Record<string, 'sun' | 'rain' | 'sand' | 'snow'> = {
  sunnyday: 'sun', raindance: 'rain', sandstorm: 'sand', snowscape: 'snow', chillyreception: 'snow',
};
const WEATHER_ABUSE_ABILITIES: Record<string, 'sun' | 'rain' | 'sand' | 'snow'> = {
  chlorophyll: 'sun', solarpower: 'sun', protosynthesis: 'sun',
  swiftswim: 'rain', raindish: 'rain', dryskin: 'rain',
  sandrush: 'sand', sandforce: 'sand',
  slushrush: 'snow', icebody: 'snow',
};
const WEATHER_ABUSE_MOVES: Record<string, 'sun' | 'rain'> = {
  solarbeam: 'sun', solarblade: 'sun',
  hurricane: 'rain', thunder: 'rain', weatherball: 'rain',
};

const TERRAIN_SET_ABILITIES: Record<string, 'electric' | 'psychic' | 'grassy' | 'misty'> = {
  electricsurge: 'electric', hadronengine: 'electric', psychicsurge: 'psychic',
  grassysurge: 'grassy', mistysurge: 'misty',
};
const TERRAIN_SET_MOVES: Record<string, 'electric' | 'psychic' | 'grassy' | 'misty'> = {
  electricterrain: 'electric', psychicterrain: 'psychic', grassyterrain: 'grassy', mistyterrain: 'misty',
};
const TERRAIN_ABUSE: Record<string, { kind: 'electric' | 'psychic' | 'grassy'; what: string }> = {
  risingvoltage: { kind: 'electric', what: 'move' },
  expandingforce: { kind: 'psychic', what: 'move' },
  grassyglide: { kind: 'grassy', what: 'move' },
  quarkdrive: { kind: 'electric', what: 'ability' },
  surgesurfer: { kind: 'electric', what: 'ability' },
};

/** Spread moves whose ally-side immunity makes them free in doubles. */
const SPREAD_IMMUNE: Record<string, { types: string[]; abilities: string[]; items: string[] }> = {
  earthquake: { types: ['Flying'], abilities: ['levitate'], items: ['airballoon'] },
  discharge: { types: ['Ground'], abilities: ['lightningrod', 'motordrive', 'voltabsorb'], items: [] },
  surf: { types: [], abilities: ['waterabsorb', 'stormdrain', 'dryskin'], items: [] },
  sludgewave: { types: ['Steel'], abilities: [], items: [] },
  heatwave: { types: [], abilities: ['flashfire'], items: [] },
};

function consumableItemIds(): string[] {
  const format = loadFormat();
  return format.items.allow.filter(id => {
    const item = getItem(id) as { isBerry?: boolean } | undefined;
    return item?.isBerry || id === 'focussash' || id === 'whiteherb';
  });
}

// ---------------------------------------------------------------------------
// Profile builders.
// ---------------------------------------------------------------------------

export function profileFromSet(set: PokemonSet): MonProfile {
  return {
    species: set.species,
    moves: new Set(set.moves.map(toId)),
    abilities: set.ability ? [toId(set.ability)] : [],
    item: set.item ? toId(set.item) : null,
    potential: false,
  };
}

export function profileFromSpecies(species: string): MonProfile {
  const sp = info(species);
  return {
    species,
    moves: new Set(getLearnset(species).map(toId)),
    abilities: Object.values(sp?.abilities ?? {}).map(toId),
    item: null,
    potential: true,
  };
}

/** Potential profile for a mega forme reachable via a legal stone: the BASE
 *  species' learnset with the MEGA forme's abilities/stats, item pinned to
 *  the stone. Brings the custom Champions abilities into detection. */
export function profileFromMegaStone(stoneId: string): MonProfile | null {
  // Dump shape: item.megaStone is a Record<baseSpeciesName, megaFormeName>
  // (one entry per stone) — see gimmicks/mega.ts.
  const item = getItem(stoneId) as { megaStone?: Record<string, string> } | undefined;
  const entry = item?.megaStone && Object.entries(item.megaStone)[0];
  if (!entry) return null;
  const [base, forme] = entry;
  const mega = info(forme);
  if (!mega) return null;
  return {
    species: forme,
    moves: new Set(getLearnset(base).map(toId)),
    abilities: Object.values(mega.abilities).map(toId),
    item: stoneId,
    potential: true,
  };
}

/** Hybrid battle-time profile for an opponent: revealed moves are certain
 *  (4 revealed = complete set), unrevealed fall back to the learnset;
 *  confirmed ability pins the list, rule-outs prune it; a known item pins
 *  item-dependent patterns (a revealed Choice item kills Unburden combos). */
export function profileFromOpponentEntry(entry: {
  species: string;
  knownMoves: string[];
  ability?: string | null;
  item?: string | null;
  abilitiesRuledOut?: string[];
  megaUsed?: boolean;
  megaForme?: string;
}): MonProfile {
  const speciesName = entry.megaUsed && entry.megaForme ? entry.megaForme : entry.species;
  const sp = info(speciesName);
  const known = entry.knownMoves.map(toId);
  const moves = known.length >= 4
    ? new Set(known)
    // Megas keep the BASE species' learnset.
    : new Set([...getLearnset(entry.species).map(toId), ...known]);
  const ruledOut = new Set((entry.abilitiesRuledOut ?? []).map(toId));
  const abilities = entry.ability
    ? [toId(entry.ability)]
    : Object.values(sp?.abilities ?? {}).map(toId).filter(a => !ruledOut.has(a));
  return {
    species: speciesName,
    moves,
    abilities,
    item: entry.item ? toId(entry.item) : null,
    potential: known.length < 4,
  };
}

const has = (p: MonProfile, moveId: string) => p.moves.has(moveId);
const hasAbility = (p: MonProfile, abilityId: string) => p.abilities.includes(abilityId);

/** Stats lookup for a profile — mega profiles carry the forme name. */
function statsOf(p: MonProfile): SpeciesInfo | null {
  return info(p.species);
}

// ---------------------------------------------------------------------------
// Pattern detectors. Each may emit single-mon and/or pair instances.
// ---------------------------------------------------------------------------

type Detector = (a: MonProfile, b: MonProfile | null) => TacticInstance[];

const detectPerishTrap: Detector = (a, b) => {
  const out: TacticInstance[] = [];
  const singer = has(a, 'perishsong') ? a : b && has(b, 'perishsong') ? b : null;
  if (!singer) return out;
  const other = singer === a ? b : a;
  const counters = ['Soundproof blocks the song', 'Taunt the trapper', 'KO the trapper to free switches', 'Shed Shell / pivot moves escape'];
  // Self-sufficient: one mon both sings and traps.
  const selfTrapMove = TRAP_MOVES.find(m => has(singer, m));
  const selfTrapAbility = TRAP_ABILITIES.find(ab => hasAbility(singer, ab));
  if ((selfTrapMove || selfTrapAbility) && (b === null || other === null)) {
    const s = statsOf(singer);
    out.push({
      pattern: 'perish-trap', name: 'Perish trap (self-sufficient)',
      pieces: [{ species: singer.species, role: 'singer+trapper', move: selfTrapMove ? `Perish Song + ${selfTrapMove}` : 'Perish Song', ability: selfTrapAbility }],
      setupTurns: 1,
      payoff: 'Trapped foes are KOed when the Perish count hits 0; pair with Protect stalling.',
      counters,
      score: clamp(40 + (s ? bulk(s) / 8 : 0)),
    });
  }
  if (other) {
    const trapMove = TRAP_MOVES.find(m => has(other, m));
    const trapAbility = TRAP_ABILITIES.find(ab => hasAbility(other, ab));
    if (trapMove || trapAbility) {
      const s1 = statsOf(singer); const s2 = statsOf(other);
      out.push({
        pattern: 'perish-trap', name: 'Perish trap',
        pieces: [
          { species: singer.species, role: 'singer', move: 'Perish Song' },
          { species: other.species, role: 'trapper', move: trapMove, ability: trapAbility },
        ],
        setupTurns: 1,
        payoff: 'Song turn 1, trap the target, stall 3 turns (Protect/switch the singer) — trapped foes faint.',
        counters,
        score: clamp(45 + (s1 ? bulk(s1) / 12 : 0) + (s2 ? bulk(s2) / 12 : 0)),
      });
    }
  }
  return out;
};

const detectBatonPass: Detector = (a, b) => {
  const out: TacticInstance[] = [];
  for (const passer of b ? [a, b] : [a]) {
    if (!has(passer, 'batonpass')) continue;
    const speedBoost = hasAbility(passer, 'speedboost');
    const setups = Object.entries(SETUP_MOVES).filter(([m]) => has(passer, m));
    const bestSetup = setups.sort((x, y) => y[1].stages - x[1].stages)[0];
    if (!speedBoost && !bestSetup) continue;
    const engine = speedBoost ? 'Speed Boost' : bestSetup![0];
    const stages = (speedBoost ? 1 : 0) + (bestSetup?.[1].stages ?? 0);
    const receiver = b && passer !== b ? b : b && passer !== a ? a : null;
    if (receiver) {
      const rs = statsOf(receiver);
      const storedPower = has(receiver, 'storedpower') || has(receiver, 'powertrip');
      out.push({
        pattern: 'baton-pass', name: 'Baton Pass chain',
        pieces: [
          { species: passer.species, role: 'passer', move: 'Baton Pass', ability: speedBoost ? 'speedboost' : undefined },
          { species: receiver.species, role: storedPower ? 'receiver (Stored Power)' : 'receiver' },
        ],
        setupTurns: 2,
        payoff: `Accumulate boosts (${engine}), pass to ${receiver.species}${storedPower ? ' — Stored Power scales 20 BP per stage' : ''}.`,
        counters: ['Haze / Clear Smog / Spectral Thief', 'Taunt the passer', 'KO the passer before the pass', 'Roar/Whirlwind the receiver'],
        score: clamp(30 + stages * 8 + (rs ? offense(rs) / 6 : 0) + (storedPower ? 15 : 0)),
      });
    } else if (!b) {
      const ss = statsOf(passer);
      out.push({
        pattern: 'baton-pass', name: 'Baton Pass escape (boost keeper)',
        pieces: [{ species: passer.species, role: 'passer', move: 'Baton Pass', ability: speedBoost ? 'speedboost' : undefined }],
        setupTurns: 1,
        payoff: `Keeps ${engine} boosts while escaping bad matchups — boosts travel with the pass.`,
        counters: ['Trapping prevents the pass', 'Haze before the pass resolves'],
        score: clamp(25 + stages * 6 + (ss ? offense(ss) / 8 : 0)),
      });
    }
  }
  return out;
};

const detectStoredPowerSnowball: Detector = (a, b) => {
  if (b) return [];
  const sp = has(a, 'storedpower') ? 'storedpower' : has(a, 'powertrip') ? 'powertrip' : null;
  if (!sp) return [];
  const speedBoost = hasAbility(a, 'speedboost');
  const setups = Object.entries(SETUP_MOVES).filter(([m]) => has(a, m));
  const perTurn = (speedBoost ? 1 : 0) + Math.max(0, ...setups.map(([, v]) => v.stages));
  if (perTurn < 2) return [];
  const s = statsOf(a);
  return [{
    pattern: 'stored-power', name: 'Stored Power snowball',
    pieces: [{ species: a.species, role: 'snowballer', move: sp === 'storedpower' ? 'Stored Power' : 'Power Trip', ability: speedBoost ? 'speedboost' : undefined }],
    setupTurns: 2,
    payoff: `+${perTurn} stages/turn → ${sp === 'storedpower' ? 'Stored Power' : 'Power Trip'} reaches 100+ BP by turn 3.`,
    counters: ['Dark types are immune to Stored Power (Psychic)', 'Haze / Clear Smog', 'Unaware walls', 'KO before the snowball rolls'],
    score: clamp(35 + perTurn * 10 + (s ? (bulk(s) + s.baseStats.spe) / 12 : 0)),
  }];
};

const detectTrickRoom: Detector = (a, b) => {
  if (!b) return [];
  const setter = has(a, 'trickroom') ? a : has(b, 'trickroom') ? b : null;
  if (!setter) return [];
  const abuser = setter === a ? b : a;
  const as = statsOf(abuser);
  if (!as || as.baseStats.spe > 60 || offense(as) < 100) return [];
  const ss = statsOf(setter);
  return [{
    pattern: 'trick-room', name: 'Trick Room core',
    pieces: [
      { species: setter.species, role: 'setter', move: 'Trick Room' },
      { species: abuser.species, role: 'abuser' },
    ],
    setupTurns: 1,
    payoff: `${abuser.species} (base ${as.baseStats.spe} Spe, ${offense(as)} offense) moves first for 4 turns.`,
    counters: ['Taunt the setter (TR is -7 priority — easy to deny)', 'Stall the 4 turns with Protect', 'Re-set Trick Room to flip it back', 'Imprison Trick Room'],
    score: clamp(30 + (60 - as.baseStats.spe) / 2 + offense(as) / 5 + (ss ? bulk(ss) / 15 : 0)),
  }];
};

const detectTailwind: Detector = (a, b) => {
  if (!b) return [];
  const setter = has(a, 'tailwind') ? a : has(b, 'tailwind') ? b : null;
  if (!setter) return [];
  const abuser = setter === a ? b : a;
  const as = statsOf(abuser);
  // Tailwind pays off for mid-speed heavy hitters that double past the field.
  if (!as || as.baseStats.spe < 50 || as.baseStats.spe > 115 || offense(as) < 105) return [];
  return [{
    pattern: 'tailwind', name: 'Tailwind core',
    pieces: [
      { species: setter.species, role: 'setter', move: 'Tailwind' },
      { species: abuser.species, role: 'abuser' },
    ],
    setupTurns: 1,
    payoff: `${abuser.species} at ${as.baseStats.spe}×2 effective base speed outruns the unboosted field for 4 turns.`,
    counters: ['Trick Room inverts it', 'Stall the 4 turns', 'Icy Wind / Electroweb claw speed back', 'Faster Taunt on the setter'],
    score: clamp(28 + offense(as) / 4 + as.baseStats.spe / 8),
  }];
};

const detectWeather: Detector = (a, b) => {
  const out: TacticInstance[] = [];
  const profiles = b ? [a, b] : [a];
  for (const setter of profiles) {
    const setAb = Object.keys(WEATHER_SET_ABILITIES).find(ab => hasAbility(setter, ab));
    let setMove = Object.keys(WEATHER_SET_MOVES).find(m => has(setter, m));
    if (!setAb && !setMove) continue;
    const kind = setAb ? WEATHER_SET_ABILITIES[setAb]! : WEATHER_SET_MOVES[setMove!]!;
    // Evidence must match the detected kind — an auto-weather ability wins
    // outright (drop the redundant move so labels read 'Torkoal [drought]'
    // not 'Torkoal (sunnyday)'), and an unrelated set-move (Hippowdon's
    // Sunny Day under Sand Stream) must not be attached as evidence.
    if (setMove && (setAb || WEATHER_SET_MOVES[setMove] !== kind)) setMove = undefined;
    const personal = setAb === 'megasol';
    for (const abuser of profiles) {
      if (personal && abuser !== setter) continue; // Mega Sol's sun is holder-only
      if (abuser === setter && profiles.length > 1) continue; // pair mode: distinct roles
      const abuseAb = Object.entries(WEATHER_ABUSE_ABILITIES).find(([ab, k]) => k === kind && hasAbility(abuser, ab))?.[0];
      const abuseMove = Object.entries(WEATHER_ABUSE_MOVES).find(([m, k]) => k === kind && has(abuser, m))?.[0];
      if (!abuseAb && !abuseMove) continue;
      const as = statsOf(abuser);
      out.push({
        pattern: 'weather', name: `${kind[0]!.toUpperCase()}${kind.slice(1)} core${personal ? ' (Mega Sol — personal sun)' : ''}`,
        pieces: abuser === setter
          ? [{ species: setter.species, role: 'setter+abuser', ability: setAb ?? abuseAb, move: setMove ?? abuseMove }]
          : [
              { species: setter.species, role: 'setter', ability: setAb, move: setMove ? setMove : undefined },
              { species: abuser.species, role: 'abuser', ability: abuseAb, move: abuseMove },
            ],
        setupTurns: setAb ? 0 : 1,
        payoff: abuseAb
          ? `${abuser.species}'s ${abuseAb} is live ${setAb ? 'from turn 1 (auto-weather)' : 'after one setup turn'}.`
          : `${abuser.species}'s ${abuseMove} gets its ${kind} bonus.`,
        counters: ['Overwrite with your own weather', 'Cloud Nine / Air Lock', 'Stall the 5 turns'],
        score: clamp((setAb ? 40 : 28) + (as ? offense(as) / 5 : 0) + (abuseAb ? 12 : 6)),
      });
    }
  }
  return out;
};

const detectTerrain: Detector = (a, b) => {
  const out: TacticInstance[] = [];
  const profiles = b ? [a, b] : [a];
  for (const setter of profiles) {
    const setAb = Object.keys(TERRAIN_SET_ABILITIES).find(ab => hasAbility(setter, ab));
    const setMove = Object.keys(TERRAIN_SET_MOVES).find(m => has(setter, m));
    if (!setAb && !setMove) continue;
    const kind = setAb ? TERRAIN_SET_ABILITIES[setAb]! : TERRAIN_SET_MOVES[setMove!]!;
    for (const abuser of profiles) {
      if (abuser === setter && profiles.length > 1) continue;
      const abuse = Object.entries(TERRAIN_ABUSE).find(([key, v]) =>
        v.kind === kind && (v.what === 'move' ? has(abuser, key) : hasAbility(abuser, key)))?.[0];
      if (!abuse) continue;
      const as = statsOf(abuser);
      out.push({
        pattern: 'terrain', name: `${kind[0]!.toUpperCase()}${kind.slice(1)} terrain core`,
        pieces: abuser === setter
          ? [{ species: setter.species, role: 'setter+abuser', ability: setAb, move: setMove ?? abuse }]
          : [
              { species: setter.species, role: 'setter', ability: setAb, move: setMove },
              { species: abuser.species, role: 'abuser', move: TERRAIN_ABUSE[abuse]!.what === 'move' ? abuse : undefined, ability: TERRAIN_ABUSE[abuse]!.what === 'ability' ? abuse : undefined },
            ],
        setupTurns: setAb ? 0 : 1,
        payoff: `${abuser.species}'s ${abuse} is boosted while ${kind} terrain holds (5 turns).`,
        counters: ['Overwrite with another terrain', 'Steel Roller / Ice Spinner clears terrain', 'Flying / Levitate ignores it'],
        score: clamp((setAb ? 38 : 26) + (as ? offense(as) / 5 : 0)),
      });
    }
  }
  return out;
};

const detectRedirection: Detector = (a, b) => {
  if (!b) return [];
  const redirector = REDIRECT_MOVES.some(m => has(a, m)) ? a : REDIRECT_MOVES.some(m => has(b, m)) ? b : null;
  if (!redirector) return [];
  const partner = redirector === a ? b : a;
  const redirectMove = REDIRECT_MOVES.find(m => has(redirector, m))!;
  const setup = Object.keys(SETUP_MOVES).find(m => has(partner, m));
  const tr = has(partner, 'trickroom');
  if (!setup && !tr) return [];
  const rs = statsOf(redirector); const ps = statsOf(partner);
  return [{
    pattern: 'redirection', name: 'Redirection + setup',
    pieces: [
      { species: redirector.species, role: 'redirector', move: redirectMove },
      { species: partner.species, role: 'setup', move: setup ?? 'trickroom' },
    ],
    setupTurns: 1,
    payoff: `${redirector.species} eats both attacks while ${partner.species} ${tr ? 'sets Trick Room' : `sets up ${setup}`} safely.`,
    counters: ['Spread moves ignore redirection', 'Stalwart / Propeller Tail', 'Taunt the setup mon directly? No — redirection doesn\'t stop status; Taunt still lands'],
    score: clamp(32 + (rs ? bulk(rs) / 12 : 0) + (ps ? offense(ps) / 6 : 0)),
  }];
};

const detectFakeOutSetup: Detector = (a, b) => {
  if (!b) return [];
  const faker = has(a, 'fakeout') ? a : has(b, 'fakeout') ? b : null;
  if (!faker) return [];
  const partner = faker === a ? b : a;
  const setup = Object.keys(SETUP_MOVES).find(m => has(partner, m));
  const tr = has(partner, 'trickroom');
  if (!setup && !tr) return [];
  const big = setup ? SETUP_MOVES[setup]!.stages >= 3 : false;
  const ps = statsOf(partner);
  return [{
    pattern: 'fake-out-setup', name: 'Fake Out + setup',
    pieces: [
      { species: faker.species, role: 'flincher', move: 'Fake Out' },
      { species: partner.species, role: 'setup', move: setup ?? 'trickroom' },
    ],
    setupTurns: 1,
    payoff: `Fake Out removes one threat's turn while ${partner.species} ${tr ? 'sets Trick Room' : `uses ${setup}`}${big ? ' (big payoff setup)' : ''}.`,
    counters: ['Inner Focus / Shield Dust ignore the flinch', 'Psychic Terrain blocks Fake Out', 'Ghosts are immune', 'Switch the Fake Out target out'],
    score: clamp(30 + (setup ? SETUP_MOVES[setup]!.stages * 6 : 8) + (ps ? offense(ps) / 6 : 0)),
  }];
};

const detectSpreadImmune: Detector = (a, b) => {
  if (!b) return [];
  const out: TacticInstance[] = [];
  for (const attacker of [a, b]) {
    const partner = attacker === a ? b : a;
    for (const [moveId, immune] of Object.entries(SPREAD_IMMUNE)) {
      if (!has(attacker, moveId)) continue;
      const ps = statsOf(partner);
      if (!ps) continue;
      const viaType = immune.types.find(t => ps.types.includes(t));
      const viaAbility = immune.abilities.find(ab => hasAbility(partner, ab));
      const viaItem = immune.items.find(it => partner.item === it || (partner.potential && immune.items.length > 0 && loadFormat().items.allow.includes(it)));
      if (!viaType && !viaAbility && !viaItem) continue;
      const as = statsOf(attacker);
      out.push({
        pattern: 'spread-immune', name: `Free ${moveId} (partner immune)`,
        pieces: [
          { species: attacker.species, role: 'spread attacker', move: moveId },
          { species: partner.species, role: 'immune partner', ability: viaAbility, item: viaItem && !viaType && !viaAbility ? viaItem : undefined },
        ],
        setupTurns: 0,
        payoff: `${attacker.species} spams ${moveId} at full spread power; ${partner.species} is ${viaAbility ? `immune via ${viaAbility}` : viaType ? `immune (${viaType})` : `immune holding ${viaItem}`}${viaAbility === 'lightningrod' || viaAbility === 'stormdrain' ? ' and absorbs a boost' : ''}.`,
        counters: ['Wide Guard blocks the spread', 'Target the attacker down first'],
        score: clamp(35 + (as ? offense(as) / 4 : 0) + (viaAbility ? 8 : 0)),
      });
    }
  }
  return out;
};

const detectBeatUpJustified: Detector = (a, b) => {
  if (!b) return [];
  const beater = has(a, 'beatup') ? a : has(b, 'beatup') ? b : null;
  if (!beater) return [];
  const partner = beater === a ? b : a;
  if (!hasAbility(partner, 'justified')) return [];
  const ps = statsOf(partner);
  return [{
    pattern: 'beat-up-justified', name: 'Beat Up + Justified',
    pieces: [
      { species: beater.species, role: 'trigger', move: 'Beat Up' },
      { species: partner.species, role: 'receiver', ability: 'justified' },
    ],
    setupTurns: 1,
    payoff: `Beat Up hits ${partner.species} once per healthy teammate — +1 Atk each via Justified (up to +4).`,
    counters: ['KO or flinch the Beat Up user', 'Intimidate cancels stages', 'Haze / Clear Smog'],
    score: clamp(40 + (ps ? (ps.baseStats.atk + ps.baseStats.spe) / 8 : 0)),
  }];
};

const detectCritAngerPoint: Detector = (a, b) => {
  if (!b) return [];
  const critter = GUARANTEED_CRIT_MOVES.some(m => has(a, m)) ? a : GUARANTEED_CRIT_MOVES.some(m => has(b, m)) ? b : null;
  if (!critter) return [];
  const partner = critter === a ? b : a;
  if (!hasAbility(partner, 'angerpoint')) return [];
  const critMove = GUARANTEED_CRIT_MOVES.find(m => has(critter, m))!;
  const ps = statsOf(partner);
  return [{
    pattern: 'crit-anger-point', name: 'Guaranteed crit + Anger Point',
    pieces: [
      { species: critter.species, role: 'trigger', move: critMove },
      { species: partner.species, role: 'receiver', ability: 'angerpoint' },
    ],
    setupTurns: 1,
    payoff: `${critMove} always crits — hitting your own ${partner.species} maxes Attack (+6) instantly.`,
    counters: ['KO the boosted mon before it moves', 'Intimidate after the boost still drops it', 'Haze / Clear Smog'],
    score: clamp(38 + (ps ? (ps.baseStats.atk + ps.baseStats.spe) / 8 : 0)),
  }];
};

const detectUnburden: Detector = (a, b) => {
  if (b) return [];
  if (!hasAbility(a, 'unburden')) return [];
  const consumables = consumableItemIds();
  // Unknown item = possible; a KNOWN non-consumable kills the combo. (Actual
  // my-team sets always carry their item, so unknown only happens for opps.)
  const itemOk = a.item ? consumables.includes(a.item) : true;
  if (!itemOk) return [];
  const s = statsOf(a);
  const acro = has(a, 'acrobatics');
  return [{
    pattern: 'unburden', name: 'Unburden consume',
    pieces: [{ species: a.species, role: 'sweeper', ability: 'unburden', item: a.item ?? '(any consumable)', move: acro ? 'Acrobatics' : undefined }],
    setupTurns: 1,
    payoff: `Item consumed → Speed doubles${acro ? '; Acrobatics doubles to 110 BP itemless' : ''}.`,
    counters: ['Knock Off before the consume denies the trigger? No — Knock Off TRIGGERS it; instead avoid breaking the item', 'Gastro Acid / Neutralizing Gas', 'Priority moves ignore speed'],
    score: clamp(35 + (s ? (offense(s) + s.baseStats.spe) / 8 : 0) + (acro ? 8 : 0)),
  }];
};

const detectNoGuard: Detector = (a, b) => {
  if (b) return [];
  if (!hasAbility(a, 'noguard')) return [];
  // Inaccurate heavy moves the holder turns into guaranteed hits (Zap Cannon,
  // Dynamic Punch, High Jump Kick — No Guard also skips HJK's crash, Focus
  // Blast, Hurricane, …).
  const nukes: { move: string; bp: number; acc: number }[] = [];
  for (const mv of a.moves) {
    const m = getMove(mv) as { basePower?: number; accuracy?: number | true; name?: string; flags?: Record<string, number> } | undefined;
    if (!m?.basePower || m.basePower < 90) continue;
    if (m.accuracy === true || (m.accuracy as number) > 90) continue;
    // Recharge/charge moves aren't realistic nukes regardless of accuracy.
    if (m.flags?.recharge || m.flags?.charge) continue;
    nukes.push({ move: m.name ?? mv, bp: m.basePower, acc: m.accuracy as number });
  }
  if (!nukes.length) return [];
  nukes.sort((x, y) => y.bp - x.bp || x.acc - y.acc);
  const top = nukes[0]!;
  const s = statsOf(a);
  return [{
    pattern: 'no-guard', name: 'No Guard + inaccurate nukes',
    pieces: [{ species: a.species, role: 'holder', ability: 'noguard', move: nukes.slice(0, 3).map(n => n.move).join(' / ') }],
    setupTurns: 0,
    payoff: `${top.move} (${top.bp} BP, normally ${top.acc}%) and ${nukes.length - 1} more never miss${nukes.some(n => n.move === 'Zap Cannon') ? ' — Zap Cannon guarantees paralysis too' : ''}.`,
    counters: ['No Guard cuts both ways — your inaccurate moves also always hit it', 'Protect still blocks', 'Wide Guard vs spread nukes'],
    score: clamp(32 + nukes.length * 5 + (100 - top.acc) / 4 + (s ? offense(s) / 5 : 0)),
  }];
};

const detectAuroraVeil: Detector = (a, b) => {
  const out: TacticInstance[] = [];
  const profiles = b ? [a, b] : [a];
  for (const veiler of profiles) {
    if (!has(veiler, 'auroraveil')) continue;
    const snowSelf = hasAbility(veiler, 'snowwarning') || has(veiler, 'snowscape') || has(veiler, 'chillyreception');
    if (profiles.length === 1) {
      if (!snowSelf) continue;
      out.push({
        pattern: 'aurora-veil', name: 'Aurora Veil (self-sufficient)',
        pieces: [{ species: veiler.species, role: 'veiler', move: 'Aurora Veil', ability: hasAbility(veiler, 'snowwarning') ? 'snowwarning' : undefined }],
        setupTurns: 1,
        payoff: 'Snow + Aurora Veil: both screens in one move — team takes ~⅔ damage for 5 turns.',
        counters: ['Screen Cleaner / Brick Break / Raging Bull', 'Overwrite the snow before the veil goes up', 'Infiltrator ignores it'],
        score: clamp(55),
      });
    } else {
      const partner = veiler === profiles[0] ? profiles[1]! : profiles[0]!;
      const partnerSnow = hasAbility(partner, 'snowwarning') || has(partner, 'snowscape') || has(partner, 'chillyreception');
      if (!partnerSnow || snowSelf) continue;
      out.push({
        pattern: 'aurora-veil', name: 'Aurora Veil core',
        pieces: [
          { species: partner.species, role: 'snow setter', ability: hasAbility(partner, 'snowwarning') ? 'snowwarning' : undefined, move: has(partner, 'snowscape') ? 'snowscape' : has(partner, 'chillyreception') ? 'chillyreception' : undefined },
          { species: veiler.species, role: 'veiler', move: 'Aurora Veil' },
        ],
        setupTurns: 1,
        payoff: 'Partner brings snow, veiler stacks both screens in one move — 5 turns of ~⅔ damage.',
        counters: ['Screen Cleaner / Brick Break / Raging Bull', 'Overwrite the snow first', 'Infiltrator ignores it'],
        score: clamp(50),
      });
    }
  }
  return out;
};

const DETECTORS: Detector[] = [
  detectPerishTrap, detectBatonPass, detectStoredPowerSnowball, detectTrickRoom,
  detectTailwind, detectWeather, detectTerrain, detectRedirection, detectFakeOutSetup,
  detectSpreadImmune, detectBeatUpJustified, detectCritAngerPoint, detectUnburden,
  detectNoGuard, detectAuroraVeil,
];

/** Compact one-line label: 'Politoed (Perish Song) + Steelix-Mega (block)'. */
export function tacticLabel(t: TacticInstance): string {
  return t.pieces.map(p => p.species + (p.move ? ` (${p.move})` : p.ability ? ` [${p.ability}]` : '')).join(' + ');
}

/** Stable identity for deduping symmetric pair hits. */
function instanceKey(t: TacticInstance): string {
  return `${t.pattern}|${t.pieces.map(p => `${p.species}:${p.role}:${p.move ?? ''}:${p.ability ?? ''}`).sort().join('|')}`;
}

/** Run every detector over all singles and unordered pairs of `profiles`. */
export function detectTactics(profiles: MonProfile[], opts?: { minScore?: number }): TacticInstance[] {
  const minScore = opts?.minScore ?? 0;
  const seen = new Set<string>();
  const out: TacticInstance[] = [];
  const push = (instances: TacticInstance[]) => {
    for (const t of instances) {
      if (t.score < minScore) continue;
      const key = instanceKey(t);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  };
  for (const p of profiles) {
    for (const d of DETECTORS) push(d(p, null));
  }
  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      for (const d of DETECTORS) push(d(profiles[i]!, profiles[j]!));
    }
  }
  return out.sort((x, y) => y.score - x.score);
}
