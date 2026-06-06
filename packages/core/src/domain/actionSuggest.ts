import type { PokemonSet, OpponentEntry, FieldSide } from './types.js';
import { parseActor, type ParseContext } from './turnparser.js';
import { getPikalytics } from './pikalytics.js';
import { getLearnset } from './data.js';

export type SuggestionKind = 'none' | 'move' | 'switch-target' | 'state-verb';

// Verbs accepted after `oN ` / `mN ` on a state line. Kept sorted by most
// common first so an empty query lands on the helpful default.
const STATE_VERBS = ['heal', 'damage', 'sitrus', 'leftovers', 'wp', 'sash', 'balloon', 'brn', 'par', 'psn', 'tox', 'slp', 'frz', 'cure', 'taunt', 'encore', 'disable', 'ko', 'fainted', 'in'];

export interface SuggestionContext {
  kind: SuggestionKind;
  query: string;
  actorSide?: FieldSide;
  actorTeamIndex?: number;
}

// Detect which `>`-separated slot the user is currently typing and what
// suggestion pool applies. State-update lines (no `>`) get state-verb
// completion after `oN ` or `mN ` (e.g. `o1 he` → suggests `heal`).
export function deriveSuggestionContext(value: string, ctx: ParseContext): SuggestionContext {
  const parts = value.split('>');
  if (parts.length < 2) {
    // No `>` — try state-line shapes. Match `oN <verb-prefix>` or `oN`.
    const stateMatch = value.match(/^\s*([mo])([1-6])\s+(\S*)\s*$/i);
    if (stateMatch) {
      // We're past the ref token and into a verb. Note: we don't validate
      // the team-index here — the state parser itself does that on submit,
      // so listing verbs is harmless even if oN doesn't resolve later.
      const side = stateMatch[1]!.toLowerCase() === 'm' ? 'mine' : 'theirs';
      return {
        kind: 'state-verb',
        query: stateMatch[3]!,
        actorSide: side as FieldSide,
      };
    }
    return { kind: 'none', query: '' };
  }

  const actor = parseActor(parts[0]!.trim());
  if (!actor) return { kind: 'none', query: '' };
  const actorTeamIndex = actor.side === 'mine'
    ? ctx.myActiveTeamIndex[actor.slot]
    : ctx.theirActiveTeamIndex[actor.slot];
  if (actorTeamIndex == null) return { kind: 'none', query: '' };

  const lastSegment = parts[parts.length - 1]!.trim();

  // Slot 1 (move/switch).
  if (parts.length === 2) {
    return {
      kind: 'move',
      query: lastSegment,
      actorSide: actor.side,
      actorTeamIndex,
    };
  }

  // Slot 2 (target | switch-target).
  if (parts.length === 3) {
    const slot1 = parts[1]!.trim().toLowerCase();
    if (slot1 === 'switch') {
      return {
        kind: 'switch-target',
        query: lastSegment,
        actorSide: actor.side,
        actorTeamIndex,
      };
    }
  }

  // Slot 3 (damage) or slot 2 (target) — too short to be worth completing.
  return { kind: 'none', query: '' };
}

// Filter a pool by case-insensitive substring of `query`. Prefix matches
// outrank substring-only matches; within a rank the original pool order is
// preserved (so callers that put known/important entries earlier keep them
// at the top).
function filterAndRank(pool: string[], query: string, limit: number): string[] {
  const q = query.toLowerCase();
  if (!q) return pool.slice(0, limit);
  const prefix: string[] = [];
  const substring: string[] = [];
  for (const name of pool) {
    const lc = name.toLowerCase();
    const idx = lc.indexOf(q);
    if (idx < 0) continue;
    (idx === 0 ? prefix : substring).push(name);
  }
  return [...prefix, ...substring].slice(0, limit);
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

export function getSuggestions(
  sctx: SuggestionContext,
  match: { myTeam: PokemonSet[]; opponentTeam: OpponentEntry[]; myFainted?: number[]; bring?: number[] },
  limit = 8,
): string[] {
  if (sctx.kind === 'state-verb') {
    return filterAndRank(STATE_VERBS, sctx.query, limit);
  }
  if (sctx.kind === 'none' || sctx.actorTeamIndex == null || sctx.actorSide == null) return [];

  if (sctx.kind === 'move') {
    let pool: string[] = [];
    if (sctx.actorSide === 'mine') {
      pool = match.myTeam[sctx.actorTeamIndex]?.moves ?? [];
    } else {
      const opp = match.opponentTeam[sctx.actorTeamIndex];
      if (opp) {
        // Ranked priority: moves we've seen this match first (highest signal),
        // then Pikalytics top moves (common meta picks), then the full legal
        // learnset (alphabetical, format-banned moves already stripped). Dedup
        // preserves the first occurrence so known/Pikalytics keep their lead.
        const known = opp.knownMoves ?? [];
        const pik = (getPikalytics(opp.species)?.moves ?? [])
          .filter(m => m.name.toLowerCase() !== 'other')
          .map(m => m.name);
        const learnset = getLearnset(opp.species);
        pool = dedupe([...known, ...pik, ...learnset]);
      }
    }
    // `switch` is always available as an action verb.
    pool = dedupe([...pool, 'switch']);
    return filterAndRank(pool, sctx.query, limit);
  }

  // switch-target: team species on the actor's side, minus fainted mons.
  // Mine: also restrict to the 4 brought to the battle (can't send in a mon
  // you didn't bring at preview). Falls back to the full 6 when no bring is
  // set so unit tests outside a real match still get suggestions.
  if (sctx.actorSide === 'mine') {
    const fainted = new Set(match.myFainted ?? []);
    const bring = match.bring ? new Set(match.bring) : null;
    const pool = match.myTeam
      .map((m, i) => ({ species: m.species, idx: i }))
      .filter(x => !fainted.has(x.idx))
      .filter(x => bring === null || bring.has(x.idx))
      .map(x => x.species);
    return filterAndRank(pool, sctx.query, limit);
  } else {
    const pool = match.opponentTeam
      .filter(o => !o.fainted)
      .map(o => o.species);
    return filterAndRank(pool, sctx.query, limit);
  }
}

// Apply a suggestion: replace the trailing partial token with `pick`.
// - 'move': appended with ' > ' so the user keeps typing the target.
// - 'switch-target': no trailer (final slot).
// - 'state-verb': append space so user can type the argument (e.g. `heal 25`).
export function applySuggestion(value: string, pick: string, kind: SuggestionKind): string {
  if (kind === 'state-verb') {
    // Replace the trailing whitespace-delimited token, not the post-`>` chunk.
    const m = value.match(/^(\s*[mo][1-6]\s+)\S*\s*$/i);
    if (m) {
      const suffix = pick === 'in' || pick === 'heal' ? ' ' : '';
      return `${m[1]}${pick}${suffix}`;
    }
    return value + pick;
  }
  const lastGt = value.lastIndexOf('>');
  const prefix = lastGt >= 0 ? value.slice(0, lastGt + 1) + ' ' : '';
  const trailer = kind === 'move' ? ' > ' : '';
  return `${prefix}${pick}${trailer}`;
}
