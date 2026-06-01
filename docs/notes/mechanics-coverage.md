# Mechanics coverage audit — "does the program account for everything?"

**Goal (user):** the program should account for *every* move, ability, item,
weather, terrain — and anything else — and actually *do* it, not approximate.
This doc is the living checklist. **Compare every entry against the ground truth:
Pokémon Showdown's sim (`@pkmn/dex` + `@smogon/calc` are derived from it),
Bulbapedia, and Serebii.** When something here says "gap", it means *our*
representation is missing it, not that the rule is unknown.

## The three layers (where "accounting for X" can happen)

A mechanic can be covered in up to three places. Most are covered in ≥1 already.

1. **Damage layer — `@smogon/calc` via `damage.ts` (`toCalcField` + gimmick
   `enrichCalcPokemon`).** This is a *mature, ~complete* per-hit calculator: type
   chart, STAB, abilities (Levitate, Flash Fire, Adaptability, Protosynthesis/
   Quark Drive, Intimidate-as-baked-boost, …), items (Choice band/specs, Life
   Orb, type gems/plates, Assault Vest, Eviolite, …), weather/terrain damage
   mults, screens, spread reduction, multi-hit, crit. **Anything that affects a
   SINGLE hit's number is almost certainly already correct here** — we bake it
   into the search's cells via `predictOffense`/`predictThreat`. *Do not
   reimplement the calc.* Source of truth = Showdown's `data/` + calc.
2. **Live battle-tracking layer — the match engine + domain modules.** Tracks the
   real game state as the user logs turns: `engine.ts`, `endOfTurn.ts`,
   `hazards.ts`, `abilities.ts`, `durations.ts`, `hpItemTriggers.ts`,
   `resistBerries.ts`, `statusBerries.ts`, `itemPermanence.ts`, `itemSignals.ts`,
   `fieldMoves.ts`, `speed.ts`, `inference.ts`, `gimmicks/*`. Very broad: entry
   hazards (Stealth Rock/Spikes/Toxic Spikes/Sticky Web), Intimidate on switch-in,
   weather/terrain abilities, status + sleep counters, berries, item
   consumption/knock-off, Leech Seed/Curse/Ingrain/Aqua Ring/Nightmare/partial-
   trap, Taunt/Encore/Disable counters, mega/tera/z/dynamax gimmick hooks.
3. **Lookahead layer — `endgameSearch.ts` (the always-on recommender).** A
   *bounded, fast* maximin that judges actions by the win/loss outcome. It bakes
   the calc's per-hit numbers into matrices once, then plays them forward. This is
   the layer where coverage is *deliberately simplified for speed*, and where the
   remaining gaps live. Phases 1–4 (this is the recent work) added the big dynamic
   mechanics here.

**So "code for everything" is already true for layers 1–2.** The scoping question
is really: *which mechanics does the LOOKAHEAD still not model, and which of those
actually change a recommendation?* Below, "✅ calc / ✅ live / ✅ search" marks the
layer(s); a **GAP** is a search-lookahead gap unless noted.

---

## Coverage matrix

### Damage modifiers on a single hit  — ✅ calc (complete), baked into search cells
Type effectiveness, STAB (incl. Adaptability/Tera), abilities that scale damage
(Huge Power, Technician, Sheer Force, Tinted Lens, Filter/Solid Rock, Multiscale,
Protosynthesis/Quark Drive booster, Neuroforce, Tough Claws, …), items (Choice ×,
Life Orb ×1.3, Expert Belt, type plates/gems, Muscle/Wise glasses, Eviolite,
Assault Vest, Metronome, …), burn-halves-physical, screens, weather/terrain mults,
spread 0.75, multi-hit ×hits, crit. **No action needed** — these are exact via the
calc. *Audit task:* periodically diff `@smogon/calc` version against Showdown.

### Moves — by behaviour class
| Class | Examples | calc | live | search | Notes / gap |
|---|---|---|---|---|---|
| Standard damaging | most | ✅ | ✅ | ✅ | baked cell |
| Spread | Rock Slide, Heat Wave, EQ | ✅ | ✅ | ✅ | SPREAD sentinel |
| Priority | Aqua Jet, Sucker Punch | ✅ | ✅ | ✅ | bracket in turn order; Psychic-Terrain block ✅ |
| Protect family | Protect/Detect/King's Shield/Spiky Shield/… | – | ✅ | ✅ | consecutive-use fail modelled |
| Switch / pivot | U-turn, Volt Switch, Flip Turn, Parting Shot | ✅(dmg) | ✅ | **PARTIAL** | voluntary switch ✅ (root-ply); **pivot = forced mid-turn switch NOT modelled** |
| Field — order | Tailwind, Trick Room | – | ✅ | ✅ | + durations/stall-out |
| Field — screens | Reflect/Light Screen/Aurora Veil | ✅ | ✅ | ✅ | + durations/stall-out |
| Field — weather | Sunny Day/Rain Dance/Sandstorm/Snowscape | ✅ | ✅ | ✅ | + durations/stall-out |
| Field — terrain | Electric/Grassy/Misty/Psychic Terrain | ✅ | ✅ | ✅ | + durations |
| Setup (self-boost) | Swords Dance/Calm Mind/Dragon Dance/Shell Smash/… | – | ✅ | ✅ | `SETUP_MOVES` table |
| Self stat-drop | Draco Meteor/Overheat/Leaf Storm/Make It Rain/Close Combat/Superpower/V-create | ✅(dmg) | ✅ | ✅ | `Cell.selfDrop` from `move.self.boosts`; applied to the user's boosts (Contrary inverts). **Evidence-ranked #1 gap — closed first via the sim diff-harness** |
| Foe stat-drop (damaging 2ndary) | Icy Wind/Electroweb/Bulldoze −Spe, Snarl/Struggle Bug −SpA, Breaking Swipe −Atk, Low Sweep | ✅(dmg) | ✅ | ✅ | `Cell.foeDrop` from 100%-chance `secondary.boosts`; applied to the target's boosts (Clear Body/Clear Amulet immune, Contrary inverts). Probabilistic 10–30% drops left out by policy (flinch rule) |
| Foe stat-drop (dedicated move) | Charm, Scary Face, Eerie Impulse, Parting Shot | – | ✅ | **GAP** | 0-damage debuff moves — search has no `SET_DEBUFF` action yet (flagged by `unmodeled.ts`) |
| Status moves | Will-O-Wisp/Thunder Wave/Toxic/Glare/Poison Powder | – | ✅ | ✅ | SET_STATUS; **sleep/freeze NOT** |
| Sleep-inducing | Spore/Sleep Powder/Hypnosis/Yawn | – | ✅ | **GAP** | sleep = can't-act + wake counter; deferred |
| Leech / drain HP | Leech Seed; Giga Drain (heal) | ✅(dmg) | ✅ | ✅ | Leech Seed ✅; drain-move self-heal added (`Cell.drain`) |
| Recovery | Recover/Roost/Slack Off/Synthesis/Moonlight | – | ✅ | **GAP** | a huge stall lever — search can't heal on demand |
| Wish / delayed heal | Wish | – | ✅ | **GAP** | EOT heal to the slot |
| Delayed damage | Future Sight, Doom Desire | ✅(dmg) | ? | **GAP** | hits 2 turns later |
| Two-turn / charge | Solar Beam, Fly, Phantom Force, Meteor Beam, Electro Shot | ✅(dmg) | ✅(charge flag) | **GAP** | search treats as 1-turn full-power |
| Recharge | Hyper Beam, Giga Impact | ✅ | ? | **GAP** | must recharge next turn |
| Locked multi-turn | Outrage, Petal Dance, Thrash | ✅ | ? | **GAP** | lock + confusion after |
| Multi-hit | Bullet Seed, Rock Blast, Population Bomb | ✅ | ✅ | ✅ | ×hits; breaks Sash ✅ |
| Recoil | Brave Bird/Flare Blitz/Wave Crash 33%, Head Smash 50%, Take Down 25% | ✅(dmg) | ✅ | ✅ | `Cell.recoil` = recoil×damage-dealt to the attacker; Rock Head / Magic Guard negate. Found by the sim diff-harness (all residual faints were unmodelled recoil). Life Orb recoil (item) still a search GAP |
| OHKO | Fissure, Guillotine, Sheer Cold | ✅ | ✅ | n/a | rare in format; accuracy-gated |
| Fixed / level damage | Seismic Toss, Night Shade, Super Fang, Endeavor | ✅ | ✅ | ✅ | calc gives the % |
| Redirection | Follow Me, Rage Powder | – | ? | **GAP** | pulls single-target hits to the user (doubles-critical) |
| Wide/Quick Guard | — | – | ✅(noted) | **GAP** | team-protect; not modelled |
| Fake Out | — | ✅(dmg) | ✅ | **PARTIAL** | flinch is informational only; first-turn-only not enforced in search |
| Counter / mirror | Counter, Mirror Coat, Metal Burst | ✅ | ? | **GAP** | reflects damage |
| Item manipulation | Knock Off, Trick, Switcheroo, Thief, Covet | ✅(KO dmg) | ✅ | **PARTIAL** | live tracks item removal/swap; search uses static items |
| Hazard SET | Stealth Rock/Spikes/Toxic Spikes/Sticky Web (dedicated) + Stone Axe→SR / Ceaseless Edge→Spikes (secondary) | – | ✅ | ✅ | search lays hazards on the foe's side (`SET_HAZARD` action + `Cell.setsHazard`); dynamic `State.my/oppHazards`; refill-ins eat the chip. Freshly-set hazards are correctly dodgeable in a short horizon (opp pre-switches) → payoff is the FORCED-refill case |
| Hazard CLEAR | Defog/Rapid Spin/Mortal Spin/Court Change/Tidy Up | – | ✅ | **GAP** | live clears via `applyHazardClear`; search doesn't model removal yet |
| Encore/Taunt/Disable/Torment | — | – | ✅(counters) | **GAP** | restrict opp options; not in search |
| Substitute | — | ✅(partial) | ✅(limited) | **PARTIAL** | sub-HP tracking is limited (see `project_sub_hp_tracking`) |
| Self-destruct | Explosion, Final Gambit, Misty/Healing Wish | ✅ | ? | **GAP** | user faints; special semantics |
| Weather/terrain-typed | Weather Ball, Terrain Pulse, Rising Voltage, Expanding Force | ✅ | ✅ | ✅ | calc handles the type/BP change |
| Charge-cancel synergy | Solar Beam in sun, Electro Shot in rain | ✅ | ✅ | **GAP** | (tied to two-turn gap) |

### Abilities — by behaviour class
| Class | Examples | Where covered | Gap |
|---|---|---|---|
| Damage-scaling (own hit) | Huge Power, Technician, Sheer Force, Protosynthesis, Adaptability… | ✅ calc (baked) | — |
| Damage-taken | Multiscale, Filter, Thick Fat, Fluffy, Heatproof, Ice Scales | ✅ calc | — |
| Type immunity / absorb | Levitate, Flash Fire, Water Absorb, Volt Absorb, Storm Drain, Lightning Rod, Sap Sipper, Dry Skin | ✅ calc; ✅ live | search: absorb-heal not added; redirection (Storm Drain/Lightning Rod) **GAP** |
| Speed in weather | Chlorophyll, Swift Swim, Sand Rush, Slush Rush | ✅ search | — (done Phase 4) |
| EOT stat gain | Speed Boost | ✅ search | — |
| On-KO boost | Moxie/Beast Boost/Grim Neigh/Chilling Neigh/As One | ✅ search | `Tables.my/oppOnKo`; +stage × KOs scored (Beast Boost = highest stat); fuels snowball lines |
| Stat-drop reaction | Defiant / Competitive (+2 on a foe-caused drop) | ✅ search | triggers on Intimidate + foe stat-drops; Contrary inversion handled |
| Switch-in: Intimidate | — | ✅ live | ✅ search (a switch-in drops the opposing actives' Atk −1; honors Clear Body/Clear Amulet/… immunity) |
| Switch-in: weather/terrain | Drought/Drizzle/Sand Stream/Snow Warning; Electric/Grassy/Misty/Psychic Surge | ✅ live; ✅ search | done Phase 4 |
| Switch-in: Regenerator | — | ✅ live | ✅ search (heals 1/3 on switch-out — makes pivoting heal) |
| Survive-a-hit | Sturdy, (Focus Sash item) | ✅ search | — |
| Contact punish | Rough Skin, Iron Barbs, Rocky Helmet (item) | ✅ live | ✅ search (contact hit chips the attacker; Magic Guard negates) |
| Status/effect immunity | Limber, Water Veil, Immunity, Magic Guard, Overcoat, Magic Bounce | ✅ live; ✅ search (status-land + Magic Guard residual) | Magic Bounce reflecting status/hazards **GAP** |
| Item-based | Unburden, Magician, Pickpocket, Klutz | ✅ live (partial) | search **GAP** |
| Form/disguise | Disguise, Ice Face, Multiscale, Zero-to-Hero | ✅ live (partial) | search **GAP** (free hit absorb) |
| Misc priority | Prankster, Gale Wings, Triage, Stall, Quick Draw | ✅ search (priority brackets + plausible-ability) | — |

### Items — by behaviour class
| Class | Examples | Where | Gap |
|---|---|---|---|
| Damage-scaling | Choice Band/Specs, Life Orb, Expert Belt, plates/gems, Muscle Band | ✅ calc | Life Orb recoil **search GAP** |
| Defensive | Assault Vest, Eviolite, Rocky Helmet, type-resist berries | ✅ calc; ✅ live (resistBerries) | Rocky Helmet chip in search **GAP** |
| Survive | Focus Sash, (Sturdy) | ✅ search | — |
| HP-trigger heal | Sitrus, Aguav/figy/… pinch berries | ✅ live (hpItemTriggers) | **search GAP** (heal at 50%/25% — big for stall lines) |
| Status berries | Lum, Cheri, Pecha, … | ✅ live (statusBerries) | **search GAP** (cure on status) |
| Leftovers / Black Sludge | — | ✅ live; ✅ search (Leftovers heal) | Black Sludge (poison-type heal / else hurt) **PARTIAL** in search |
| Choice lock | Choice items | ✅ calc(dmg); ✅ live | **search GAP** (locked into one move after first use) |
| Booster Energy | Protosynthesis/Quark Drive proc | ✅ calc(if active) | proc-on-switch **search GAP** |
| Weakness Policy / berries that boost | — | ✅ live | **search GAP** |
| Eject Button / Eject Pack / Red Card | — | ✅ live (partial) | forced switch **search GAP** |
| Mega stones | — | ✅ all | done (mega gimmick) |
| Utility | Mental Herb, White Herb, Covert Cloak, Clear Amulet, Safety Goggles | ✅ live (partial) | search **GAP** (mostly minor) |

### Weather / Terrain / Field
| Mechanic | calc | live | search |
|---|---|---|---|
| Weather damage (Fire/Water), defensive (Sand SpD/Snow Def) | ✅ | ✅ | ✅ |
| Weather speed abilities | – | ✅ | ✅ |
| Weather chip (Sand) + durations + setting | – | ✅ | ✅ |
| Terrain type ×1.3, Grassy-EQ/Misty-Dragon, durations, setting | ✅ | ✅ | ✅ |
| Psychic-Terrain priority block | – | ? | ✅ |
| Grassy heal residual | – | ✅ | **GAP** (search) |
| Trick Room / Tailwind / Gravity / Wonder Room / Magic Room | ✅(calc has TR/Gravity) | ✅(TR/TW) | TR/TW ✅; **Gravity/Wonder/Magic Room GAP** |
| Entry hazards (chip + speed drop, on switch-in AND refill) | – | ✅ | ✅ (dynamic `State.my/oppHazards`; chip on deliberate switch + post-faint refill; set via `SET_HAZARD` + Stone Axe/Ceaseless Edge secondary) |

### Status / volatiles
| Status | calc effect | live | search |
|---|---|---|---|
| Burn (½ phys, chip) | ✅ | ✅ | ✅ (scale + residual + infliction) |
| Paralysis (½ Spe, 25% fail) | ✅(Spe) | ✅ | ✅ Spe; **25% full-para not modelled** (like flinch) |
| Poison / Toxic (chip) | – | ✅ | ✅ (residual + infliction + escalation) |
| Sleep (can't act, wake counter) | – | ✅ (sleepCounter) | **GAP** |
| Freeze (can't act, thaw) | – | ✅ | **GAP** (rare) |
| Confusion (33% self-hit) | – | ✅ | **GAP** (like flinch — informational candidate) |
| Flinch | – | ✅ | ✅ informational (never auto-applied — by design) |
| Leech Seed / Curse / Nightmare / Ingrain / Aqua Ring / partial-trap | ✅(some) | ✅ | Leech Seed ✅; **rest GAP in search** |

### Gimmicks
Mega ✅ (full: search + calc + live). Tera/Z-Move/Dynamax: gimmick interface +
`none` fallback exist; **this format is Mega only**, so Tera/Z/Dmax are out of
scope for Reg M-A (revisit per regulation via `format.champions.json`).

---

## Self-flagging: the runtime gap detector

`packages/core/src/domain/unmodeled.ts` is the **runtime mirror of this audit**.
`unmodeledMechanics(input)` scans the live position's moves/abilities/items/status
against the GAP/PARTIAL classes below and returns labels, surfaced on
`SearchResult.unmodeled` and shown in `BattleScreen` as a yellow
`⚠ approximating: …` line. This delivers step 1 of the
`project_sim_engine_strategy` plan (tell the user when a verdict has blind spots /
when to opt into the exact `@pkmn/sim` engine). **When a gap moves GAP→✅ in the
search, delete its rule from `unmodeled.ts` in the same change** so the warning
stays honest. Opp scan is revealed-only (opp-conservatism).

## Engine strategy (the bigger arc)

See `project_sim_engine_strategy` memory + the `/sync-showdown` skill. In short:
keep this fast search as the always-on breadth layer; add `@pkmn/sim` as an opt-in
EXACT oracle for the shown line; port real `sim/` logic to close the gaps below;
GPU-ify later. The gaps here are still the work list — but now grounded in
Showdown's source, not memory of the rules.

## Prioritized gap backlog (search lookahead)

Ordered by *how often it changes a recommendation* in this doubles format. Each is
a self-contained extension following the patterns already built (at-use scaling,
EOT residual, root-ply action, switch-in hook).

**P1 — high impact, common, tractable**
1. ~~**Recovery moves**~~ ✅ SHIPPED — `RECOVER` self-action, EOT heal (50% flat;
   Synthesis/Moonlight/Morning Sun sun-scaled, Shore Up sand-scaled); offered when
   below full HP. Action class `recover`.
2. ~~**HP-trigger items + status berries**~~ ✅ SHIPPED — reuses
   `hpItemTriggerFor` (Sitrus 25% @ ≤50%, pinch berries +1 stat @ ≤25%, falling
   edge) + `statusBerryFor` (Lum/Cheri/… cure on infliction). One-time per mon
   (`State.my/oppBerryUsed`); known items only for the opp.
3. ~~**Entry hazards (consume + SET)**~~ ✅ SHIPPED — reuses `applyHazardsToSwitchIn`;
   the per-mon `HazardEffect` is now computed DYNAMICALLY from `State.my/oppHazards`
   (HP chip + Toxic Spikes status + Sticky Web −1 Spe, before the berry check) and
   applied on a deliberate switch-in (incl. Baton Pass, START-of-turn hazards) AND
   on a post-faint refill replacement (post-set hazards). Hazards are now SET in the
   search too: the `SET_HAZARD` action casts the dedicated moves (Stealth Rock /
   Spikes / Toxic Spikes / Sticky Web) and `Cell.setsHazard` lays the secondary from
   Stone Axe (→SR) / Ceaseless Edge (→Spikes) on the defender's side. NOTE: a hazard
   set this turn is correctly dodgeable in a short horizon (a rational opp
   pre-switches its bench mon in before the rock lands), so the realized payoff is
   the forced-refill case, not a single-turn swing. Hazard CLEAR (Defog/Rapid Spin/…)
   is still a search GAP.
4. ~~**Intimidate on switch-in**~~ ✅ SHIPPED — a switch-in with Intimidate drops
   the opposing actives' Atk −1 (into the dynamic boosts), honoring Clear Body /
   Clear Amulet / Hyper Cutter / … immunity. Defiant/Competitive/Guard Dog
   REACTIONS deferred.
5. **Choice lock** — **RE-TIERED to P3.** Its real value (a mon stuck in a move a
   switch-in walls) needs PER-MOVE damage cells; the search collapses to
   best-move-per-foe, and real Choice mons run 4 attacks so the "attacks-only"
   restriction is nearly a no-op. Revisit if/when cells gain per-move data.

**P2 — impactful but rarer / more work**
6. **Foe stat-drops** (Snarl/Icy Wind/Charm/Electroweb) — symmetric to setup but
   onto the *opponent's* dynamic boosts.
7. ~~**Drain self-heal**~~ ✅ SHIPPED — Giga Drain/Drain Punch/… heal the attacker
   `drain × damage-dealt` (Draining Kiss 0.75); single-target. `Cell.drain`.
8. ~~**Regenerator**~~ ✅ SHIPPED — heals 1/3 max HP when a mon switches out
   (makes pivoting heal); `Tables.my/oppRegen`.
9. **Two-turn/charge + recharge** (Solar Beam, Fly, Hyper Beam) — model the lost
   turn / vulnerability window.
10. ~~**Rocky Helmet / Rough Skin / Iron Barbs**~~ ✅ SHIPPED — a contact hit into a
    holder chips the attacker (Rocky Helmet 1/6, Rough Skin/Iron Barbs 1/8; Magic
    Guard negates). `Cell.contact` + `Tables.*ContactChip`.
11. **Sleep** (Spore/Hypnosis/Yawn) — can't-act + wake counter (the big remaining
    status; deferred because it's a control mechanic, not a scale).
12. **Redirection** (Follow Me/Rage Powder, Storm Drain/Lightning Rod) + **Wide/
    Quick Guard** — doubles-defining but complex (slot/targeting model).

**P3 — long tail / niche**
Wish, Future Sight, Counter/Mirror Coat, Substitute (improve), Encore/Taunt/
Disable (restrict opp options), Eject Button/Red Card forced switch, Weakness
Policy, Booster Energy proc, Gravity/Wonder/Magic Room, Magic Bounce, Disguise/
Ice Face free-hit, Black Sludge, confusion/freeze, OHKO moves, self-destruct.

**P4 — infrastructure (separate track)**
**GPU parallel mode** (original Phase 5) — batch the per-spread forward-damage
grid as a kernel. Not a mechanic; gated on a perf-tidy of the search core. Revisit
only after the P1/P2 mechanic gaps are closed and CPU perf is measured.

---

## Working method (per the user)

- **Never reimplement the calc.** For any "does X damage right" question, the
  answer is `@smogon/calc` / `@pkmn/dex` (= Showdown's data). Keep the dep current.
- **For multi-turn/dynamic behaviour**, extend the search with the established
  patterns; verify the *rule* against Bulbapedia/Serebii and the *numbers* against
  Showdown's calc + the in-app smoketest.
- **Each gap = one focused, independently-tested diff** with a "no-regression"
  property (the effect is inert when not present), like every Phase-4 effect.
- Keep this matrix updated as the single source of truth for "what's left".
