import type { FieldState, OpponentEntry } from './types.js';
import { toId } from './data.js';

// Observation-driven ability narrowing (the inference "backward half" for the
// ability axis). Mirrors the shape of abilitiesRuledOutByHit in inference.ts:
// each function maps a VERIFIED battle event to the set of ability ids that
// event proves the mon does NOT have. The rule-outs persist on
// `OpponentEntry.abilitiesRuledOut` for the rest of the match and feed both
// the inference solver's ability axis and certainAbility (a 2-ability species
// with one ruled out becomes CERTAIN, unlocking switch-in effects / Magic
// Guard checks / calc enrichment for the survivor).
//
// Conservatism rule: only EXPLICITLY-OBSERVED events qualify. A status the
// engine auto-applies (a logged Will-O-Wisp assumed to hit, a Spicy Spray
// burn) is an engine assumption — the move may have missed or been blocked by
// the very ability we'd be ruling out — so those paths deliberately do NOT
// rule anything out. Same for end-of-turn sand chip, which the engine applies
// on its own initiative rather than observing.

// Non-volatile status → abilities that PREVENT that status landing (Gen 9).
// A demonstrably-landed status rules these out regardless of source: even a
// self-inflicted Flame Orb burn is blocked by Water Veil, so the landing is
// proof either way. Pokémon whose status was cured by a berry still COUNT —
// the status landed first, the berry cured it after.
//
// Deliberate omissions: Flower Veil (protects only Grass-types — type-
// conditional, niche), Shields Down (forme-conditional, Minior off-format),
// Hydration / Shed Skin (cure AFTER landing, not prevention), terrain
// immunities (field state + groundedness, not an ability of the mon).
const STATUS_IMMUNITY_ABILITIES: Record<string, string[]> = {
  brn: ['Water Veil', 'Water Bubble', 'Thermal Exchange', 'Purifying Salt', 'Comatose'],
  par: ['Limber', 'Purifying Salt', 'Comatose'],
  psn: ['Immunity', 'Pastel Veil', 'Purifying Salt', 'Comatose'],
  tox: ['Immunity', 'Pastel Veil', 'Purifying Salt', 'Comatose'],
  slp: ['Insomnia', 'Vital Spirit', 'Sweet Veil', 'Purifying Salt', 'Comatose'],
  frz: ['Magma Armor', 'Purifying Salt', 'Comatose'],
};

// Attacker abilities that bypass the target's status-immunity abilities — a
// status landed THROUGH one of these proves nothing about the target.
// Mycelium Might only ignores abilities for status moves, but every status a
// Toedscruel-style attacker lands via a status move is exactly that case, so
// the coarse gate is safe (it only ever suppresses a rule-out, never fakes one).
const ABILITY_IGNORING_ATTACKERS = new Set(['moldbreaker', 'teravolt', 'turboblast', 'myceliummight']);

export function attackerIgnoresAbilities(ability: string | null | undefined): boolean {
  return ABILITY_IGNORING_ATTACKERS.has(toId(ability ?? ''));
}

// Ability ids ruled out by a non-volatile status LANDING on the mon.
// `weather` adds Leaf Guard when sun was active at the time (Leaf Guard only
// prevents status in sun, so a landing outside sun proves nothing).
// `attackerAbility` (when the source is known) suppresses everything if the
// attacker ignores abilities. Empty set when the status isn't in the table.
export function abilitiesRuledOutByStatus(
  status: string,
  opts?: { weather?: FieldState['weather']; attackerAbility?: string | null },
): Set<string> {
  if (opts && attackerIgnoresAbilities(opts.attackerAbility)) return new Set();
  const names = STATUS_IMMUNITY_ABILITIES[status] ?? [];
  if (!names.length) return new Set();
  const out = new Set(names.map(toId));
  if (opts?.weather === 'Sun' || opts?.weather === 'Harsh Sunshine') out.add(toId('Leaf Guard'));
  return out;
}

// Merge newly-proven rule-outs into the entry and drop now-impossible
// candidates (with their parallel likelihoods). Never empties the candidate
// set — same guard as every other narrowing pass. Shared by both finalizeTurn
// mirrors (match/engine.ts and BattleScreen.tsx). Returns true if the entry
// gained at least one new rule-out.
export function ruleOutAbilities(o: OpponentEntry, ruledIds: Iterable<string>): boolean {
  const existing = new Set(o.abilitiesRuledOut ?? []);
  let added = false;
  for (const id of ruledIds) {
    if (!existing.has(id)) { existing.add(id); added = true; }
  }
  if (!added) return false;
  o.abilitiesRuledOut = [...existing];
  filterCandidatesByAbility(o, ab => !ab || !existing.has(toId(ab)));
  return true;
}

// An explicit ability reveal (`o1 ability Defiant` / the /info screen): the
// ability axis is settled. Keep only candidates already carrying it; if none
// do (the reveal contradicts every candidate), overwrite the ability on the
// existing candidates instead — their EV/nature/item evidence still stands.
// A reveal also trumps a stale rule-out of the same id (trust the user).
export function confirmAbility(o: OpponentEntry, ability: string): void {
  const id = toId(ability);
  if (o.abilitiesRuledOut?.length) {
    o.abilitiesRuledOut = o.abilitiesRuledOut.filter(r => r !== id);
  }
  if (!o.candidates?.length) return;
  const kept = filterCandidatesByAbility(o, ab => !!ab && toId(ab) === id);
  if (!kept) {
    o.candidates = o.candidates.map(c => ({ ...c, ability }));
  }
}

// Filter candidates (+ parallel likelihoods) by an ability predicate. Returns
// true iff at least one candidate satisfies the predicate; when none do, the
// entry is left untouched (never empty the set).
function filterCandidatesByAbility(o: OpponentEntry, keep: (ability: string | undefined) => boolean): boolean {
  if (!o.candidates?.length) return false;
  const idx = o.candidates.map((c, i) => (keep(c.ability) ? i : -1)).filter(i => i >= 0);
  if (!idx.length) return false;
  if (idx.length < o.candidates.length) {
    const likes = o.candidateLikelihoods;
    o.candidates = idx.map(i => o.candidates![i]!);
    if (likes?.length) o.candidateLikelihoods = idx.map(i => likes[i] ?? 0);
  }
  return true;
}
