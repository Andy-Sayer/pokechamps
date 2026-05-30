import type { MoveAction, FieldSide, FieldSlot, PokemonSet, OpponentEntry } from './types.js';
import { toId } from './data.js';

// Single-line turn syntax (case-insensitive on the actor tokens):
//
// ACTIONS (logged into the turn's draftActions list, applied on `n`):
//   <actor> > <move> > <target>[ > <dmg>]
//   <actor> > switch > <species|teamRef>
//
// STATE UPDATES (mutate state immediately, do not enter the turn log):
//   <ref> = <pct>[%]              set HP
//   <ref> ko | <ref> fainted      mark fainted (HP -> 0)
//   <ref> in <slot>               bring this teamIndex into the given slot
//
// <actor>      m1 | m2 | o1 | o2   (optionally suffixed with +mega)
// <target>     m1 | m2 | o1 | o2 | spread | self
// <slot>       m1 | m2 | o1 | o2   (active slot only)
// <ref>        m1..m6 | o1..o6    (1/2 = active slot ref via activeIdx; 3-6 = direct team index)
//              my1..my6 | op1..op6  (unambiguous team index 1..6 — reaches benched mons at index 0/1)
// <species>    a species name; resolves to a team index for the actor's side
// <teamRef>    my1..my6 / op1..op6 (1-based index into the side's team)
// <dmg>        integer percent, optional trailing %, or "X raw" for raw damage
//
// Examples (all valid):
//   m1 > Astral Barrage > o2 > 67
//   m1+mega > Flamethrower > o2 > 45
//   o1 > Sucker Punch > m1 > 41%
//   m1 > switch > Garchomp
//   o2 > switch > op4
//   m1 > Protect > self
//   o3 = 45%
//   m1 = 50
//   o2 ko
//   o3 in o1

export interface ParseContext {
  myTeam: PokemonSet[];
  opponentTeam: OpponentEntry[];
  // The mons currently in each active slot, as indices into the side's team.
  // Used to resolve "m1"/"o2" to a teamIndex when no explicit slot is known.
  myActiveTeamIndex: [number | null, number | null];
  theirActiveTeamIndex: [number | null, number | null];
  // Team indices of fainted mons on my side. (Opp fainted lives on
  // opponentTeam[i].fainted directly.)
  myFainted?: number[];
  // The 4 team indices the user committed to at preview. Mine-side switches
  // must resolve to one of these — you can't send in a mon you didn't bring.
  // When undefined the parser falls back to the full 6 (preview-stage replay
  // tests, mainly).
  myBring?: number[];
}

// Side-scoped hazard updates emit a different StateUpdate variant — no
// teamIndex involved. Caller (BattleScreen) routes hazards to field.myHazards
// / field.theirHazards instead of per-mon storage.
export interface HazardUpdate {
  side: FieldSide;
  verb: 'rocks' | 'spikes' | 'tspikes' | 'web';
  arg: 'on' | 'off' | number;
}

export interface StateUpdate {
  side: FieldSide;
  teamIndex: number;
  hpPercent?: number;     // set HP to: percent (for opp targets or explicit `%` on mine)
  hpRaw?: number;         // set HP to: raw HP (for mine targets)
  healPercent?: number;   // +N% (capped at full)
  healRaw?: number;       // +N raw HP (for mine; converted via maxHpFor)
  damagePercent?: number; // -N% (clamped at 0)
  damageRaw?: number;     // -N raw HP for mine (clamped at 0)
  namedHeal?: 'sitrus';   // shorthand resolved at apply time using species maxHp
  // Stage deltas to add to current boosts; clamped to [-6, +6] per stat in apply.
  boosts?: Partial<Record<'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'acc' | 'eva', number>>;
  // Named after-attack item triggers — apply layer resolves to boosts/HP/item.
  namedTrigger?: 'wp' | 'sash' | 'balloon';
  // Status set/clear.
  status?: 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz';
  cureStatus?: boolean;
  // Move-restricting volatiles. `cureStatus` also clears all three.
  taunt?: boolean;
  encoreMove?: string;
  disableMove?: string;
  // Optional override of the volatile's countdown (turns remaining). When
  // omitted the apply layer seeds the default (Taunt/Encore 3, Disable 4).
  volatileTurns?: number;
  fainted?: boolean;
  bringIntoSlot?: 0 | 1;
  // Residual-chip volatiles.
  saltCure?: boolean;     // o1 salt-cure / m1 salt-cure
  aquaRing?: boolean;     // o1 aqua-ring / m1 aqua-ring
  ingrain?: boolean;      // o1 ingrain / m1 ingrain
  curse?: boolean;        // o1 curse / m1 curse (Cursed target, not the user)
  partialTrap?: number;   // o1 trapped [N] — turns remaining (default 4)
  nightmare?: boolean;    // o1 nightmare / m1 nightmare
  // One-turn flinch volatile. Clears at EOT. "o1 flinch" / "m1 flinch".
  flinch?: boolean;
}

export type ParseResult =
  | { ok: true; kind: 'action'; actions: MoveAction[] }
  | { ok: true; kind: 'state'; update: StateUpdate }
  | { ok: true; kind: 'states'; updates: StateUpdate[] }
  | { ok: true; kind: 'hazard'; update: HazardUpdate }
  | { ok: false; error: string };

// Actor token: side + slot + zero or more `+<modifier>` suffixes.
// Modifiers accepted today: `mega` (this turn's mega evolution) and `crit`
// (the move was a critical hit).
const ACTOR_RE = /^(m|o)([12])((?:\+[a-z]+)*)$/i;

export interface ActorRef {
  side: FieldSide;
  slot: FieldSlot;
  mega: boolean;
  crit: boolean;
  /** True when the Quick Claw proc'd this turn (or any other +1-priority
   *  trigger the user logged via +quick/+qc). Bumps effectivePriority in
   *  speed inference so we don't conclude the mon naturally outsped its
   *  bracket. */
  quickClaw: boolean;
}

export function parseActor(raw: string): ActorRef | null {
  const m = raw.trim().toLowerCase().match(ACTOR_RE);
  if (!m) return null;
  const mods = (m[3] ?? '').split('+').filter(Boolean);
  return {
    side: m[1] === 'm' ? 'mine' : 'theirs',
    slot: (parseInt(m[2]!, 10) - 1) as FieldSlot,
    mega: mods.includes('mega'),
    crit: mods.includes('crit'),
    quickClaw: mods.includes('quick') || mods.includes('qc'),
  };
}

interface TargetRef { kind: 'slot'; side: FieldSide; slot: FieldSlot }

function parseTarget(raw: string): TargetRef | 'self' | 'allies' | 'foes' | null {
  const t = raw.trim().toLowerCase();
  if (t === 'self') return 'self';
  if (t === 'spread' || t === 'foes') return 'foes';
  if (t === 'allies') return 'allies';
  const m = t.match(ACTOR_RE);
  if (!m) return null;
  return {
    kind: 'slot',
    side: m[1] === 'm' ? 'mine' : 'theirs',
    slot: (parseInt(m[2]!, 10) - 1) as FieldSlot,
  };
}

function activeTeamIndex(ctx: ParseContext, side: FieldSide, slot: FieldSlot): number | null {
  return side === 'mine' ? ctx.myActiveTeamIndex[slot] : ctx.theirActiveTeamIndex[slot];
}

// State-line reference: oN/mN where N=1..6.
//   N=1: slot 0 (active) — resolves through activeIdx
//   N=2: slot 1 (active) — resolves through activeIdx
//   N=3..6: direct team-index reference (1-indexed → 0-indexed)
// Returns the team index, or null if N=1/2 and that slot is empty.
function resolveStateRef(side: FieldSide, n: number, ctx: ParseContext): number | null {
  if (n <= 2) return activeTeamIndex(ctx, side, (n - 1) as FieldSlot);
  return n - 1;
}

// Resolve a state-line ref token to { side, teamIndex }, accepting both forms:
//   m1/m2/o1/o2          — ACTIVE SLOTS (resolve through activeIdx; null if empty)
//   m3..m6 / o3..o6      — team index 3..6 (1-based; legacy short form)
//   my1..my6 / op1..op6  — UNAMBIGUOUS team index 1..6 (always resolvable,
//                          incl. benched mons sitting at team index 0/1 that
//                          the slot-overloaded m1/o1 can't reach)
// Matchers below use the leading token `(my|op|m|o)([1-6])`.
function resolveRef(prefix: string, n: number, ctx: ParseContext): { side: FieldSide; teamIndex: number } | null {
  const p = prefix.toLowerCase();
  if (p === 'my') return { side: 'mine', teamIndex: n - 1 };
  if (p === 'op') return { side: 'theirs', teamIndex: n - 1 };
  const side: FieldSide = p === 'm' ? 'mine' : 'theirs';
  const ti = resolveStateRef(side, n, ctx);
  return ti == null ? null : { side, teamIndex: ti };
}

function resolveTeamRef(token: string, ctx: ParseContext, side: FieldSide): number | null {
  const m = token.trim().toLowerCase().match(/^(my|op)([1-6])$/);
  if (m) {
    const expectSide: FieldSide = m[1] === 'my' ? 'mine' : 'theirs';
    if (expectSide !== side) return null;
    return parseInt(m[2]!, 10) - 1;
  }
  // Otherwise treat as species name; look up the matching slot on that side.
  const id = toId(token);
  const team = side === 'mine' ? ctx.myTeam : ctx.opponentTeam;
  for (let i = 0; i < team.length; i++) {
    const speciesId = toId(side === 'mine' ? (team[i] as PokemonSet).species : (team[i] as OpponentEntry).species);
    if (speciesId === id) return i;
  }
  return null;
}

// The damage slot's bare number means REMAINING HP after the action — the
// natural unit per target side:
//   target on opp side  → number is the new HP% remaining (0..100)
//   target on mine side → number is the new raw HP value
// Explicit suffixes still work as overrides for the rare "damage dealt"
// style of entry:
//   `80 raw` → damageRaw (damage dealt in raw HP, opp target convention)
//   `60%`    → forces percent interpretation regardless of side
function parseDamage(
  token: string | undefined,
  targetSide: FieldSide | undefined,
): Pick<MoveAction, 'damageHpPercent' | 'damageRaw' | 'targetRemainingHpPercent' | 'targetRemainingHpRaw'> {
  if (!token) return {};
  const t = token.trim().toLowerCase();
  const rawDealt = t.match(/^(\d+)\s*raw$/);
  if (rawDealt) return { damageRaw: parseInt(rawDealt[1]!, 10) };
  const explicitPct = t.match(/^(\d+(?:\.\d+)?)%$/);
  if (explicitPct) return { targetRemainingHpPercent: parseFloat(explicitPct[1]!) };
  const bare = t.match(/^(\d+(?:\.\d+)?)$/);
  if (bare) {
    const v = parseFloat(bare[1]!);
    if (targetSide === 'mine') return { targetRemainingHpRaw: v };
    return { targetRemainingHpPercent: v };
  }
  return {};
}

// Try the state-line shapes first. Returns null if the line doesn't look like
// a state update (so the caller falls through to action parsing).
function tryParseState(line: string, ctx: ParseContext): ParseResult | null {
  const trimmed = line.trim();
  const sideFor = (ch: string): FieldSide => (ch.toLowerCase() === 'm' ? 'mine' : 'theirs');

  // Bulk HP update — `hp m1=45 m2=80 o1=30% o2=60`. Lets the user skip
  // damage entry on individual actions when the game's moving fast and
  // recover HPs at end of turn in one line. Each pair has the same
  // interpretation as the single "<ref> = <val>" form: opp bare = %,
  // mine bare = raw HP, explicit % suffix forces percent.
  const hpBulk = trimmed.match(/^hp\s+(.+)$/i);
  if (hpBulk) {
    const body = hpBulk[1]!;
    const pairs = body.split(/[\s,]+/).filter(Boolean);
    if (pairs.length === 0) return { ok: false, error: 'hp line needs at least one <ref>=<val> pair' };
    const updates: StateUpdate[] = [];
    for (const pair of pairs) {
      const m = pair.match(/^(my|op|m|o)([1-6])=(\d+(?:\.\d+)?)(%?)$/i);
      if (!m) return { ok: false, error: `bad hp pair "${pair}" — expected m1=45 / o1=30% / my3=145` };
      const ref = resolveRef(m[1]!, parseInt(m[2]!, 10), ctx);
      if (!ref) {
        return { ok: false, error: `${m[1]}${m[2]} has no active mon to update` };
      }
      const { side, teamIndex } = ref;
      const value = parseFloat(m[3]!);
      const explicitPct = m[4] === '%';
      if (side === 'mine' && !explicitPct) {
        updates.push({ side, teamIndex, hpRaw: Math.max(0, value) });
      } else {
        updates.push({ side, teamIndex, hpPercent: Math.max(0, Math.min(100, value)) });
      }
    }
    return { ok: true, kind: 'states', updates };
  }

  // Hazards — side-scoped, no slot ref.
  //   "m rocks on" / "m rocks off"
  //   "o spikes 2" / "o spikes off"
  //   "o tspikes 1"
  //   "o web on"
  const hazMatch = trimmed.match(/^([mo])\s+(rocks|spikes|tspikes|web)\s+(on|off|\d+)$/i);
  if (hazMatch) {
    const side = sideFor(hazMatch[1]!);
    const verb = hazMatch[2]!.toLowerCase() as HazardUpdate['verb'];
    const argRaw = hazMatch[3]!.toLowerCase();
    const arg: 'on' | 'off' | number = argRaw === 'on' ? 'on' : argRaw === 'off' ? 'off' : parseInt(argRaw, 10);
    return { ok: true, kind: 'hazard', update: { side, verb, arg } };
  }

  // "o3 = 45" / "o3 = 45%" / "m1 = 145" / "m1 = 50%"
  // For opp: bare number = % remaining; explicit `%` also means %.
  // For mine: bare number = raw HP; explicit `%` means percent.
  const hpMatch = trimmed.match(/^(my|op|m|o)([1-6])\s*=\s*(\d+(?:\.\d+)?)(%?)$/i);
  if (hpMatch) {
    const ref = resolveRef(hpMatch[1]!, parseInt(hpMatch[2]!, 10), ctx);
    if (!ref) {
      return { ok: false, error: `${hpMatch[1]}${hpMatch[2]} has no active mon to update` };
    }
    const { side, teamIndex } = ref;
    const value = parseFloat(hpMatch[3]!);
    const explicitPct = hpMatch[4] === '%';
    if (side === 'mine' && !explicitPct) {
      return { ok: true, kind: 'state', update: { side, teamIndex, hpRaw: Math.max(0, value) } };
    }
    const hpPercent = Math.max(0, Math.min(100, value));
    return { ok: true, kind: 'state', update: { side, teamIndex, hpPercent } };
  }

  // "o1 +2 atk" / "m1 -1 def" / multi-stat "o1 +2 atk +2 spa".
  // Any number of (+|-)<digits> <stat> repetitions after the ref token.
  const boostHeader = trimmed.match(/^(my|op|m|o)([1-6])\s+([+-].*)$/i);
  if (boostHeader && /[+-]\s*\d+\s+(atk|def|spa|spd|spe|acc|eva)\b/i.test(boostHeader[3]!)) {
    const ref = resolveRef(boostHeader[1]!, parseInt(boostHeader[2]!, 10), ctx);
    if (!ref) {
      return { ok: false, error: `${boostHeader[1]}${boostHeader[2]} has no active mon to boost` };
    }
    const { side, teamIndex } = ref;
    const boosts: NonNullable<StateUpdate['boosts']> = {};
    const rest = boostHeader[3]!;
    const re = /([+-])\s*(\d+)\s+(atk|def|spa|spd|spe|acc|eva)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest)) !== null) {
      const sign = m[1] === '+' ? 1 : -1;
      const mag = parseInt(m[2]!, 10);
      const stat = m[3]!.toLowerCase() as keyof NonNullable<StateUpdate['boosts']>;
      boosts[stat] = (boosts[stat] ?? 0) + sign * mag;
    }
    if (Object.keys(boosts).length === 0) {
      return { ok: false, error: `couldn't parse any "+N stat" / "-N stat" pairs` };
    }
    return { ok: true, kind: 'state', update: { side, teamIndex, boosts } };
  }

  // "o1 damage 25" / "m1 damage 30" — counterpart to heal.
  const dmgMatch = trimmed.match(/^(my|op|m|o)([1-6])\s+damage\s+(\d+(?:\.\d+)?)$/i);
  if (dmgMatch) {
    const ref = resolveRef(dmgMatch[1]!, parseInt(dmgMatch[2]!, 10), ctx);
    if (!ref) {
      return { ok: false, error: `${dmgMatch[1]}${dmgMatch[2]} has no active mon to damage` };
    }
    const { side, teamIndex } = ref;
    const v = parseFloat(dmgMatch[3]!);
    if (side === 'mine') return { ok: true, kind: 'state', update: { side, teamIndex, damageRaw: Math.max(0, v) } };
    return { ok: true, kind: 'state', update: { side, teamIndex, damagePercent: Math.max(0, v) } };
  }

  // Status set / cure: "o1 brn" / "m1 par" / "o1 cure".
  const statusMatch = trimmed.match(/^(my|op|m|o)([1-6])\s+(brn|par|psn|tox|slp|frz|cure)$/i);
  if (statusMatch) {
    const ref = resolveRef(statusMatch[1]!, parseInt(statusMatch[2]!, 10), ctx);
    if (!ref) {
      return { ok: false, error: `${statusMatch[1]}${statusMatch[2]} has no active mon` };
    }
    const { side, teamIndex } = ref;
    const verb = statusMatch[3]!.toLowerCase();
    if (verb === 'cure') {
      return { ok: true, kind: 'state', update: { side, teamIndex, cureStatus: true } };
    }
    return { ok: true, kind: 'state', update: { side, teamIndex, status: verb as StateUpdate['status'] } };
  }

  // Move-restricting volatiles: "o1 taunt" / "o1 encore Flamethrower" /
  // "o1 disable Protect". Encore/Disable take a free-text move name.
  // "o1 taunt" / "o1 taunt 2" (optional turn-count override).
  const tauntMatch = trimmed.match(/^(my|op|m|o)([1-6])\s+taunt(?:\s+(\d+))?$/i);
  if (tauntMatch) {
    const ref = resolveRef(tauntMatch[1]!, parseInt(tauntMatch[2]!, 10), ctx);
    if (!ref) return { ok: false, error: `${tauntMatch[1]}${tauntMatch[2]} has no active mon` };
    const turns = tauntMatch[3] ? parseInt(tauntMatch[3], 10) : undefined;
    return { ok: true, kind: 'state', update: { side: ref.side, teamIndex: ref.teamIndex, taunt: true, volatileTurns: turns } };
  }
  // "o1 encore Fake Out" / "o1 disable Protect 3" — optional trailing count.
  const volMatch = trimmed.match(/^(my|op|m|o)([1-6])\s+(encore|disable)\s+(.+)$/i);
  if (volMatch) {
    const ref = resolveRef(volMatch[1]!, parseInt(volMatch[2]!, 10), ctx);
    if (!ref) return { ok: false, error: `${volMatch[1]}${volMatch[2]} has no active mon` };
    let move = volMatch[4]!.trim();
    let turns: number | undefined;
    const tm = move.match(/^(.*\S)\s+(\d+)$/);
    if (tm) { move = tm[1]!; turns = parseInt(tm[2]!, 10); }
    const key = volMatch[3]!.toLowerCase() === 'encore' ? 'encoreMove' : 'disableMove';
    return { ok: true, kind: 'state', update: { side: ref.side, teamIndex: ref.teamIndex, [key]: move, volatileTurns: turns } };
  }

  // Named after-attack triggers: wp / sash / balloon.
  const triggerMatch = trimmed.match(/^(my|op|m|o)([1-6])\s+(wp|sash|balloon)$/i);
  if (triggerMatch) {
    const ref = resolveRef(triggerMatch[1]!, parseInt(triggerMatch[2]!, 10), ctx);
    if (!ref) {
      return { ok: false, error: `${triggerMatch[1]}${triggerMatch[2]} has no active mon` };
    }
    const { side, teamIndex } = ref;
    const t = triggerMatch[3]!.toLowerCase() as 'wp' | 'sash' | 'balloon';
    return { ok: true, kind: 'state', update: { side, teamIndex, namedTrigger: t } };
  }

  // "o1 heal 25" / "m1 heal 30" — units side-aware (% for opp, raw for mine).
  const healMatch = trimmed.match(/^(my|op|m|o)([1-6])\s+heal\s+(\d+(?:\.\d+)?)$/i);
  if (healMatch) {
    const ref = resolveRef(healMatch[1]!, parseInt(healMatch[2]!, 10), ctx);
    if (!ref) {
      return { ok: false, error: `${healMatch[1]}${healMatch[2]} has no active mon to heal` };
    }
    const { side, teamIndex } = ref;
    const v = parseFloat(healMatch[3]!);
    if (side === 'mine') return { ok: true, kind: 'state', update: { side, teamIndex, healRaw: Math.max(0, v) } };
    return { ok: true, kind: 'state', update: { side, teamIndex, healPercent: Math.max(0, v) } };
  }

  // "o1 sitrus" — named berry shortcut; apply layer resolves to a real number
  // using the species' maxHp because parser doesn't know base stats.
  const namedHealMatch = trimmed.match(/^(my|op|m|o)([1-6])\s+(sitrus)$/i);
  if (namedHealMatch) {
    const ref = resolveRef(namedHealMatch[1]!, parseInt(namedHealMatch[2]!, 10), ctx);
    if (!ref) {
      return { ok: false, error: `${namedHealMatch[1]}${namedHealMatch[2]} has no active mon to heal` };
    }
    const { side, teamIndex } = ref;
    return { ok: true, kind: 'state', update: { side, teamIndex, namedHeal: 'sitrus' } };
  }

  // "o2 fainted" / "o2 ko"
  const koMatch = trimmed.match(/^(my|op|m|o)([1-6])\s+(?:ko|fainted)$/i);
  if (koMatch) {
    const ref = resolveRef(koMatch[1]!, parseInt(koMatch[2]!, 10), ctx);
    if (!ref) {
      return { ok: false, error: `${koMatch[1]}${koMatch[2]} has no active mon to mark fainted` };
    }
    const { side, teamIndex } = ref;
    return { ok: true, kind: 'state', update: { side, teamIndex, fainted: true, hpPercent: 0 } };
  }

  // "o1 flinch" / "o1 flinched" — one-turn flinch volatile (cleared at EOT).
  const flinchMatch = trimmed.match(/^(my|op|m|o)([1-6])\s+flinch(?:ed)?$/i);
  if (flinchMatch) {
    const ref = resolveRef(flinchMatch[1]!, parseInt(flinchMatch[2]!, 10), ctx);
    if (!ref) return { ok: false, error: `${flinchMatch[1]}${flinchMatch[2]} has no active mon` };
    return { ok: true, kind: 'state', update: { side: ref.side, teamIndex: ref.teamIndex, flinch: true } };
  }

  // Residual-chip volatiles: "o1 salt-cure", "m1 aqua-ring", "o2 trapped 4", etc.
  const residualMatch = trimmed.match(/^(my|op|m|o)([1-6])\s+(salt-?cure|aqua-?ring|ingrain|curse|cursed|nightmare|trapped?)(?:\s+(\d+))?$/i);
  if (residualMatch) {
    const ref = resolveRef(residualMatch[1]!, parseInt(residualMatch[2]!, 10), ctx);
    if (!ref) return { ok: false, error: `${residualMatch[1]}${residualMatch[2]} has no active mon` };
    const verb = residualMatch[3]!.toLowerCase().replace('-', '').replace('cursed', 'curse').replace('trapped', 'trap');
    const arg = residualMatch[4] ? parseInt(residualMatch[4], 10) : undefined;
    const extra: Partial<StateUpdate> = {};
    if (verb === 'saltcure') extra.saltCure = true;
    else if (verb === 'aquaring') extra.aquaRing = true;
    else if (verb === 'ingrain') extra.ingrain = true;
    else if (verb === 'curse') extra.curse = true;
    else if (verb === 'trap') extra.partialTrap = arg ?? 4;
    else if (verb === 'nightmare') extra.nightmare = true;
    return { ok: true, kind: 'state', update: { side: ref.side, teamIndex: ref.teamIndex, ...extra } };
  }

  // "o3 in o1" — bring teamIndex on left into the active slot on right.
  const inMatch = trimmed.match(/^(my|op|m|o)([1-6])\s+in\s+([mo])([12])$/i);
  if (inMatch) {
    const ref = resolveRef(inMatch[1]!, parseInt(inMatch[2]!, 10), ctx);
    const sideR = sideFor(inMatch[3]!);
    if (!ref) {
      return { ok: false, error: `couldn't resolve ${inMatch[1]}${inMatch[2]} as a team index` };
    }
    if (ref.side !== sideR) return { ok: false, error: '"X in Y" must be the same side (e.g. o3 in o1)' };
    const slot = (parseInt(inMatch[4]!, 10) - 1) as 0 | 1;
    const { side: sideL, teamIndex } = ref;
    // Mine side: enforce the bring restriction here too. Manual replacement
    // ("m5 in m1" after a faint) must still pick from the 4 brought mons.
    if (sideL === 'mine' && ctx.myBring && !ctx.myBring.includes(teamIndex)) {
      const species = ctx.myTeam[teamIndex]?.species ?? `m${teamIndex + 1}`;
      return { ok: false, error: `${species} wasn't brought to this battle — pick one of your 4 brought mons` };
    }
    return { ok: true, kind: 'state', update: { side: sideL, teamIndex, bringIntoSlot: slot } };
  }

  return null;
}

export function parseTurnLine(line: string, ctx: ParseContext, order: number): ParseResult {
  // State updates take precedence: they're disambiguated by `=`, `ko`/`fainted`,
  // or `in`, none of which appear in action syntax.
  const state = tryParseState(line, ctx);
  if (state) return state;

  // Standalone mega declaration: "m1 mega" / "o1 mega" / "m1 mega y" /
  // "o2 mega x" — no `>` separator. The trailing letter (when present)
  // disambiguates Charizard / Mewtwo X-vs-Y formes. The move field carries
  // the variant ('mega', 'mega-x', 'mega-y') so finalizeTurn can resolve
  // the actual forme name + mega-stone item via @pokechamps/core/domain/
  // gimmicks/mega's resolveMegaForme().
  const megaMatch = line.trim().match(/^([mo])([1-6])\s+mega(?:[-\s]+([a-z]))?$/i);
  if (megaMatch) {
    const side: FieldSide = megaMatch[1]!.toLowerCase() === 'm' ? 'mine' : 'theirs';
    const slot = (parseInt(megaMatch[2]!, 10) - 1) as FieldSlot;
    const variant = (megaMatch[3] ?? '').toLowerCase();
    const attackerTeamIndex = activeTeamIndex(ctx, side, slot);
    if (attackerTeamIndex == null) {
      return { ok: false, error: `${megaMatch[1]}${megaMatch[2]} has no active mon to mega-evolve` };
    }
    return {
      ok: true,
      kind: 'action',
      actions: [{
        side,
        attackerSlot: slot,
        kind: 'mega',
        move: variant ? `mega-${variant}` : 'mega',
        attackerTeamIndex,
        target: 'self',
        order,
      }],
    };
  }

  const parts = line.split('>').map(s => s.trim()).filter(p => p.length > 0);
  if (parts.length < 2) return { ok: false, error: 'expected at least "<actor> > <move>"' };

  const actor = parseActor(parts[0]!);
  if (!actor) return { ok: false, error: `bad actor "${parts[0]}" — expected m1/m2/o1/o2 (optionally +mega)` };

  const verb = parts[1]!;
  const verbLc = verb.toLowerCase();

  // Switch form: <actor> > switch > <target species or teamRef>
  if (verbLc === 'switch') {
    if (parts.length < 3) return { ok: false, error: 'switch needs a target: "<actor> > switch > <species|my3>"' };
    const target = parts[2]!;
    const idx = resolveTeamRef(target, ctx, actor.side);
    if (idx == null) {
      return { ok: false, error: `couldn't resolve switch target "${target}" on ${actor.side === 'mine' ? 'my' : 'opp'} team` };
    }
    // Mine side: enforce the bring restriction — you can only send in mons
    // you committed to at preview. The brought set has 4 of 6.
    if (actor.side === 'mine' && ctx.myBring && !ctx.myBring.includes(idx)) {
      const species = ctx.myTeam[idx]?.species ?? `m${idx + 1}`;
      return { ok: false, error: `${species} wasn't brought to this battle — pick one of your 4 brought mons` };
    }
    return {
      ok: true,
      kind: 'action',
      actions: [{
        side: actor.side,
        attackerSlot: actor.slot,
        kind: 'switch',
        move: 'switch',
        attackerTeamIndex: activeTeamIndex(ctx, actor.side, actor.slot) ?? undefined,
        targetTeamIndex: idx,
        target: { side: actor.side, slot: actor.slot },
        order,
        mega: actor.mega || undefined,
        quickClaw: actor.quickClaw || undefined,
      }],
    };
  }

  // Move form: <actor> > <move> [> <target>[ > <dmg>]]
  // Two-part shape is allowed for moves with no target — Gravity, Trick Room,
  // Tailwind, Reflect, Recover (self-heal), and any other field/self move.
  // We don't check the dex's `target` field; the user knows what they're
  // logging and the parser shouldn't second-guess. Inference + turn order
  // still process these actions normally (priority + speed signal).

  // Refuse if the actor slot is empty (no one there) or the mon in it is
  // fainted. A fainted mon can't act; an empty slot needs a "X in Y"
  // replacement first.
  const attackerTeamIndex = activeTeamIndex(ctx, actor.side, actor.slot);
  if (attackerTeamIndex == null) {
    return { ok: false, error: `${parts[0]} has no active mon — bring one in first (e.g. "o3 in o1")` };
  }
  const attackerIsFainted =
    actor.side === 'mine'
      ? (ctx.myFainted ?? []).includes(attackerTeamIndex)
      : !!ctx.opponentTeam[attackerTeamIndex]?.fainted;
  if (attackerIsFainted) {
    return { ok: false, error: `${parts[0]} is fainted and can't act` };
  }

  // Two-part: <actor> > <move> — field/self-only move with no target.
  // Synthesize target='self' so the action has a meaningful shape; the
  // finalize loop skips it because there's no damage to commit.
  if (parts.length === 2) {
    return {
      ok: true,
      kind: 'action',
      actions: [{
        side: actor.side,
        attackerSlot: actor.slot,
        kind: 'move',
        move: verb,
        attackerTeamIndex,
        target: 'self',
        order,
        mega: actor.mega || undefined,
        quickClaw: actor.quickClaw || undefined,
        critical: actor.crit || undefined,
      }],
    };
  }

  const targetTok = parts[2]!;
  const parsedTarget = parseTarget(targetTok);
  if (parsedTarget == null) return { ok: false, error: `bad target "${targetTok}"` };

  // Spread / foes target with per-target damage list:
  //   "m1 > Heat Wave > spread > o1:40, o2:35"
  // Parser emits one action per target with shared order + move; the rest of
  // the pipeline (finalize, inference, history) treats each as its own observation.
  if ((parsedTarget === 'foes') && parts[3]) {
    const spreadActions = parseSpreadDamage(parts[3], ctx);
    if (spreadActions.ok === false) return spreadActions;
    const actions: MoveAction[] = spreadActions.entries.map(e => ({
      side: actor.side,
      attackerSlot: actor.slot,
      kind: 'move',
      move: verb,
      attackerTeamIndex,
      targetTeamIndex: e.targetTeamIndex,
      target: { side: e.targetSide, slot: e.targetSlot },
      order,
      mega: actor.mega || undefined,
      critical: actor.crit || undefined,
      quickClaw: actor.quickClaw || undefined,
      ...e.dmg,
    }));
    return { ok: true, kind: 'action', actions };
  }

  // Multi-hit single-target list: "o1 > Beat Up > o1 > 99,98,97,96,90(crit)".
  // Each comma value is the target's REMAINING HP after that hit (side-aware
  // unit — % for opp, raw for mine); an optional "(crit)" tags a critical hit.
  // We emit one action per hit sharing the actor/move/order; finalizeTurn's
  // running-HP map converts each to its own damage delta + inference
  // observation, and the per-hit crit flag flows through to the calc.
  if (typeof parsedTarget === 'object' && parts[3] && parts[3].includes(',')) {
    const mh = parseMultiHit(parts[3], parsedTarget.side);
    if (mh.ok === false) return mh;
    const targetTeamIndex = activeTeamIndex(ctx, parsedTarget.side, parsedTarget.slot);
    const actions: MoveAction[] = mh.hits.map(h => ({
      side: actor.side,
      attackerSlot: actor.slot,
      kind: 'move',
      move: verb,
      attackerTeamIndex: attackerTeamIndex ?? undefined,
      targetTeamIndex: targetTeamIndex ?? undefined,
      target: { side: parsedTarget.side, slot: parsedTarget.slot },
      order,
      mega: actor.mega || undefined,
      quickClaw: actor.quickClaw || undefined,
      critical: h.critical || actor.crit || undefined,
      ...h.dmg,
    }));
    return { ok: true, kind: 'action', actions };
  }

  const damageTargetSide: FieldSide | undefined =
    typeof parsedTarget === 'object' ? parsedTarget.side : undefined;

  // Trailing `sash` in the damage slot: the target survived this hit via Focus
  // Sash. `o1 > 1 sash` (remaining 1), `o1 > 0 sash` / `o1 > sash` (no/￪zero
  // value → forced to a 1-sliver). Strip the flag, parse the rest as remaining.
  let dmgTok: string | undefined = parts[3];
  let sash = false;
  if (dmgTok) {
    const t = dmgTok.trim();
    if (/^sash$/i.test(t)) { sash = true; dmgTok = undefined; }
    else {
      const m = t.match(/^(.*\S)\s+sash$/i);
      if (m) { sash = true; dmgTok = m[1]; }
    }
  }
  const dmg = parseDamage(dmgTok, damageTargetSide);
  if (sash) {
    if (damageTargetSide === 'mine') {
      dmg.targetRemainingHpRaw = Math.max(1, dmg.targetRemainingHpRaw ?? 1);
      dmg.damageRaw = undefined; dmg.damageHpPercent = undefined; dmg.targetRemainingHpPercent = undefined;
    } else {
      dmg.targetRemainingHpPercent = Math.max(1, dmg.targetRemainingHpPercent ?? 1);
      dmg.damageHpPercent = undefined; dmg.damageRaw = undefined; dmg.targetRemainingHpRaw = undefined;
    }
  }

  const target: MoveAction['target'] =
    typeof parsedTarget === 'string'
      ? parsedTarget
      : { side: parsedTarget.side, slot: parsedTarget.slot };

  const targetTeamIndex =
    typeof parsedTarget === 'object'
      ? activeTeamIndex(ctx, parsedTarget.side, parsedTarget.slot)
      : null;

  return {
    ok: true,
    kind: 'action',
    actions: [{
      side: actor.side,
      attackerSlot: actor.slot,
      kind: 'move',
      move: verb,
      attackerTeamIndex: attackerTeamIndex ?? undefined,
      targetTeamIndex: targetTeamIndex ?? undefined,
      target,
      order,
      mega: actor.mega || undefined,
      critical: actor.crit || undefined,
      quickClaw: actor.quickClaw || undefined,
      sash: sash || undefined,
      ...dmg,
    }],
  };
}

// Multi-hit damage syntax for a single target: "99,98,97,96,90(crit)". Each
// value is the target's remaining HP after that hit (side-aware unit), with an
// optional "(crit)" suffix on any hit. Returns one entry per hit.
function parseMultiHit(token: string, targetSide: FieldSide):
  | { ok: true; hits: Array<{ dmg: ReturnType<typeof parseDamage>; critical: boolean }> }
  | { ok: false; error: string }
{
  const hits: Array<{ dmg: ReturnType<typeof parseDamage>; critical: boolean }> = [];
  for (const raw of token.split(',').map(s => s.trim()).filter(Boolean)) {
    const m = raw.match(/^(\d+(?:\.\d+)?)(%?)\s*(\(\s*crit\s*\))?$/i);
    if (!m) return { ok: false, error: `multi-hit value "${raw}" — expected e.g. 90 or 90(crit)` };
    const dmg = parseDamage(m[1]! + (m[2] ?? ''), targetSide);
    hits.push({ dmg, critical: !!m[3] });
  }
  if (hits.length === 0) return { ok: false, error: 'multi-hit needs at least one value' };
  return { ok: true, hits };
}

// Spread damage syntax: "o1:40, o2:35" / "o1:40,o2:35" / per-target side-aware
// unit (raw for mN, percent for oN). Returns one entry per target.
function parseSpreadDamage(token: string, ctx: ParseContext):
  | { ok: true; entries: Array<{ targetSide: FieldSide; targetSlot: FieldSlot; targetTeamIndex: number | undefined; dmg: ReturnType<typeof parseDamage> }> }
  | { ok: false; error: string }
{
  const entries: Array<{ targetSide: FieldSide; targetSlot: FieldSlot; targetTeamIndex: number | undefined; dmg: ReturnType<typeof parseDamage> }> = [];
  for (const raw of token.split(',').map(s => s.trim()).filter(Boolean)) {
    const m = raw.match(/^([mo])([12])\s*:\s*(.+)$/i);
    if (!m) return { ok: false, error: `spread damage must look like "o1:40, o2:35" — got "${raw}"` };
    const side: FieldSide = m[1]!.toLowerCase() === 'm' ? 'mine' : 'theirs';
    const slot = (parseInt(m[2]!, 10) - 1) as FieldSlot;
    const dmg = parseDamage(m[3]!, side);
    const teamIdx = activeTeamIndex(ctx, side, slot);
    entries.push({ targetSide: side, targetSlot: slot, targetTeamIndex: teamIdx ?? undefined, dmg });
  }
  if (entries.length === 0) return { ok: false, error: 'spread damage needs at least one "oN:value" entry' };
  return { ok: true, entries };
}
