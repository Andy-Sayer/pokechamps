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
m1 > switch > Garchomp                     ← switch by species name
m1 > switch > my4                          ← switch by team-index ref
o2 > switch > op3                          ← opp switch
m1 mega                                    ← standalone mega declaration (separate action, +5 bracket)
m1 mega y                                  ← mega variant disambiguator (Charizard X/Y, Lucario, etc.)
```

Pivot moves (U-turn / Volt Switch / Flip Turn / Parting Shot / Teleport / Chilly Reception / Baton Pass / Shed Tail) are auto-detected via the dex `selfSwitch` field. After the pivot move log the switch as a normal next action — `finalizeTurn` tags it `pivot: true` so speed inference skips it (the switch happened inside the pivot move's bracket, not the natural +6 switch bracket).

Field-clearing moves are auto-detected by name (`packages/core/src/domain/hazards.ts` → `hazardClearEffect`). Just log the move normally — `finalizeTurn` mutates the field so you don't toggle each hazard off by hand:
- **Rapid Spin** / **Mortal Spin** — clear the user's own-side hazards (Rapid Spin also +1 user Speed).
- **Defog** — clear hazards **and** screens on both sides.
- **Court Change** — swap all side conditions (hazards / screens / Tailwind) between sides.
- **Tidy Up** — clear hazards on both sides (+1 user Atk & Speed).

## State lines (mutate state immediately, no turn entry, no `/next` needed)

```
o3 = 45 / o3 = 45%      ← set opp HP to 45%
m1 = 145                ← set my HP to 145 raw
m1 = 50%                ← explicit % on mine (also `= 0` now auto-faints + clears slot)
hp m1=45 m2=80 o1=30%   ← bulk HP update — many pairs in one line, end-of-turn recovery
o3 heal 25              ← +25% (capped at 100)
m1 heal 30              ← +30 raw HP (mine)
o1 sitrus               ← named berry: +25% + itemConsumed='Sitrus Berry'
o1 damage 25            ← -25% (clamps at 0; auto-faints + clears slot if 0)
m1 damage 30            ← -30 raw HP (mine)
o2 ko / o2 fainted      ← faint
o3 in o1                ← replacement send-in (opp index 3 into opp slot 1)
m4 in m1                ← my replacement
o1 +2 atk               ← single stat boost
m1 -1 def               ← negative
o1 +2 atk +2 spa        ← multi-stat in one line
o1 wp                   ← Weakness Policy: +2 atk +2 spa + itemConsumed
o1 sash                 ← Focus Sash: HP→1 + itemConsumed
o1 balloon              ← Air Balloon: itemConsumed (no HP change)
```

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
/help  /h /?     command + syntax cheat-sheet
/quit  /q        end match
```

## Reference resolution rules

- `o1` / `o2` / `m1` / `m2` are **active-slot refs** (look up via `activeIdx`).
- `o3`..`o6` / `m3`..`m6` are **team-index refs** (direct, 1-based).
- `my1`..`my6` / `op1`..`op6` are also team-index refs (used in switch targets).
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
- After `o2 ` (no `>`) → state verbs: `heal`, `sitrus`, `ko`, `fainted`, `in`, plus `damage`, `wp`, `sash`, `balloon` filtered from STATE_VERBS.
- Tab applies; cursor remounts via `inputKey` so it lands at the end of the new value.
