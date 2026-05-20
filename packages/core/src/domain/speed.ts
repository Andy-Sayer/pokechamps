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

export interface SpeedInference {
  speedFloor?: number;
  speedCeiling?: number;
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
//   X moved before Y, same priority, no Trick Room  =>  speed(X) >= speed(Y)
//   With Trick Room                                  =>  speed(X) <= speed(Y)
// Switches resolve before any move at priority +6 — treat them as priority 6
// so they're skipped against priority-0 attacks (different bracket).
// Outputs one SpeedInference per opponentTeam slot.
export function inferOpponentSpeeds(match: Match, myTeam: PokemonSet[]): SpeedInference[] {
  const out: SpeedInference[] = match.opponentTeam.map(() => ({}));

  for (const turn of match.turns) {
    const trickRoom = !!turn.field?.trickRoom;
    const actions = orderedActions(turn);
    for (let i = 0; i < actions.length; i++) {
      for (let j = i + 1; j < actions.length; j++) {
        const a = actions[i]!;
        const b = actions[j]!;
        // Skip switches — they're resolved before moves at priority +6 and
        // don't depend on the switching mon's stat.
        if (a.kind === 'switch' || b.kind === 'switch') continue;
        // Must be opposite sides for the constraint to bind a known stat to
        // an unknown one.
        if (a.side === b.side) continue;
        // Same priority bracket only.
        if (movePriority(a.move) !== movePriority(b.move)) continue;

        // Map each action to (set, opponentIndex|null). The opponent action
        // contributes the unknown stat we're constraining.
        const aMine = a.side === 'mine';
        const myAction = aMine ? a : b;
        const oppAction = aMine ? b : a;
        const myFirst = aMine ? (i < j) : (j < i);

        const mySet = myTeam[myAction.attackerTeamIndex ?? -1];
        const oppIdx = oppAction.attackerTeamIndex;
        if (!mySet || oppIdx == null) continue;
        const mySpd = actualSpeed(mySet);
        const inversion = trickRoom ? !myFirst : myFirst;

        const slot = out[oppIdx]!;
        if (inversion) {
          // My mon was "faster in turn order" given the field — so opp speed
          // <= my speed - 1 (strict, because ties are coin flips).
          const ceil = mySpd - 1;
          slot.speedCeiling = slot.speedCeiling == null
            ? ceil
            : Math.min(slot.speedCeiling, ceil);
        } else {
          // Opp moved first in their bracket: opp speed >= my speed + 1.
          const floor = mySpd + 1;
          slot.speedFloor = slot.speedFloor == null
            ? floor
            : Math.max(slot.speedFloor, floor);
        }
      }
    }
  }

  // Scarf-suspected flag: floor exceeds Pikalytics expected speed.
  for (let k = 0; k < match.opponentTeam.length; k++) {
    const entry = match.opponentTeam[k]!;
    const inf = out[k]!;
    if (inf.speedFloor == null) continue;
    const expected = expectedSpeed(entry.species);
    if (expected != null && inf.speedFloor > expected) {
      inf.scarfSuspected = true;
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
    let min: number | null = null;
    let max: number | null = null;
    let uncertain = false;
    // Priority 1: explicit bounds from speed inference.
    if (a.entry.speedFloor != null || a.entry.speedCeiling != null) {
      min = a.entry.speedFloor ?? null;
      max = a.entry.speedCeiling ?? null;
      uncertain = min !== max;
    }
    // Priority 2: candidate-derived range.
    if (min == null || max == null) {
      const cand = candidateRange(a.entry);
      if (cand) {
        min = min ?? cand.min;
        max = max ?? cand.max;
        uncertain = cand.min !== cand.max;
      }
    }
    // Priority 3/4: Pikalytics expected speed (pin midpoint) OR bare envelope.
    if (min == null || max == null) {
      const env = bareEnvelope(a.entry.species);
      const exp = expectedSpeed(a.entry.species);
      if (env) {
        min = min ?? env.min;
        max = max ?? env.max;
        if (exp != null && env.min <= exp && exp <= env.max) {
          // Center the range on the expected speed but keep the envelope edges.
          uncertain = true;
        } else {
          uncertain = env.min !== env.max;
        }
      } else if (exp != null) {
        min = exp; max = exp;
      }
    }
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
  }
  return opponentTeam;
}
