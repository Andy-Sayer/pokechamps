export type StatID = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';
export type Stats = Record<StatID, number>;

export type TeamSlot = 0 | 1 | 2 | 3 | 4 | 5;
export type FieldSide = 'mine' | 'theirs';
export type FieldSlot = 0 | 1; // left/right active

export interface PokemonSet {
  species: string;
  level: number;
  item?: string;
  ability?: string;
  nature: string;
  evs: Stats;
  ivs: Stats;
  moves: string[];
  gender?: 'M' | 'F' | 'N';
  nickname?: string;
  // Tera Type for Tera-gimmick formats. Showdown's `Tera Type: Fire` line
  // populates this. Mega/none/etc. formats ignore it.
  teraType?: string;
}

// Opponent entries are partial — we only know what we've seen.
export interface OpponentEntry {
  species: string;
  level?: number;
  item?: string | null; // null = unknown, undefined = no item known
  ability?: string | null;
  knownMoves: string[];
  // Posterior set of plausible full sets after inference. Empty until first
  // observation. Ordered best-first by likelihood.
  candidates?: PokemonSet[];
  // Per-candidate likelihood (parallel to `candidates`), from the Hybrid
  // weighting solver. Lets `mostLikely` pick by score instead of the EV prior.
  candidateLikelihoods?: number[];
  // Speed bounds inferred from turn ordering. Undefined = no constraint yet.
  speedFloor?: number;
  speedCeiling?: number;
  // True when speedFloor exceeds the speed implied by Pikalytics' top spread —
  // strong signal of Choice Scarf (or another speed-boosting item/ability).
  scarfSuspected?: boolean;
  // 0-100: how unusual the non-scarf explanation would be for the inferred
  // floor. 0 = consistent with the popular spread; 100 = no nature/EV combo
  // can hit that speed without a multiplier. Soft signal — a high value
  // could still mean "max Spe + Jolly without scarf".
  scarfChance?: number;
  // True after we've observed this mon mega-evolve.
  megaUsed?: boolean;
  // Mega forme name once activated (e.g. "Charizard-Mega-Y"). Display +
  // base-stat lookups consult this override when present; `species`
  // remains the base forme so we can look up the mega-options list etc.
  megaForme?: string;
  // Charge-move tracking. When the opp commits a charge move (Solar Beam,
  // Electro Shot, Phantom Force, etc.) without dealing damage, we remember
  // the move so the matchup grid can warn "they'll fire X next turn".
  // Cleared automatically when this mon's next damaging action lands.
  charging?: { move: string; turn: number };
  // Current HP as a percent of max (0-100). Undefined = full HP.
  currentHpPercent?: number;
  // True after HP hits 0 (auto on damage or manual via state update).
  fainted?: boolean;
  // Active-slot stat boost map (cleared on switch-out). Stage values per stat,
  // clamped to [-6, +6]. Only meaningful while this entry is in an active slot.
  currentBoosts?: Partial<Record<'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'acc' | 'eva', number>>;
  // If we've observed this mon consume a held item (e.g. Sitrus, Air Balloon).
  // Displayed as a strikethrough on the inferred item.
  itemConsumed?: string;
  // Current non-volatile status. Used in damage calcs (burn halves Atk, etc.)
  // and end-of-turn ticks (burn/poison damage, toxic ramp).
  status?: 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz';
  // Toxic counter (turns of badly-poisoned). Increments each EOT for tox.
  toxCounter?: number;
  // Sleep counter (1-3 remaining turns of sleep). Decrements each EOT for
  // slp; status auto-clears when it hits 0.
  sleepCounter?: number;
  // Move-restricting volatiles (logged manually; cleared on switch-out or via
  // `cure`). Taunt blocks status moves (3 turns); Encore locks the mon into
  // one move (3 turns); Disable blocks one move (4 turns). We don't auto-count
  // turns — the user clears them. Encore/Disable feed the opp's threat pool.
  taunted?: boolean;
  encoreMove?: string;
  disabledMove?: string;
  // Countdown turns for the volatiles above (tick each EOT; clear at 0).
  tauntTurns?: number;
  encoreTurns?: number;
  disableTurns?: number;
  // True if we've observed this mon take sandstorm chip damage. Proves it
  // doesn't hold Safety Goggles and isn't Sand-immune. Used to exclude
  // Safety Goggles from the item candidate set.
  sandChipObserved?: boolean;
  // Leech Seed volatile: set when this mon was seeded; cleared on switch-out
  // (and on Rapid Spin). Tracks the SEEDER's identity so the EOT residual can
  // heal the right mon — and skip the heal if the seeder has since switched
  // out or fainted (the drain still applies to the target either way).
  leechSeeded?: { seederSide: 'mine' | 'theirs'; seederIndex: number };
  // Residual-chip volatiles (each cleared on switch-out unless noted).
  saltCured?: boolean;       // Garganacl's Salt Cure: -1/8 per EOT (-1/4 Water/Steel); persists through switch
  aquaRing?: boolean;        // +1/16 HP per EOT; persists through switch in Gen 6+
  ingrain?: boolean;         // +1/16 HP per EOT; also prevents switching
  cursed?: boolean;          // Non-Ghost Curse: -1/4 per EOT; cleared on switch-out
  partialTrap?: number;      // turns remaining of Bind/Wrap/Fire Spin etc.: -1/8 per EOT; cleared on switch-out
  nightmare?: boolean;       // while asleep: -1/4 per EOT; cleared on switch-out
  // One-turn volatile set when this mon is flinched (cleared at EOT). Informational:
  // the flinched mon simply has no action in the turn. Fake Out auto-flinches on
  // first turn out; secondary flinch moves (Iron Head etc.) are user-logged.
  flinched?: boolean;
}

export interface HazardState {
  rocks?: boolean;
  spikes?: 0 | 1 | 2 | 3;
  toxicSpikes?: 0 | 1 | 2;
  stickyWeb?: boolean;
}

export interface FieldState {
  weather?: 'Sun' | 'Rain' | 'Sand' | 'Snow' | 'Hail' | 'Harsh Sunshine' | 'Heavy Rain' | null;
  terrain?: 'Electric' | 'Grassy' | 'Misty' | 'Psychic' | null;
  // Turns remaining (countdown) for the timed conditions. Undefined = untracked
  // (count not known/seeded). Tick down each EOT; the effect clears at 0.
  weatherTurns?: number;
  trickRoomTurns?: number;
  myTailwindTurns?: number;
  theirTailwindTurns?: number;
  myReflectTurns?: number;
  myLightScreenTurns?: number;
  theirReflectTurns?: number;
  theirLightScreenTurns?: number;
  trickRoom: boolean;
  myTailwind: boolean;
  theirTailwind: boolean;
  myReflect: boolean;
  myLightScreen: boolean;
  theirReflect: boolean;
  theirLightScreen: boolean;
  myHazards?: HazardState;
  theirHazards?: HazardState;
}

export interface ActivePokemonState {
  setIndex: number; // index into the team / opponent array
  currentHpPercent: number;
  status?: 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz' | null;
  boosts: Partial<Record<StatID, number>>;
  gimmickActive: boolean;
}

export interface MoveAction {
  side: FieldSide;
  attackerSlot: FieldSlot;
  // 'move' for any attacking/status move; 'switch' for sending in a new mon
  // (the `move` field then holds the incoming species name and target is
  // implicitly the slot being switched into); 'mega' for a standalone mega
  // evolution declaration. Defaults to 'move' when absent to keep older
  // saved matches readable.
  kind?: 'move' | 'switch' | 'mega';
  // Index into myTeam (side === 'mine') or opponentTeam (side === 'theirs')
  // for the acting mon. Resolved at action time so history survives switches.
  attackerTeamIndex?: number;
  // Same, for the targeted mon when single-target.
  targetTeamIndex?: number;
  move: string;
  target: { side: FieldSide; slot: FieldSlot } | 'self' | 'allies' | 'foes';
  damageHpPercent?: number; // 0..100 of defender's max HP if known (damage dealt)
  damageRaw?: number; // absolute damage dealt if known
  // Remaining HP on the target AFTER this action — the natural unit per side.
  // Captured at parse time; finalizeTurn walks actions in order and converts
  // these to damageHpPercent (which is what the inference solver consumes).
  targetRemainingHpPercent?: number; // for opp targets
  targetRemainingHpRaw?: number;     // for my targets
  // 1-based position within the turn — used by speed inference.
  order?: number;
  // True when the attacker mega-evolved this turn (before executing the move).
  mega?: boolean;
  // True when the action used Quick Claw (or another +1-priority proc).
  // Bumps effectivePriority by 1 in speed inference so the action ends
  // up in a higher bracket and doesn't generate a misleading speed
  // signal against natural-priority same-bracket actions.
  quickClaw?: boolean;
  // True when this `kind: 'switch'` action was forced by a pivot move
  // (U-turn, Volt Switch, Parting Shot, Teleport, Flip Turn, Chilly
  // Reception, Baton Pass, Shed Tail). The switch happens within the
  // pivot move's priority bracket, NOT at +6, so speed inference must
  // skip it — otherwise we'd treat the forced switch as a free decision
  // and derive bogus speed signals from when it landed in the turn.
  pivot?: boolean;
  helpingHand?: boolean;
  critical?: boolean;
  // Set when the damage slot carried a trailing `sash`, e.g.
  // `m1 > Close Combat > o1 > 1 sash`. finalizeTurn branches on the result:
  //  - ended at a 1-HP/1% sliver → Sash PROCCED: item consumed, mon kept alive,
  //    and the hit is skipped for inference (capped damage understates the move).
  //  - survived with HP to spare → Sash did NOT proc: damage is the move's true
  //    output (inference runs), and we record the item as a held Focus Sash.
  sash?: boolean;
  notes?: string;
}

export interface Turn {
  index: number;
  actions: MoveAction[];
  // Snapshot of field after turn resolves.
  field: FieldState;
}

export interface DamageObservation {
  attackerSide: FieldSide;
  attackerSpecies: string;
  defenderSide: FieldSide;
  defenderSpecies: string;
  move: string;
  field: FieldState;
  damageHpPercent?: number;
  damageRaw?: number;
  attackerBoosts?: Partial<Record<StatID, number>>;
  defenderBoosts?: Partial<Record<StatID, number>>;
  attackerGimmickActive?: boolean;
  defenderGimmickActive?: boolean;
  helpingHand?: boolean;
  critical?: boolean;
}

export interface Match {
  id: string;
  startedAt: string;
  myTeam: PokemonSet[];
  opponentTeam: OpponentEntry[];
  bring: TeamSlot[]; // 4 slots from myTeam
  // Opp mons we've actually seen on the field. At battle start this is just
  // the 2 leads we saw at preview; grows up to 4 as opp switches or sends a
  // replacement after a faint. We never know all 4 brings up front.
  opponentBrought?: TeamSlot[];
  // Current HP per myTeam index. Undefined slots = full HP. Lives on Match
  // (not PokemonSet) because PokemonSet is static team data.
  myCurrentHp?: Record<number, number>;
  // myTeam indices that have fainted.
  myFainted?: number[];
  // Boosts on my actives, keyed by team index. Cleared on switch-out.
  myBoosts?: Record<number, Partial<Record<'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'acc' | 'eva', number>>>;
  // myTeam index → consumed item name for display markers.
  myItemConsumed?: Record<number, string>;
  // myTeam index → current status. Parallel to OpponentEntry.status.
  myStatus?: Record<number, 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz'>;
  // myTeam index → toxic counter.
  myToxCounter?: Record<number, number>;
  // myTeam index → sleep counter (1-3 remaining turns).
  mySleepCounter?: Record<number, number>;
  // myTeam indices that have mega-evolved this match. Parallel to
  // OpponentEntry.megaUsed — mega is a once-per-battle gimmick so this
  // is just a set of "has used it" indices.
  myMegaUsed?: number[];
  // myTeam index → resolved mega forme name (e.g. "Charizard-Mega-Y").
  // Set when /mega is logged. Display + base-stat lookups consult this
  // override; the underlying PokemonSet stays unchanged.
  myMegaForme?: Record<number, string>;
  // myTeam index → move-restricting volatiles (parallel to OpponentEntry).
  myTaunted?: number[];
  myEncoreMove?: Record<number, string>;
  myDisabledMove?: Record<number, string>;
  // Countdown turns for my-side volatiles (parallel to the maps above).
  myTauntTurns?: Record<number, number>;
  myEncoreTurns?: Record<number, number>;
  myDisableTurns?: Record<number, number>;
  // myTeam index → Leech Seed seeder identity (parallel to OpponentEntry.leechSeeded).
  myLeechSeeded?: Record<number, { seederSide: 'mine' | 'theirs'; seederIndex: number }>;
  // Residual-chip volatiles (my side), keyed by team index.
  mySaltCured?: Record<number, boolean>;
  myAquaRing?: Record<number, boolean>;
  myIngrain?: Record<number, boolean>;
  myCursed?: Record<number, boolean>;
  myPartialTrap?: Record<number, number>; // turns remaining
  myNightmare?: Record<number, boolean>;
  // One-turn flinch volatile (cleared at EOT). Informational — logged when user
  // observes a Fake Out or secondary flinch proc ("o1 flinch").
  myFlinched?: Record<number, boolean>;
  // myTeam index → charging-move state. Parallel to OpponentEntry.charging.
  // Set when a mine-side charge move logged with no damage; cleared when
  // the same mon's next damaging action lands.
  myCharging?: Record<number, { move: string; turn: number }>;
  // Set when the match ends (4 KOs on either side). Persists to snapshots.
  outcome?: 'victory' | 'defeat' | 'tie';
  turns: Turn[];
  field: FieldState;
  active: {
    mine: [ActivePokemonState | null, ActivePokemonState | null];
    theirs: [ActivePokemonState | null, ActivePokemonState | null];
  };
}

// Re-exported so the gimmick id union has a single source of truth.
export type { GimmickId } from './gimmicks/types.js';
import type { GimmickId } from './gimmicks/types.js';

export interface ChampionsFormat {
  level: number;
  teamSize: number;
  bringSize: number;
  gameType: 'singles' | 'doubles';
  gimmick: GimmickId;
  // How many gimmick activations each side gets per battle. Defaults to 1
  // (one Mega / Tera / Dynamax per battle). 0 disables activation entirely.
  gimmickAllowancePerSide: number;
  openTeamSheets: boolean;
  itemClause: boolean;
  speciesClause: boolean;
  legality: { allow: string[]; ban: string[] };
  items: { allow: string[]; ban: string[] };
  moves: { ban: string[] };
}

export const ZERO_EVS: Stats = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
export const MAX_IVS: Stats = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
export const NEUTRAL_FIELD: FieldState = {
  weather: null,
  terrain: null,
  trickRoom: false,
  myTailwind: false,
  theirTailwind: false,
  myReflect: false,
  myLightScreen: false,
  theirReflect: false,
  theirLightScreen: false,
};
