# Battle input syntax

The BattleScreen action parser (`packages/core/src/domain/turnparser.ts`) accepts three shape families. Update this doc whenever the parser grammar changes.

## Action lines (logged into the turn, applied on `/next`)

```
m1 > Close Combat > o1 > 33                ← opp now at 33% remaining
o1 > Sucker Punch > m1 > 145               ← my mon now at 145 raw HP
m1 > Astral Barrage > o2 > 80 raw          ← explicit raw damage dealt
m1 > Protect > self                        ← status / no-damage move
m1+mega > Flamethrower > o1 > 50           ← mega-evolve this turn
m1+crit > Close Combat > o1 > 0            ← critical hit
m1+quick > Sucker Punch > o1 > 40          ← Quick Claw proc (priority bracket bump, no speed signal)
m1+mega+crit > Flamethrower > o1 > 0       ← stacked modifiers
m1 > Heat Wave > spread > o1:40, o2:35     ← spread → one MoveAction per target
m1 > Beat Up > o1 > 99,98,97,96,90(crit)   ← multi-hit: comma = remaining HP per hit; (crit) per hit
m1 > Bullet Seed > o1 > 75,20,sitrus 50,30 ← multi-hit + mid-sequence item: `sitrus 50`/`sash [N]` fires between hits, is spent, and the next hit deltas off the healed HP (items: sitrus/figy/wiki/mago/aguav/iapapa/sash)
o1 > Brave Bird > m1 > 45 / 89             ← recoil: `/ <attackerHP>` = the attacker's HP after (o1 opp → 89%)
m1 > Flare Blitz > o1 > 50 / 120           ← my recoil → my m1 at 120 (attacker unit follows its own side: raw for mine)
m1 > Liquidation > o1 > 50 / 84 helmet     ← attacker chip is Rocky Helmet (1/6), not recoil: `helmet`/`orb`/`barbs`
m1 > Giga Drain > o1 > 60 / 132            ← drain: the heal lands on the attacker; `/ <attackerHP>`
m1 > Close Combat > o1 > 1 sash            ← Focus Sash: survives at sliver, item consumed, hit skipped for inference
m1 > Close Combat > o1 > 50 sash           ← survived w/ HP to spare → Sash didn't proc: full dmg infers + item learned (held)
m1 > Scald > o1 > 45 brn                    ← TARGET status this hit (status word trails the HP): brn/par/psn/tox/slp/frz
m1 > Will-O-Wisp > o1 > brn                 ← pure status move, no damage → just the status word
m1 > Flare Blitz > o1 > 45 / 80 brn         ← ATTACKER status in the `/` self-clause (e.g. Flame Body on contact)
m1 > Flare Blitz > o1 > 45 / brn            ← attacker status with no self-HP change → `/ brn`
m1 > Crunch > o1 > 50 -1 def                ← a CHANCE stat drop that LANDED (probabilistic 2ndary, not auto-applied); multi OK: -1 atk -1 spa
m1 > Charm > o1 > -2 atk                    ← dedicated debuff, no damage. Both route through the foe-drop path → auto Defiant/Competitive + Clear Body/Contrary/Sub
m1 > switch > Garchomp                     ← switch by species name
m1 > switch > my4                          ← switch by team-index ref
o2 > switch > op3                          ← opp switch
m1 mega                                    ← standalone mega declaration (separate action, +5 bracket)
m1 mega y                                  ← mega variant disambiguator (Charizard X/Y, Lucario, etc.)
```

**Attacker self-HP (`/ <attackerHP> [source]`).** A trailing `/ <hp>` after the target's damage slot records the **attacker's own HP after the move** — its bar's unit (raw for mine, % for opp). The engine knows which moves recoil/drain and that those hit the attacker, so a bare `/ <hp>` is attributed to the move's recoil/drain. The **only** thing that needs a word is a contact-item chip — `helmet` (1/6), `orb` (1/10), `barbs`/`rough` (1/8) — because the opponent's item is unknown; the engine peels that fixed fraction off before reading the recoil. Recoil and drain are `frac × damage-dealt`, which lives on the *other* mon's HP scale, so the reading **solves the opponent's max HP defense-independently** (`inference.ts` `recoilDrainHpEvs` → pins `OpponentEntry.hpEvLock` → the HP EV is fixed for all later inference). Works both directions (opp recoils into me / I recoil into them) and abstains when the attacker fainted or a drain overhealed. Contact-item chips (Helmet/Orb/Barbs) carry no HP-stat info — they're flat fractions of the attacker's own bar — so they're only used to keep the chip out of the defensive solve.

**Status on a hit (`… > <hp> <status>` / `… / <selfHP> <status>`).** A non-volatile status (`brn` `par` `psn` `tox` `slp` `frz`, plus spellings like `burn`/`paralyzed`/`toxic`) can be tagged onto the hit that caused it. A status word **after the target's HP** is the **target's** status — a damaging move's secondary (`o1 > Scald > o1 > 45 brn`) or a pure status move with no damage (`o1 > Will-O-Wisp > o1 > brn`). A status word **inside the `/` self-clause** is the **attacker's** own status — e.g. burned by the foe's Flame Body on contact (`m1 > Flare Blitz > o1 > 45 / 80 brn`), or `/ brn` with no self-HP change. These are observed facts, so they apply even where the auto-apply can't infer them (probabilistic secondaries, contact abilities); they route through the same status-berry interception (Lum/Rawst…) as auto-applied status and seed the tox/sleep counters. Status-**category** moves (Thunder Wave, Spore, Toxic) still auto-apply their status without a tag.

Pivot moves (U-turn / Volt Switch / Flip Turn / Parting Shot / Teleport / Chilly Reception / Baton Pass / Shed Tail) are auto-detected via the dex `selfSwitch` field. After the pivot move log the switch as a normal next action — `finalizeTurn` tags it `pivot: true` so speed inference skips it (the switch happened inside the pivot move's bracket, not the natural +6 switch bracket).

First-turn-only moves (Fake Out / First Impression / Mat Block) are auto-gated: once a mon has acted since it last entered the field, those moves are dropped from its offense/threat predictions (switching out and back resets it — Bulbapedia rule). No logging needed; derived from turn history (`itemSignals.firstTurnOut`).

Field-clearing moves are auto-detected by name (`packages/core/src/domain/hazards.ts` → `hazardClearEffect`). Just log the move normally — `finalizeTurn` mutates the field so you don't toggle each hazard off by hand:
- **Rapid Spin** / **Mortal Spin** — clear the user's own-side hazards (Rapid Spin also +1 user Speed).
- **Defog** — clear hazards on **both** sides; clear screens on the **opponent's** side only (the user keeps their own screens — Bulbapedia).
- **Court Change** — swap all side conditions (hazards / screens / Tailwind) between sides.
- **Tidy Up** — clear hazards on both sides (+1 user Atk & Speed).

Field-**setting** moves are likewise auto-detected (`packages/core/src/domain/fieldMoves.ts` → `fieldMoveEffect`). Log the move normally (usually `m1 > Trick Room > self`) and `finalizeTurn` mutates the field:
- Weather: **Sunny Day** / **Rain Dance** / **Sandstorm** / **Snowscape** / **Chilly Reception** (also pivots).
- Terrain: **Electric / Grassy / Misty / Psychic Terrain**.
- **Trick Room** toggles on/off; **Tailwind** sets the acting side's tailwind; **Reflect** / **Light Screen** / **Aurora Veil** (both screens) set the acting side's screens.

## State lines (mutate state immediately, no turn entry, no `/next` needed)

```
o3 = 45 / o3 = 45%      ← set opp HP to 45%
m1 = 145                ← set my HP to 145 raw
m1 = 50%                ← explicit % on mine (also `= 0` now auto-faints + clears slot)
hp m1=45 m2=80 o1=30%   ← bulk HP update — many pairs in one line, end-of-turn recovery
o3 heal 25              ← +25% (capped at 100)
m1 heal 30              ← +30 raw HP (mine)
o1 sitrus               ← named berry: +25% + itemConsumed='Sitrus Berry'
o2 leftovers            ← EOT Leftovers tick: +1/16 (~6%) + confirms item='Leftovers'
                          (opp side; the live engine only auto-applies Leftovers
                          for MINE, so you log the opp's EOT heal here — the search
                          then models its recovery in lookahead)
o1 item Choice Specs    ← reveal a HELD item inline (no /info) — `itm` also works. Canonicalised;
                          clears any stale itemConsumed (it's held now) and prunes the opp's
                          candidate spreads to those carrying it. Item mechanics (resist/status
                          berries, Black Sludge, Clear Amulet, Choice lock, Air Balloon) then read it.
                          ITEM CLAUSE is on: a known/used item on one opp mon is auto-excluded from
                          every OTHER opp mon's candidate pool (ripples on reveal + each finalize;
                          never empties a set). See domain/itemClause.ts.
o1 ability Defiant      ← reveal an ability inline (no /info) — `abil` also works; a same-turn
                          foe-drop then auto-triggers Defiant/Competitive
o1 damage 25            ← -25% (clamps at 0; auto-faints + clears slot if 0)
m1 damage 30            ← -30 raw HP (mine)
o2 ko / o2 fainted      ← faint
o3 in o1                ← replacement send-in (opp index 3 into opp slot 1)
m4 in m1                ← my replacement
o1 +2 atk               ← single stat boost
m1 -1 def               ← negative
o1 +2 atk +2 spa        ← multi-stat in one line
   NOTE: a boost line logged WHILE a turn is in progress joins the turn's ordered
   timeline (shown in the draft list) and applies at THAT point at finalize — so a
   hit logged before it is inferred unboosted, and one after it sees the boost
   (Helping Hand / Coaching are computed the same way, positionally). A boost typed
   between turns (no draft open) still applies immediately — that's a correction.
o1 wp                   ← Weakness Policy: +2 atk +2 spa + itemConsumed
o1 sash                 ← Focus Sash: HP→1 + itemConsumed
o1 balloon              ← Air Balloon: itemConsumed (no HP change)
o1 taunt   / o1 taunt 2          ← Taunt (default 3 turns; trailing N overrides the count)
o1 encore Fake Out / ... 2       ← Encore: locks opp into a move (default 3t) → drives threat pool
o1 disable Flare Blitz / ... 1   ← Disable: removes a move from the opp threat pool (default 4t)
o1 cure                          ← clears status AND taunt/encore/disable (also clear on switch-out)
```

Encore/Taunt/Disable are move-restricting volatiles (Bulbapedia: Taunt 3t / Encore 3t / Disable 4t). They now **count down** each end-of-turn and auto-clear at 0 (also cleared by `cure` / switch-out). A trailing number overrides the seeded count. They work on either side (`my2 taunt`). Encore locks the opp's predicted threat to that move; Disable removes it. **Weather and Trick Room also count down** (default 5t, seeded when set by an ability/move); the grid's "Field —" line shows the remaining turns, and all counts are editable in `/override` (Weather turns / Trick Room turns rows).

## Slash commands

```
/next  /n        finalize turn
/undo  /u        remove the last draft action (NOT backspace any more — that's text editing)
/save  /s        snapshot match to disk
/info  /i        opponent info picker
/crit  /c        toggle crit damage column
/allmoves /a     toggle full per-move breakdown
/review /r       AI review of the last turn (needs ANTHROPIC_API_KEY)
/pika  /p        toggle Pikachu sprite (sixel preview)
/export /x       show current team as Showdown export
/ask <m vs o>    hypothetical matchup; both sides accept ref or species + optional +mega
/override /ov    manual state editor: field (weather/terrain/TR/tailwind), per-active occupant/HP/status/boosts. ↑↓ pick · ←→ change · digits set HP · Enter applies · Esc cancels
/help  /h /?     command + syntax cheat-sheet
/quit  /q        end match
```

## Reference resolution rules

- `o1` / `o2` / `m1` / `m2` are **active-slot refs** (look up via `activeIdx`).
- `o3`..`o6` / `m3`..`m6` are **team-index refs** (direct, 1-based).
- `my1`..`my6` / `op1`..`op6` are **unambiguous team-index refs** — valid in switch targets **and** in every state line (`op1 = 30%`, `my2 brn`, `op4 in o1`, `my1 +2 atk`). Use these to reach a **benched** mon sitting at team index 0/1, which `o1`/`m1` can't address (those always mean the active slots). For team indices ≥ 2, `o3` and `op3` resolve identically.
- Bare species names in `switch > X` resolve to team index by species id.
- For action damage: bare number's unit depends on target side (`%` for opp, `raw` for mine). For state `=` lines: same dispatch (bare on mine = raw, bare on opp = %).

## Where stuff is stored

- Per-action damage / HP-remaining → on `MoveAction` (consumed by `finalizeTurn` to compute `damageHpPercent` for inference).
- Per-opp HP / fainted / boosts / consumed item → `OpponentEntry.{currentHpPercent, fainted, currentBoosts, itemConsumed, megaUsed, megaForme, charging}`.
- Per-mine HP / fainted / boosts / consumed item → `Match.{myCurrentHp, myFainted, myBoosts, myItemConsumed, myMegaUsed, myMegaForme, myCharging}`.
- Match outcome → `Match.outcome: 'victory' | 'defeat' | 'tie'` (set by `detectOutcome` after `finalizeTurn` / `applyStateUpdate`).

## Autocomplete behaviour

`packages/core/src/domain/actionSuggest.ts`:

- After `m1 > ` → move suggestions from `myTeam[idx].moves`.
- After `o1 > ` → opp move pool = `knownMoves` ∪ Pikalytics top ∪ full legal `getLearnset`.
- After `m1 > switch > ` → team species (filtered by `myFainted` / `opponentTeam[].fainted`).
- After `o2 ` (no `>`) → state verbs: `heal`, `sitrus`, `leftovers`, `ko`, `fainted`, `in`, plus `damage`, `wp`, `sash`, `balloon` filtered from STATE_VERBS.
- Tab applies; cursor remounts via `inputKey` so it lands at the end of the new value.
