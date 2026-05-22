import type { Match, MoveAction, PokemonSet, OpponentEntry, Turn } from './types.js';
import { getMove, getSpecies, getNature } from './data.js';
import { getPikalytics, evFromSp } from './pikalytics.js';

// Speed stat at L50, 31 IVs — matches PoChamps' fixed-level/IV model and the
// numerical equivalence with @smogon/calc (see project-pochamps-ev-scale).
//   floor((2*base + 31 + ev/4) * 50 / 100) + 5, then * nature multiplier.
export function actualSpeed(set: PokemonSet): number {
  const sp = (getSpecies(set.species) as any)?.baseStats?.spe ?? 0;
  const ev = set.evs.spe;
  const raw = Math.floor(((2 * sp + 31 + Math.floor(ev / 4)) * 50) / 100) + 5;
  const nat = (getNature(set.nature) as any) ?? null;
  // @pkmn/dex nature shape: { plus: 'spe', minus: 'atk' } for Timid.
  const mult = nat?.plus === 'spe' ? 1.1 : nat?.minus === 'spe' ? 0.9 : 1.0;
  return Math.floor(raw * mult);
}

function movePriority(name: string): number {
  const m = getMove(name) as any;
  return typeof m?.priority === 'number' ? m.priority : 0;
}

// Effective priority bracket for an action — switches resolve at +6 (above
// every move priority bracket), so switch-vs-switch is a valid speed signal
// even with no damage logged. switch-vs-move at priority < 6 still falls in
// different brackets and gets skipped via the bracket check below.
function effectivePriority(a: MoveAction): number {
  return a.kind === 'switch' ? 6 : movePriority(a.move);
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

  for (const turn of match.turns) {
    const trickRoom = !!turn.field?.trickRoom;
    const actions = orderedActions(turn);
    for (let i = 0; i < actions.length; i++) {
      for (let j = i + 1; j < actions.length; j++) {
        const a = actions[i]!;
        const b = actions[j]!;
        // Same priority bracket only. Switches share the +6 bracket so two
        // switches DO produce a speed signal; switch-vs-priority-0-move
        // falls in different brackets and gets skipped here.
        if (effectivePriority(a) !== effectivePriority(b)) continue;
        // i < j guarantees a moved before b in the turn order.

        // ---- mine-vs-opp ---------------------------------------------------
        if (a.side !== b.side) {
          const aMine = a.side === 'mine';
          const myAction = aMine ? a : b;
          const oppAction = aMine ? b : a;
          const myFirst = aMine ? true : false; // a is at index i, b at j>i

          const mySet = myTeam[myAction.attackerTeamIndex ?? -1];
          const oppIdx = oppAction.attackerTeamIndex;
          if (!mySet || oppIdx == null) continue;
          const mySpd = actualSpeed(mySet);
          const inversion = trickRoom ? !myFirst : myFirst;

          if (inversion) {
            // My mon was "faster in turn order" given the field, so opp must
            // be strictly slower: opp <= my - 1.
            tightenMax(oppIdx, mySpd - 1);
          } else {
            // Opp moved first in their bracket: opp >= my + 1.
            tightenMin(oppIdx, mySpd + 1);
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
    const expected = expectedSpeed(entry.species);
    const env = bareEnvelope(entry.species);
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
      species: entry.species,
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
  const env = bareEnvelope(entry.species);

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
  myActives: Array<{ slot: 0 | 1; set: PokemonSet | null; status?: string }>;
  oppActives: Array<{ slot: 0 | 1; entry: OpponentEntry | null }>;
  field: { trickRoom?: boolean; myTailwind?: boolean; theirTailwind?: boolean };
}): TurnOrderEntry[] {
  const rows: TurnOrderEntry[] = [];
  const finalize = (v: number, tw: number, par: boolean) => Math.floor(v * tw * (par ? 0.5 : 1));

  for (const a of args.myActives) {
    if (!a.set) continue;
    const tw = args.field.myTailwind ? 2 : 1;
    const par = a.status === 'par';
    const raw = actualSpeed(a.set);
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

// Merge an inference result into the opponent entries (mutating). Returns
// the same array for fluent use.
//
// Side effect that callers rely on: when a speed bound tightens, we also
// prune `entry.candidates` to spreads whose actualSpeed satisfies the bound.
// This is how speed observations propagate into damage predictions — a
// "must have ≥ X speed" rule drops candidates whose SP went elsewhere, so
// the surviving candidates have less budget for other stats too. (Nature is
// honored because actualSpeed applies the multiplier.)
//
// Defensive: if the filter would empty the candidate list, we keep the
// original — better a wider belief than a contradiction from a mistyped log.
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

    if (e.candidates?.length && (s.speedFloor != null || s.speedCeiling != null)) {
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
