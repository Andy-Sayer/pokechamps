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
| Stat-drop on foe | Charm, Snarl, Icy Wind, Electroweb | ✅(dmg) | ✅ | **GAP** | search models self-boosts, not *foe* stat drops applied mid-search |
| Status moves | Will-O-Wisp/Thunder Wave/Toxic/Glare/Poison Powder | – | ✅ | ✅ | SET_STATUS; **sleep/freeze NOT** |
| Sleep-inducing | Spore/Sleep Powder/Hypnosis/Yawn | – | ✅ | **GAP** | sleep = can't-act + wake counter; deferred |
| Leech / drain HP | Leech Seed; Giga Drain (heal) | ✅(dmg) | ✅ | **PARTIAL** | Leech Seed ✅; **drain-move self-heal not added to HP in search** |
| Recovery | Recover/Roost/Slack Off/Synthesis/Moonlight | – | ✅ | **GAP** | a huge stall lever — search can't heal on demand |
| Wish / delayed heal | Wish | – | ✅ | **GAP** | EOT heal to the slot |
| Delayed damage | Future Sight, Doom Desire | ✅(dmg) | ? | **GAP** | hits 2 turns later |
| Two-turn / charge | Solar Beam, Fly, Phantom Force, Meteor Beam, Electro Shot | ✅(dmg) | ✅(charge flag) | **GAP** | search treats as 1-turn full-power |
| Recharge | Hyper Beam, Giga Impact | ✅ | ? | **GAP** | must recharge next turn |
| Locked multi-turn | Outrage, Petal Dance, Thrash | ✅ | ? | **GAP** | lock + confusion after |
| Multi-hit | Bullet Seed, Rock Blast, Population Bomb | ✅ | ✅ | ✅ | ×hits; breaks Sash ✅ |
| OHKO | Fissure, Guillotine, Sheer Cold | ✅ | ✅ | n/a | rare in format; accuracy-gated |
| Fixed / level damage | Seismic Toss, Night Shade, Super Fang, Endeavor | ✅ | ✅ | ✅ | calc gives the % |
| Redirection | Follow Me, Rage Powder | – | ? | **GAP** | pulls single-target hits to the user (doubles-critical) |
| Wide/Quick Guard | — | – | ✅(noted) | **GAP** | team-protect; not modelled |
| Fake Out | — | ✅(dmg) | ✅ | **PARTIAL** | flinch is informational only; first-turn-only not enforced in search |
| Counter / mirror | Counter, Mirror Coat, Metal Burst | ✅ | ? | **GAP** | reflects damage |
| Item manipulation | Knock Off, Trick, Switcheroo, Thief, Covet | ✅(KO dmg) | ✅ | **PARTIAL** | live tracks item removal/swap; search uses static items |
| Hazard set/clear | Stealth Rock/Spikes/Toxic Spikes/Sticky Web; Defog/Rapid Spin/Court Change | – | ✅ | **GAP** | live applies switch-in chip; search ignores hazards entirely |
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
| EOT stat gain | Speed Boost | ✅ search | Moxie/Beast Boost/Grim Neigh (on-KO boost) **GAP** |
| Switch-in: Intimidate | — | ✅ live | **search GAP** (an opp switching in an Intimidate mon should drop my Atk for the lookahead) |
| Switch-in: weather/terrain | Drought/Drizzle/Sand Stream/Snow Warning; Electric/Grassy/Misty/Psychic Surge | ✅ live; ✅ search | done Phase 4 |
| Switch-in: Regenerator | — | ✅ live | **search GAP** (heals 1/3 on switch-out — affects switch value) |
| Survive-a-hit | Sturdy, (Focus Sash item) | ✅ search | — |
| Contact punish | Rough Skin, Iron Barbs, Rocky Helmet (item) | ✅ live | **search GAP** (chip the attacker) |
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
| Entry hazards (chip + speed drop) | – | ✅ | **GAP** (search) |

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
3. ~~**Entry hazards**~~ ✅ SHIPPED — reuses `applyHazardsToSwitchIn`; precomputed
   per-mon `HazardEffect` applied on any switch-in (incl. Baton Pass): HP chip +
   Toxic Spikes status + Sticky Web −1 Spe, before the berry check. Makes switch
   evaluation honest.
4. **Intimidate on switch-in** — when a switch-in (mine or opp) has Intimidate,
   apply −1 Atk to the foes' dynamic boosts (we already have dynamic boosts).
5. **Choice lock** — after a Choice mon attacks, restrict it to that move next
   plies. Reuses `itemSignals.ts`/inference's choice detection.

**P2 — impactful but rarer / more work**
6. **Foe stat-drops** (Snarl/Icy Wind/Charm/Electroweb) — symmetric to setup but
   onto the *opponent's* dynamic boosts.
7. **Drain self-heal** (Giga Drain/Drain Punch/Horn Leech) — add 50% of dealt
   damage back to the attacker.
8. **Regenerator** — +1/3 HP on switch-out (raises switch value).
9. **Two-turn/charge + recharge** (Solar Beam, Fly, Hyper Beam) — model the lost
   turn / vulnerability window.
10. **Rocky Helmet / Rough Skin / Iron Barbs** — contact chip on the attacker.
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
