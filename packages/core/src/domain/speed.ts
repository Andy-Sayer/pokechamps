import type { Match, MoveAction, PokemonSet, OpponentEntry, Turn, FieldState } from './types.js';
import { NEUTRAL_FIELD } from './types.js';
import { getMove, getSpecies, getNature, toId } from './data.js';
import { getPikalytics, evFromSp } from './pikalytics.js';
import { fieldMoveEffect } from './fieldMoves.js';

// Speed stat at L50, 31 IVs — matches PoChamps' fixed-level/IV model and the
// numerical equivalence with @smogon/calc (see project-pochamps-ev-scale).
//   floor((2*base + 31 + ev/4) * 50 / 100) + 5, then * nature multiplier.
//
// Optional formeOverride lets callers look up the speed of a different forme
// of the same set (e.g. the post-mega forme). EVs/nature stay; only the base
// species changes — which is exactly what mega evolution does to stats.
export function actualSpeed(set: PokemonSet, formeOverride?: string): number {
  return actualStat(set, 'spe', formeOverride);
}

// A non-HP stat at L50 / 31 IVs (the format's fixed level), with EVs + nature.
// Generalises actualSpeed; used for Strength Sap's heal (= target's Attack stat).
export function actualStat(set: PokemonSet, stat: 'atk' | 'def' | 'spa' | 'spd' | 'spe', formeOverride?: string): number {
  const speciesName = formeOverride ?? set.species;
  const base = (getSpecies(speciesName) as any)?.baseStats?.[stat] ?? 0;
  const ev = (set.evs as any)?.[stat] ?? 0;
  const raw = Math.floor(((2 * base + 31 + Math.floor(ev / 4)) * 50) / 100) + 5;
  const nat = (getNature(set.nature) as any) ?? null;
  // @pkmn/dex nature shape: { plus: 'spe', minus: 'atk' } for Timid.
  const mult = nat?.plus === stat ? 1.1 : nat?.minus === stat ? 0.9 : 1.0;
  return Math.floor(raw * mult);
}

function movePriority(name: string): number {
  const m = getMove(name) as any;
  return typeof m?.priority === 'number' ? m.priority : 0;
}

// The species whose base stats are in effect for an opponent NOW: the post-mega
// forme once it has mega-evolved (megaUsed), else the base species. Stat/speed
// derivations key off this so an already-mega'd mon uses its mega base stats
// even when inference hasn't produced candidates. applyMegaAction sets
// megaUsed + megaForme.
function activeOppSpecies(entry: OpponentEntry): string {
  return entry.megaUsed && entry.megaForme ? entry.megaForme : entry.species;
}

// Per-action context for priority resolution. Optional fields default to "no
// information" — without an attacker ability we just use the move's natural
// priority. Threading this avoids a circular ctx import in callers that
// don't need ability awareness (tests, etc.).
interface PriorityCtx {
  attackerAbility?: string | null;
  attackerHpPercent?: number; // 0..100, default 100
}

// Ability-driven priority bumps. Same bracket-equality contract as Quick
// Claw: when an ability lifts a move out of its natural bracket, it stops
// generating speed signals against same-natural-bracket actions — which is
// correct, since the ability (not the stat) is what made it go first.
//
// Covered today:
//   Prankster   +1 to status moves   (still skip-the-bracket even vs Dark:
//                                      the move FAILS but it was still
//                                      attempted in the +1 bracket)
//   Gale Wings  +1 to Flying moves   (Gen 7+: only at 100% HP)
//   Triage      +3 to healing moves
//   Stall       -7 to all moves      (moves last in bracket)
// When an opponent's ability is UNKNOWN, a priority-affecting ability it could
// plausibly have (it's in the species' ability pool) is enough to explain why a
// move went first — so we must NOT read speed from that ordering. Returns the
// priority ability the species could be running for THIS move, else null. Most
// important case: Whimsicott / Grimmsnarl etc. setting Tailwind (a Status move)
// via Prankster — without this they look like a Choice Scarf outspeed.
function plausiblePriorityAbility(speciesName: string, move: string | undefined, hpPercent: number): string | null {
  if (!move) return null;
  const sp = getSpecies(speciesName) as { abilities?: Record<string, string> } | undefined;
  if (!sp?.abilities) return null;
  const pool = new Set(Object.values(sp.abilities).map(a => toId(a)));
  const m = getMove(move) as any;
  if (!m) return null;
  if (m.category === 'Status' && pool.has('prankster')) return 'Prankster';
  if (m.type === 'Flying' && hpPercent >= 100 && pool.has('galewings')) return 'Gale Wings';
  if ((m.flags?.heal || m.heal || m.drain) && pool.has('triage')) return 'Triage';
  return null;
}

function abilityBracketBump(a: MoveAction, ctx: PriorityCtx): number {
  if (a.kind === 'switch' || a.kind === 'mega') return 0;
  const ab = ctx.attackerAbility?.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!ab) return 0;
  const m = getMove(a.move) as any;
  if (!m) return 0;
  if (ab === 'prankster' && m.category === 'Status') return 1;
  if (ab === 'galewings' && m.type === 'Flying' && (ctx.attackerHpPercent ?? 100) >= 100) return 1;
  if (ab === 'triage' && (m.flags?.heal || m.heal || m.drain)) return 3;
  if (ab === 'stall') return -7;
  return 0;
}

// Effective priority bracket for an action. Brackets resolve top-down each
// turn:
//   +6 switches      — switch-vs-switch is a speed signal
//   +5 mega          — mega-vs-mega is a speed signal (between switches
//                       and move priorities); confirmed via Bulbapedia's
//                       turn-order page
//   +N moves         — move's intrinsic priority + ability bumps + Quick Claw
//
// Cross-bracket pairs (switch-vs-move, mega-vs-move, etc.) get skipped via
// the bracket equality check in inferOpponentSpeeds.
function effectivePriority(a: MoveAction, ctx: PriorityCtx = {}): number {
  if (a.kind === 'switch') {
    // Pivot-forced switches (U-turn -> switch) inherit the pivot move's
    // bracket, not the natural +6 switch bracket. Use a sentinel value
    // that no real action will match (-99) so the bracket-equality check
    // never pairs them with anything — same effect as "skip this action".
    if (a.pivot) return -99;
    return 6;
  }
  if (a.kind === 'mega')   return 5;
  // Quick Claw (+1 to whatever priority bracket the move is in) lifts the
  // action out of its natural bracket. Pairing against same-natural-
  // bracket actions then fails the bracket-equality check and produces
  // no speed signal — which is correct, since the claw was the reason
  // the mon went first, not its speed stat.
  return movePriority(a.move) + (a.quickClaw ? 1 : 0) + abilityBracketBump(a, ctx);
}

export interface SpeedInference {
  speedFloor?: number;
  speedCeiling?: number;
  /** 0-100 chance the opp is running Choice Scarf (or another non-standard
   *  speed booster). Derived from how far the inferred floor exceeds the
   *  Pikalytics top spread, capped at the bare-envelope max:
   *    floor ≤ expected           → 0   (consistent with the popular spread)
   *    floor > envelope max       → 100 (no nature/EV combo could hit this)
   *    else                       → linear ramp between the two
   *  A high value isn't proof — the mon could still be running an unusual
   *  spread with max Spe investment + Jolly nature. The user reads the
   *  number as "how unusual would the non-scarf alternative be". */
  scarfChance?: number;
  /** Derived alias: scarfChance ≥ 50. Kept so older callers keep working. */
  scarfSuspected?: boolean;
}

// Pikalytics-derived expected speed for the opp's top spread. Returns
// undefined if we have no cached entry (no expectation, no scarf flag).
function expectedSpeed(speciesName: string): number | undefined {
  const pik = getPikalytics(speciesName);
  if (!pik?.topSpread || !pik.baseStats) return undefined;
  const speEv = evFromSp(pik.topSpread.sp[5]);
  const base = pik.baseStats.spe;
  const raw = Math.floor(((2 * base + 31 + Math.floor(speEv / 4)) * 50) / 100) + 5;
  const nat = (getNature(pik.topSpread.nature) as any) ?? null;
  const mult = nat?.plus === 'spe' ? 1.1 : nat?.minus === 'spe' ? 0.9 : 1.0;
  return Math.floor(raw * mult);
}

// Per-turn pairwise rules:
//   X moved before Y, same priority, no Trick Room  =>  speed(X) > speed(Y)
//   With Trick Room                                  =>  speed(X) < speed(Y)
// Switches are skipped (they resolve before moves at priority +6).
//
// Three pair shapes contribute:
//   - mine-vs-opp: my speed is known exactly, so opp gets a hard floor/ceiling.
//   - opp-vs-opp:  neither speed is known; we constrain each opp using the
//                  OTHER opp's current range (candidates / bare envelope plus
//                  any constraints accumulated from earlier turns).
//   - mine-vs-mine: both known; nothing to infer.
//
// Outputs one SpeedInference per opponentTeam slot.
export function inferOpponentSpeeds(match: Match, myTeam: PokemonSet[]): SpeedInference[] {
  const out: SpeedInference[] = match.opponentTeam.map(() => ({}));

  // Per-opp working range. Initialized from the candidate set (if inference
  // has narrowed one) or the bare 0/252-EV envelope. This is what we use to
  // bind opp-vs-opp constraints — we don't know either speed exactly, so we
  // pull from the most-constrained range we have.
  const workMin: (number | null)[] = match.opponentTeam.map(e => {
    const c = candidateRange(e);
    if (c) return c.min;
    const env = bareEnvelope(e.species);
    return env?.min ?? null;
  });
  const workMax: (number | null)[] = match.opponentTeam.map(e => {
    const c = candidateRange(e);
    if (c) return c.max;
    const env = bareEnvelope(e.species);
    return env?.max ?? null;
  });
  // Both write-throughs accumulate observation-derived bounds on `out[]` AND
  // keep the workMin/workMax mirror current so opp-vs-opp constraints later
  // in the same turn use the latest knowledge. The bounds we emit on `out`
  // can be looser than the bare envelope (e.g. opp-vs-opp gives a ceiling
  // derived from the other opp's bare max); effectiveSpeedRange downstream
  // combines them with the envelope/candidate range and takes the tightest
  // values, so this is fine.
  const tightenMin = (idx: number, v: number) => {
    workMin[idx] = workMin[idx] == null ? v : Math.max(workMin[idx]!, v);
    const slot = out[idx]!;
    slot.speedFloor = slot.speedFloor == null ? v : Math.max(slot.speedFloor, v);
  };
  const tightenMax = (idx: number, v: number) => {
    workMax[idx] = workMax[idx] == null ? v : Math.min(workMax[idx]!, v);
    const slot = out[idx]!;
    slot.speedCeiling = slot.speedCeiling == null ? v : Math.min(slot.speedCeiling, v);
  };

  // Resolve attacker ability + HP for a given action so effectivePriority
  // can apply Prankster / Gale Wings / Triage / Stall bumps. Falls back to
  // null when unknown — without an ability we treat the move at its
  // natural priority.
  const ctxFor = (a: MoveAction): PriorityCtx => {
    const idx = a.attackerTeamIndex;
    if (idx == null) return {};
    if (a.side === 'mine') {
      const set = myTeam[idx];
      const hp = match.myCurrentHp?.[idx] ?? 100;
      return { attackerAbility: set?.ability ?? null, attackerHpPercent: hp };
    }
    const entry = match.opponentTeam[idx];
    const hp = entry?.currentHpPercent ?? 100;
    // Known ability wins; otherwise fall back to a priority ability the species
    // could plausibly have for this move (e.g. Prankster on a status move), so
    // an ability-driven "moved first" isn't misread as a Choice Scarf outspeed.
    const ability = entry?.ability ?? plausiblePriorityAbility(entry?.species ?? '', a.move, hp);
    return { attackerAbility: ability, attackerHpPercent: hp };
  };

  // Earliest turn index at which each of my mons mega-evolved. Mega persists,
  // so from that turn on the mon moves at its mega forme's speed. We reconstruct
  // this from the action log (a `mega` flag or standalone mega action) so an
  // ordering observed on/after the mega turn is solved against the right speed.
  const myMegaTurn = new Map<number, number>();
  match.turns.forEach((t, ti) => {
    for (const a of t.actions) {
      if (a.side !== 'mine' || a.attackerTeamIndex == null) continue;
      if ((a.kind === 'mega' || a.mega) && !myMegaTurn.has(a.attackerTeamIndex)) {
        myMegaTurn.set(a.attackerTeamIndex, ti);
      }
    }
  });
  const myFormeAt = (idx: number, ti: number): string | undefined => {
    const mt = myMegaTurn.get(idx);
    return mt != null && ti >= mt ? match.myMegaForme?.[idx] : undefined;
  };

  for (let ti = 0; ti < match.turns.length; ti++) {
    const turn = match.turns[ti]!;
    // Field at the START of this turn = the previous turn's post-turn snapshot
    // (NEUTRAL on turn 0). Trick Room uses the START state: TR is priority −7,
    // so it resolves LAST and never reorders the turn it is set on.
    const startField: FieldState = ti > 0 ? match.turns[ti - 1]!.field : NEUTRAL_FIELD;
    const trickRoom = !!startField.trickRoom;
    const actions = orderedActions(turn);
    // Gen 9 dynamic speed: a Tailwind set earlier in the turn doubles its
    // side's speed for actions resolving AFTER it, same turn. Tailwind sets the
    // USER's side, so a side's Tailwind is active at ordered-position `p` iff it
    // was up at turn start OR a setter on that side resolved before `p`.
    const twActive = (side: MoveAction['side'], p: number): boolean => {
      const start = side === 'mine' ? !!startField.myTailwind : !!startField.theirTailwind;
      if (start) return true;
      for (let q = 0; q < p; q++) {
        const a = actions[q]!;
        if (a.side === side && fieldMoveEffect(a.move)?.tailwind) return true;
      }
      return false;
    };
    for (let i = 0; i < actions.length; i++) {
      for (let j = i + 1; j < actions.length; j++) {
        const a = actions[i]!;
        const b = actions[j]!;
        // Same priority bracket only. Switches share the +6 bracket so two
        // switches DO produce a speed signal; switch-vs-priority-0-move
        // falls in different brackets and gets skipped here.
        if (effectivePriority(a, ctxFor(a)) !== effectivePriority(b, ctxFor(b))) continue;
        // i < j guarantees a moved before b in the turn order.

        // ---- mine-vs-opp ---------------------------------------------------
        if (a.side !== b.side) {
          const aMine = a.side === 'mine';
          const myAction = aMine ? a : b;
          const oppAction = aMine ? b : a;
          const myPos = aMine ? i : j;        // ordered position of my action
          const oppPos = aMine ? j : i;
          const myFirst = aMine ? true : false; // a is at index i, b at j>i

          const myIdx = myAction.attackerTeamIndex ?? -1;
          const mySet = myTeam[myIdx];
          const oppIdx = oppAction.attackerTeamIndex;
          if (!mySet || oppIdx == null) continue;

          // My EFFECTIVE speed when my action resolved: mega forme (if mega'd by
          // this turn) × Tailwind in effect at my action's position. Divide out
          // the opponent's own Tailwind so the bound is on their RAW Spe stat.
          // Paralysis is intentionally NOT modelled here — there is no per-turn
          // status history, and applying current status retroactively would
          // corrupt otherwise-clean turns.
          const myEff = actualSpeed(mySet, myFormeAt(myIdx, ti)) * (twActive('mine', myPos) ? 2 : 1);
          const oppFactor = twActive('theirs', oppPos) ? 2 : 1;
          const x = myEff / oppFactor;
          const inversion = trickRoom ? !myFirst : myFirst;

          if (inversion) {
            // My effective speed was the higher one → opp raw < x.
            tightenMax(oppIdx, Math.ceil(x) - 1);
          } else {
            // Opp's effective speed was the higher one → opp raw > x.
            tightenMin(oppIdx, Math.floor(x) + 1);
          }
          continue;
        }

        // ---- opp-vs-opp ----------------------------------------------------
        if (a.side === 'theirs') {
          const fasterIdx = a.attackerTeamIndex;
          const slowerIdx = b.attackerTeamIndex;
          if (fasterIdx == null || slowerIdx == null) continue;
          if (fasterIdx === slowerIdx) continue; // same mon, no constraint
          // Without TR, the earlier action's mon was faster. Under TR the
          // earlier action's mon was SLOWER, so flip the assignment.
          const [hiIdx, loIdx] = trickRoom ? [slowerIdx, fasterIdx] : [fasterIdx, slowerIdx];
          // hi.speed > lo.speed → constrain using each other's current range:
          //   hi.min ≥ lo.min + 1  (since hi must beat the slowest lo could be)
          //   lo.max ≤ hi.max - 1  (since lo must be below the fastest hi could be)
          const loMin = workMin[loIdx];
          const hiMax = workMax[hiIdx];
          if (loMin != null) tightenMin(hiIdx, loMin + 1);
          if (hiMax != null) tightenMax(loIdx, hiMax - 1);
        }
        // mine-vs-mine pairs tell us nothing — both speeds known.
      }
    }
  }

  // Scarf chance: how unusual the non-scarf alternative would be, given the
  // observed floor. Linear ramp from Pikalytics expected → bare envelope max.
  for (let k = 0; k < match.opponentTeam.length; k++) {
    const entry = match.opponentTeam[k]!;
    const inf = out[k]!;
    if (inf.speedFloor == null) continue;
    const expected = expectedSpeed(activeOppSpecies(entry));
    const env = bareEnvelope(activeOppSpecies(entry));
    if (expected == null || env == null) continue;
    const floor = inf.speedFloor;
    let chance: number;
    if (floor <= expected) chance = 0;
    else if (floor > env.max) chance = 100;
    else if (env.max === expected) chance = 100; // degenerate; avoid div by zero
    else chance = Math.round(((floor - expected) / (env.max - expected)) * 100);
    if (chance > 0) {
      inf.scarfChance = chance;
      inf.scarfSuspected = chance >= 50;
    }
  }

  return out;
}

function orderedActions(turn: Turn): MoveAction[] {
  // Use explicit `order` when present; fall back to array order.
  const indexed = turn.actions.map((a, i) => ({ a, k: a.order ?? i + 1 }));
  indexed.sort((x, y) => x.k - y.k);
  return indexed.map(x => x.a);
}

// One row of the predicted turn-order line for the current actives. Speed is
// always reported as a range — `speedMin === speedMax` when we know exactly.
export interface TurnOrderEntry {
  label: string;          // "m1" / "o2"
  species: string;
  speedMin: number;       // lower bound of effective speed (post tailwind/paralysis)
  speedMax: number;       // upper bound
  effectiveSpeed: number; // midpoint, used as sort key
  uncertain: boolean;     // true when speedMin !== speedMax
  scarf: boolean;         // scarfSuspected, surfaced as a glyph
  unknown: boolean;       // true if we couldn't compute even a coarse envelope
  paralyzed: boolean;     // status='par' halved the result
}

// Speed at L50/31 IV for a synthetic spec. EV input is in standard 0-252
// (use evFromSp to convert PoChamps SP). Nature flags are independent of
// the actual Nature object — we just need to know if Spe is +/-.
function speedForSpec(baseSpe: number, evSpe: number, naturePlusSpe: boolean, natureMinusSpe: boolean): number {
  const raw = Math.floor(((2 * baseSpe + 31 + Math.floor(evSpe / 4)) * 50) / 100) + 5;
  const mult = naturePlusSpe ? 1.1 : natureMinusSpe ? 0.9 : 1.0;
  return Math.floor(raw * mult);
}

// Bare envelope for an opp species: the slowest the mon can theoretically be
// (0 EVs + -Spe nature) and the fastest (252 EVs + +Spe nature). Always
// returns a range; min ≤ max.
function bareEnvelope(speciesName: string): { min: number; max: number } | null {
  const sp = (getSpecies(speciesName) as any)?.baseStats?.spe;
  if (typeof sp !== 'number') return null;
  return { min: speedForSpec(sp, 0, false, true), max: speedForSpec(sp, 252, true, false) };
}

// Tighter range derived from inferred candidate sets. Each candidate is a full
// PokemonSet — compute its speed exactly. Returns null if no candidates.
function candidateRange(entry: OpponentEntry): { min: number; max: number } | null {
  if (!entry.candidates?.length) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const c of entry.candidates) {
    const synth: PokemonSet = {
      species: activeOppSpecies(entry),
      level: c.level ?? 50,
      nature: c.nature,
      evs: c.evs,
      ivs: c.ivs ?? { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      item: c.item,
      ability: c.ability,
      moves: c.moves ?? [],
    };
    const v = actualSpeed(synth);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return Number.isFinite(min) ? { min, max } : null;
}

// Resolve the combined speed range for an opp entry by walking the same
// priority chain predictTurnOrder uses internally:
//   1. Explicit speedFloor / speedCeiling from observations (most precise).
//   2. Candidate-derived range (every plausible spread we still believe).
//   3. Bare 0/252-EV envelope from base Spe (loosest).
// `source` reports which tier supplied each bound so the UI can tell the
// user where the number came from. Returns null only when we have zero
// information (species not in the dex).
export interface EffectiveSpeed {
  min: number;
  max: number;
  source: 'inferred' | 'candidates' | 'envelope' | 'mixed';
}

export function effectiveSpeedRange(entry: OpponentEntry): EffectiveSpeed | null {
  // Combine every available source by taking the TIGHTEST bounds. Inferred
  // bounds may be looser than the envelope (e.g. opp-vs-opp constraints
  // derived from the other opp's bare envelope); we want the user-visible
  // range to be at least as tight as any single source.
  const cand = candidateRange(entry);
  const env = bareEnvelope(activeOppSpecies(entry));

  let min: number | null = null;
  let max: number | null = null;
  // Track which source(s) actually pinned the bound so the UI can show
  // 'inferred' (someone observed this), 'candidates' (we've narrowed via
  // damage), 'envelope' (purely speculative), or 'mixed'.
  let minSrc: EffectiveSpeed['source'] | null = null;
  let maxSrc: EffectiveSpeed['source'] | null = null;
  const considerMin = (v: number, s: EffectiveSpeed['source']) => {
    if (min == null || v > min) { min = v; minSrc = s; }
    else if (v === min && minSrc !== s) minSrc = 'mixed';
  };
  const considerMax = (v: number, s: EffectiveSpeed['source']) => {
    if (max == null || v < max) { max = v; maxSrc = s; }
    else if (v === max && maxSrc !== s) maxSrc = 'mixed';
  };

  if (env) {           considerMin(env.min,  'envelope');   considerMax(env.max,  'envelope'); }
  if (cand) {          considerMin(cand.min, 'candidates'); considerMax(cand.max, 'candidates'); }
  if (entry.speedFloor   != null) considerMin(entry.speedFloor,   'inferred');
  if (entry.speedCeiling != null) considerMax(entry.speedCeiling, 'inferred');

  if (min == null || max == null) return null;
  // If the bound was both inferred AND already pinned by a tighter envelope/
  // candidate, label it 'mixed' so the user knows multiple sources agree.
  const source: EffectiveSpeed['source'] =
    minSrc === maxSrc ? minSrc! : 'mixed';
  return { min, max, source };
}

// Predict the order in which the 4 actives will move this turn assuming
// neutral priority. Tailwind doubles the relevant side's effective speed;
// Trick Room inverts the sort. Paralysis halves. For opp slots where the
// speed isn't pinned, returns a range derived from (in priority):
//   1. Explicit speedFloor/speedCeiling
//   2. Candidate sets (actualSpeed over each)
//   3. Pikalytics expected speed (as a midpoint hint; widens to envelope edges)
//   4. Bare 0-252 envelope from base Spe alone
export function predictTurnOrder(args: {
  myActives: Array<{ slot: 0 | 1; set: PokemonSet | null; status?: string; formeOverride?: string }>;
  oppActives: Array<{ slot: 0 | 1; entry: OpponentEntry | null }>;
  field: { trickRoom?: boolean; myTailwind?: boolean; theirTailwind?: boolean };
}): TurnOrderEntry[] {
  const rows: TurnOrderEntry[] = [];
  const finalize = (v: number, tw: number, par: boolean) => Math.floor(v * tw * (par ? 0.5 : 1));

  for (const a of args.myActives) {
    if (!a.set) continue;
    const tw = args.field.myTailwind ? 2 : 1;
    const par = a.status === 'par';
    // formeOverride carries the post-mega forme for an already-mega'd own mon
    // so its turn-order speed matches the matchup grid.
    const raw = actualSpeed(a.set, a.formeOverride);
    const v = finalize(raw, tw, par);
    rows.push({
      label: `m${a.slot + 1}`,
      species: a.set.species,
      speedMin: v, speedMax: v,
      effectiveSpeed: v,
      uncertain: false, scarf: false, unknown: false, paralyzed: par,
    });
  }

  for (const a of args.oppActives) {
    if (!a.entry) continue;
    const tw = args.field.theirTailwind ? 2 : 1;
    const par = a.entry.status === 'par';
    // Use the same helper the info panel uses so the two displays never
    // disagree. effectiveSpeedRange walks inferred → candidates → envelope.
    const eff = effectiveSpeedRange(a.entry);
    const min = eff?.min ?? null;
    const max = eff?.max ?? null;
    const uncertain = eff != null && eff.min !== eff.max;
    const finMin = min != null ? finalize(min, tw, par) : 0;
    const finMax = max != null ? finalize(max, tw, par) : 0;
    rows.push({
      label: `o${a.slot + 1}`,
      species: a.entry.species,
      speedMin: finMin, speedMax: finMax,
      effectiveSpeed: Math.floor((finMin + finMax) / 2),
      uncertain,
      scarf: !!a.entry.scarfSuspected,
      unknown: min == null,
      paralyzed: par,
    });
  }

  const trickRoom = !!args.field.trickRoom;
  rows.sort((x, y) => {
    if (x.unknown !== y.unknown) return x.unknown ? 1 : -1; // unknowns to the back
    return trickRoom ? x.effectiveSpeed - y.effectiveSpeed : y.effectiveSpeed - x.effectiveSpeed;
  });
  return rows;
}

// Choice Scarf is ruled out when we KNOW the item isn't a scarf, or the mon has
// been seen using 2+ distinct damaging moves (so it can't be Choice-locked at
// all). Only then can a high speed floor be attributed to a +Speed nature /
// investment rather than a scarf.
function scarfRuledOut(e: OpponentEntry): boolean {
  if (e.itemConsumed) return true; // scarves aren't consumed
  if (e.item) return !/choice\s*scarf/i.test(e.item);
  const damaging = new Set(
    (e.knownMoves ?? []).filter(m => {
      const cat = (getMove(m) as { category?: string } | undefined)?.category;
      return cat && cat !== 'Status';
    }),
  );
  return damaging.size >= 2;
}

// +Speed nature that preserves the offense the mon actually uses: Timid (−Atk)
// if it has a known special move, else Jolly (−SpA).
function plusSpeedNature(e: OpponentEntry): string {
  const hasSpecial = (e.knownMoves ?? []).some(m => (getMove(m) as { category?: string } | undefined)?.category === 'Special');
  return hasSpecial ? 'Timid' : 'Jolly';
}

// Raise a candidate to reach `floor`: keep it if it already does, else assign
// the minimal Spe EV under its current nature, else (scarf ruled out) promote to
// a +Speed nature. Returns null if even a +Speed-natured, budget-limited spread
// can't reach the floor — i.e. an over-bulky spread proven too slow to be real.
function fitToFloor(c: PokemonSet, floor: number, e: OpponentEntry): PokemonSet | null {
  if (actualSpeed(c) >= floor) return c;
  const otherTotal = (Object.values(c.evs) as number[]).reduce((a, b) => a + b, 0) - c.evs.spe;
  const tryNature = (nature: string): PokemonSet | null => {
    for (let ev = 0; ev <= 252; ev += 4) {
      if (otherTotal + ev > 508) break;
      const cand: PokemonSet = { ...c, nature, evs: { ...c.evs, spe: ev } };
      if (actualSpeed(cand) >= floor) return cand;
    }
    return null;
  };
  const sameNature = tryNature(c.nature);
  if (sameNature) return sameNature;
  const ps = plusSpeedNature(e);
  return ps !== c.nature ? tryNature(ps) : null;
}

// Merge an inference result into the opponent entries (mutating). Returns
// the same array for fluent use.
//
// Two candidate effects from a speed bound:
//   - Default: prune spreads whose actualSpeed violates the bound (a "must have
//     ≥ X speed" rule drops spreads whose SP went elsewhere).
//   - Confidence commit: when Choice Scarf is RULED OUT, a floor must be met by
//     stat — so we assign the minimal Spe EV (and, only if required, a +Speed
//     nature) to each candidate, which also shrinks their bulk budget and drops
//     spreads too bulky to also be that fast.
//
// Defensive: never empty the candidate list — keep the prior belief if every
// spread would be removed (guards against a contradictory mistyped log).
export function applySpeedInference(
  opponentTeam: OpponentEntry[],
  inferences: SpeedInference[],
): OpponentEntry[] {
  for (let i = 0; i < opponentTeam.length; i++) {
    const e = opponentTeam[i]!;
    const s = inferences[i] ?? {};
    e.speedFloor = s.speedFloor;
    e.speedCeiling = s.speedCeiling;
    e.scarfSuspected = s.scarfSuspected;
    e.scarfChance = s.scarfChance;

    if (!e.candidates?.length) continue;

    if (s.speedFloor != null && scarfRuledOut(e)) {
      // Confidence commit: a proven-non-scarf floor is real speed investment.
      let fitted = e.candidates
        .map(c => fitToFloor(c, s.speedFloor!, e))
        .filter((c): c is PokemonSet => c != null);
      if (s.speedCeiling != null) fitted = fitted.filter(c => actualSpeed(c) <= s.speedCeiling!);
      if (fitted.length > 0) e.candidates = fitted;
    } else if (s.speedFloor != null || s.speedCeiling != null) {
      const filtered = e.candidates.filter(c => {
        const spd = actualSpeed(c);
        if (s.speedFloor != null && spd < s.speedFloor) return false;
        if (s.speedCeiling != null && spd > s.speedCeiling) return false;
        return true;
      });
      if (filtered.length > 0) e.candidates = filtered;
    }
  }
  return opponentTeam;
}
