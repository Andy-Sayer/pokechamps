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
  // Spore/Sleep Powder/Hypnosis sleep is now MODELLED (status 'slp' = can't-act +
  // wake counter); only delayed Yawn remains unmodelled.
  { kind: 'yawn', label: 'Yawn (delayed sleep)', moves: ['yawn'] },
  { kind: 'freeze', label: 'freeze (skips turns)', statuses: ['frz'] },
  // Follow Me / Rage Powder redirection is now MODELLED; ability redirection
  // (Storm Drain/Lightning Rod) and Ally Switch are not.
  { kind: 'redirection', label: 'ability redirection / Ally Switch',
    moves: ['allyswitch', 'spotlight'],
    abilities: ['stormdrain', 'lightningrod'] },
  { kind: 'teamprotect', label: 'Wide / Quick Guard',
    moves: ['wideguard', 'quickguard', 'matblock', 'craftyshield'] },
  // NOTE: the 100%-chance DAMAGING foe-drops (Icy Wind/Snarl/Electroweb/Struggle
  // Bug/Breaking Swipe/Low Sweep/Bulldoze/Lunge/Acid Spray/Mystical Fire/…) are now
  // MODELLED (Cell.foeDrop). Only the dedicated 0-damage stat-lowering moves remain
  // a gap — the search has no SET_DEBUFF action for them yet.
  { kind: 'foedebuff', label: 'stat-lowering move (Charm / Scary Face / Eerie Impulse)',
    moves: ['charm', 'featherdance', 'eerieimpulse', 'scaryface', 'cottonspore', 'stringshot', 'tickle',
      'growl', 'leer', 'screech', 'metalsound', 'faketears', 'confide', 'playnice', 'nobleroar',
      'tearfullook', 'sandattack', 'babydolleyes', 'venomdrench'] },
  { kind: 'twoturn', label: 'two-turn / charge move',
    moves: ['solarbeam', 'solarblade', 'fly', 'dig', 'dive', 'bounce', 'phantomforce', 'shadowforce',
      'skyattack', 'meteorbeam', 'electroshot', 'geomancy', 'skullbash', 'razorwind', 'freezeshock', 'iceburn'] },
  { kind: 'recharge', label: 'recharge move',
    moves: ['hyperbeam', 'gigaimpact', 'roaroftime', 'prismaticlaser', 'eternabeam', 'frenzyplant', 'hydrocannon', 'blastburn'] },
  { kind: 'locked', label: 'locked multi-turn (Outrage)',
    moves: ['outrage', 'petaldance', 'thrash', 'ragingfury'] },
  { kind: 'delayeddamage', label: 'delayed damage (Future Sight)',
    moves: ['futuresight', 'doomdesire'] },
  { kind: 'wish', label: 'delayed heal (Wish)', moves: ['wish'] },
  { kind: 'damagereflect', label: 'damage reflect (Counter / Mirror Coat)',
    moves: ['counter', 'mirrorcoat', 'metalburst'] },
  { kind: 'restriction', label: 'move restriction (Taunt / Encore / Disable)',
    moves: ['taunt', 'encore', 'disable', 'torment', 'imprison', 'spite'] },
  { kind: 'substitute', label: 'Substitute', moves: ['substitute'] },
  { kind: 'selffaint', label: 'self-faint move (Explosion / Final Gambit)',
    moves: ['explosion', 'selfdestruct', 'mistyexplosion', 'finalgambit', 'healingwish', 'lunardance', 'memento'] },
  { kind: 'onkoboost', label: 'on-KO boost (Moxie / Beast Boost)',
    abilities: ['moxie', 'beastboost', 'grimneigh', 'chillingneigh', 'asonespectrier', 'asoneglastrier'] },
  { kind: 'hazardclear', label: 'hazard clear (Defog / Rapid Spin)',
    moves: ['defog', 'rapidspin', 'mortalspin', 'courtchange', 'tidyup'] },
  { kind: 'freehit', label: 'free-hit absorb (Disguise / Ice Face)',
    abilities: ['disguise', 'iceface'] },
  { kind: 'magicbounce', label: 'status/hazard reflect (Magic Bounce)',
    abilities: ['magicbounce'] },
  { kind: 'forcedswitchitem', label: 'forced-switch item (Eject Button / Red Card)',
    items: ['ejectbutton', 'ejectpack', 'redcard'] },
  { kind: 'reactiveitem', label: 'reactive item (Weakness Policy / Booster Energy)',
    items: ['weaknesspolicy', 'blunderpolicy', 'throatspray', 'boosterenergy', 'roomservice', 'snowball', 'luminousmoss', 'cellbattery', 'absorbbulb'] },
  { kind: 'itemswap', label: 'item swap/loss (Trick / Knock Off)',
    moves: ['trick', 'switcheroo', 'bestow', 'knockoff', 'thief', 'covet', 'corrosivegas'] },
  { kind: 'room', label: 'room effect (Gravity / Wonder Room)',
    moves: ['gravity', 'wonderroom', 'magicroom'] },
  { kind: 'confusion', label: 'confusion (33% self-hit)',
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
