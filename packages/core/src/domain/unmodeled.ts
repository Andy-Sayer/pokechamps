/**
 * unmodeled.ts — "what in THIS position does the fast search only approximate?"
 *
 * The always-on recommender (`endgameSearch.ts`) is a bounded maximin that models
 * most — but not yet every — battle mechanic exactly (see
 * `docs/notes/mechanics-coverage.md`). When a position contains a mechanic we
 * approximate, the honest thing is to SAY SO — both so the user can weigh the
 * verdict and so they can opt into the exact `@pkmn/sim` engine for a precise read
 * (see the `project_sim_engine_strategy` plan).
 *
 * This module scans the live position for moves / abilities / items / statuses
 * that fall in a known-GAP class and returns human labels. It is the runtime
 * mirror of the coverage audit: as a gap moves GAP→✅ in the search, delete its
 * rule here. PURE — no I/O.
 *
 * Opponent scan is REVEALED-only (knownMoves / known ability+item), matching the
 * search's opp-conservatism: we don't warn about moves we haven't seen.
 */
import type { SearchInput } from './endgameSearch.js';
import { toId } from './data.js';

/** A mechanic present in the position that the fast search doesn't fully model. */
export interface UnmodeledMechanic {
  /** Stable key, e.g. 'sleep', 'redirection'. */
  kind: string;
  /** Short human label for the chip, e.g. 'sleep (can't act)'. */
  label: string;
  /** Concrete sources seen in THIS position, e.g. ['Amoonguss Spore']. Deduped. */
  examples: string[];
}

interface GapRule {
  kind: string;
  label: string;
  moves?: string[];      // move ids
  abilities?: string[];  // ability ids
  items?: string[];      // item ids
  statuses?: string[];   // non-volatile status ids
}

// Each rule names a class the search approximates today. Keep in lockstep with the
// GAP/PARTIAL rows of docs/notes/mechanics-coverage.md.
const RULES: GapRule[] = [
  // Sleep (incl. delayed Yawn) is now MODELLED. Follow Me / Rage Powder AND
  // ability redirection (Storm Drain/Lightning Rod absorb) are MODELLED; only
  // the position-shuffling moves remain — our slot-less model can't represent
  // them, so they stay informational.
  { kind: 'redirection', label: 'position shuffle (Ally Switch / Spotlight)',
    moves: ['allyswitch', 'spotlight'] },
  // TEAM PROTECT: rule removed 2026-07-25 — the whole class is modelled. Wide Guard
  // (spread), Quick Guard (priority), Mat Block (all DAMAGING moves, first turn out
  // only) and Crafty Shield (all STATUS moves) are each side-wide protect actions.
  // NOTE: the 100%-chance DAMAGING foe-drops (Icy Wind/Snarl/Electroweb/Struggle
  // Bug/Breaking Swipe/Low Sweep/Bulldoze/Lunge/Acid Spray/Mystical Fire/…) are now
  // MODELLED (Cell.foeDrop). Only the dedicated 0-damage stat-lowering moves remain
  // a gap — the search has no SET_DEBUFF action for them yet.
  // Single-target AND spread stat-lowering moves are now MODELLED via
  // SET_DEBUFF. Accuracy/evasion droppers stay excluded by the same policy as
  // probabilistic accuracy itself (maximin never prices hit chance) — flagged
  // as informational so the user weighs the dice.
  { kind: 'foedebuff', label: 'accuracy/evasion drop (informational — hit chance is never priced)',
    moves: ['sandattack', 'venomdrench', 'flash', 'kinesis', 'smokescreen', 'mudslap'] },
  // Two-turn charge moves are now MODELLED, weather-conditionally: the charge turn deals
  // no damage and commits the mon to firing next turn (no switching), EXCEPT where the
  // weather skips it (Solar Beam / Solar Blade in sun, Electro Shot in rain — the common
  // case for their sun/rain carriers). Semi-invulnerable charges (Fly / Dig / Phantom
  // Force) also dodge targeted damage on the charge turn. Power Herb is not legal in M-B,
  // so there is no item skip to model. What remains unmodelled is Sky Drop (it carries a
  // FOE off the field, which our slot-less model can't represent).
  { kind: 'twoturn', label: 'two-turn move that displaces a foe (Sky Drop)',
    moves: ['skydrop'] },
  // Taunt + Encore are MODELLED (option restriction), and a live-match Disable
  // now root-carries into the search pools. Torment/Imprison/Spite remain (no
  // live tracking to carry, no in-tree cast model).
  { kind: 'restriction', label: 'move restriction (Torment / Imprison / Spite)',
    moves: ['torment', 'imprison', 'spite'] },
  // Explosion / Self-Destruct / Misty Explosion are MODELLED (isSelfdestruct → user
  // faints). The HP-based / sacrifice-pivot ones are not.
  // SELF-FAINT moves are now fully modelled, so this rule is gone:
  //   Final Gambit  — damage = the user's CURRENT HP in the target's units; Ghost immune;
  //                   the user faints only if it connects.
  //   Memento       — the -2 Atk / -2 SpA drop through the debuff path, and the user dies.
  //   Healing Wish  — the user dies; the replacement enters at full HP, status cured,
  //                   THEN eats hazards.
  //   Lunar Dance   — no legal user in Reg M-B (checked against the format allow-list),
  //                   so there is nothing to model. Revisit on a regulation change.
  // on-KO boost (Moxie/Beast Boost), hazard clear, Weakness Policy (procWp) and
  // Booster Energy (Protosynthesis/Quark Drive via the calc's boostedStat +
  // search Spe ×1.5) are MODELLED; the rest of the reactive items are not.
  // REACTIVE ITEMS: rule removed 2026-07-25 — checked against format.champions.json and
  // NONE of them are legal in Reg M-B (Blunder Policy, Throat Spray, Room Service,
  // Snowball, Luminous Moss, Cell Battery, Absorb Bulb — nor Weakness Policy, which the
  // search models anyway and which is simply inert here). The item allow-list is small
  // and stone-heavy: berries, Life Orb, Leftovers, Focus Sash/Band, Choice SCARF (no
  // Band/Specs), type boosters, weather rocks, Light Clay, Quick Claw, Wide/Zoom Lens.
  // Warning about an item nobody can hold is noise. Re-check on a regulation change.
  // Item REMOVAL (Knock Off / Thief / Covet / Corrosive Gas) is now modelled: the
  // stripped mon loses its Life Orb recoil, its Leftovers/Black Sludge healing and its
  // berry triggers. What remains approximate is the DAMAGE scaling an item was giving
  // (Life Orb x1.3, type boosters, Expert Belt), which is baked into cells built once
  // per ply and can't be un-baked mid-tree.
  // Item SWAPPING (Trick / Switcheroo / Bestow) is still unmodelled — a swap hands the
  // other mon something, so it isn't just a removal.
  { kind: 'itemswap', label: 'item swap (Trick / Switcheroo) + post-removal damage scaling',
    moves: ['trick', 'switcheroo', 'bestow'] },
  // Confusion is a PROBABILISTIC secondary (33% self-hit) — deliberately NOT
  // auto-applied, the same policy as flinch and the 25% full-paralysis chance
  // (sim-divergences.md). Flagged as informational so the user weighs the dice.
  { kind: 'confusion', label: 'confusion (33% self-hit — informational)',
    moves: ['confuseray', 'swagger', 'flatter', 'sweetkiss', 'teeterdance'] },
];

/** Tokens for one mon, with display strings preserved for the example labels. */
interface MonTokens { species: string; moves: string[]; ability?: string; item?: string; status?: string }

function matchRule(rule: GapRule, m: MonTokens): string[] {
  const out: string[] = [];
  if (rule.moves) for (const mv of m.moves) if (rule.moves.includes(toId(mv))) out.push(`${m.species} ${mv}`);
  if (rule.abilities && m.ability && rule.abilities.includes(toId(m.ability))) out.push(`${m.species} ${m.ability}`);
  if (rule.items && m.item && rule.items.includes(toId(m.item))) out.push(`${m.species} ${m.item}`);
  if (rule.statuses && m.status && rule.statuses.includes(toId(m.status))) out.push(`${m.species} (${m.status})`);
  return out;
}

/**
 * Scan a search position for mechanics the fast search only approximates. Returns
 * one entry per gap-class present, each with the concrete in-position sources, so
 * the UI can say "⚠ approximating: sleep (Amoonguss Spore) — enable exact engine".
 * Empty when the position is fully within the model.
 */
export function unmodeledMechanics(input: SearchInput): UnmodeledMechanic[] {
  const mons: MonTokens[] = [
    ...input.mine.map((m): MonTokens => ({
      species: m.set.species, moves: m.set.moves ?? [],
      ability: m.set.ability ?? undefined, item: m.set.item ?? undefined, status: m.status,
    })),
    // Opp: revealed-only — knownMoves + known ability/item (no unseen-move warnings).
    ...input.opp.map((o): MonTokens => ({
      species: o.entry.species, moves: o.entry.knownMoves ?? [],
      ability: o.entry.ability ?? undefined, item: o.entry.item ?? undefined, status: o.entry.status,
    })),
  ];

  const hits: UnmodeledMechanic[] = [];
  for (const rule of RULES) {
    const examples = new Set<string>();
    for (const m of mons) for (const ex of matchRule(rule, m)) examples.add(ex);
    if (examples.size) hits.push({ kind: rule.kind, label: rule.label, examples: [...examples] });
  }
  return hits;
}
