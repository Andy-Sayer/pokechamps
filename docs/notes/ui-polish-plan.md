# TUI polish plan (roadmap pillar D)

Plan only — mockups for review before building, per the standing "show before
building" preference. Nothing here is implemented yet. Ordered by value/effort.

Context: the original "TUI polish" subagent (the #2 batch) never ran — it
stalled on a sandbox shell-permission wall — so none of this got built. These
are small, high-frequency-of-use wins on the screens you touch every match.

## 1. Match-end summary screen — ✅ SHIPPED 2026-05-26

Built as `MatchSummary.tsx` rendered inside BattleScreen's existing outcome
box (not a separate route — lower risk, same value). Pure exported
`summarizeMatch()` + 3 tests. Shows brought 4, both sides' final HP, turns,
KO tally. Original note below for context.

**Today:** when a match ends (`/quit`, or all four faint), `BattleScreen`
calls `onEnd()` and you drop straight back to the menu — no recap.

**Proposed:** a read-only summary screen before the menu. New
`packages/tui/src/ui/MatchSummary.tsx`; `BattleScreen.onEnd` routes through it
(or `cli.tsx` adds a `match-summary` route). All data is already on the `Match`.

```
┌─ Match over — victory ✓ ──────────────────────────┐
│  vs <opp>            12 turns        2026-05-26    │
│                                                    │
│  You brought:  Sneasler · Rillaboom · Iron Hands · │
│                Flutter Mane                        │
│  Final state:                                      │
│    Sneasler    fainted        Incineroar  fainted  │
│    Rillaboom   61%            Amoonguss   fainted  │
│    Iron Hands  100%           Garchomp    28%      │
│    Flutter M.  fainted        Talonflame  100%     │
│                                                    │
│  KOs: you 3 · them 2                               │
│                                                    │
│  Enter: menu   ·   s: save snapshot   ·   x: export│
└────────────────────────────────────────────────────┘
```
Effort: ~1 new component + a route hop. Risk: low (pure render of existing
state; doesn't touch finalizeTurn).

## 2. Tab-cycle autocomplete at opponent input — ✅ SHIPPED 2026-05-26

Tab cycles the highlighted suggestion (Shift+Tab back, wrapping); Enter
commits the highlight. `OpponentInput.tsx`. Original note below.

**Today:** `OpponentInput.tsx` filters the Champions legal list as you type but
the suggestion list isn't keyboard-cyclable.

**Proposed:** Tab → next suggestion, Shift+Tab → previous, Enter accepts the
highlighted one (mirrors the battle-screen autocomplete, which already does
↑/↓/Tab). Reuse the existing filter; add a highlight index + key handling.
Effort: small, contained to `OpponentInput.tsx`. Risk: low.

## 3. Inline edit of draft actions *(medium)*

**Today:** while composing a turn you see the drafted action list; to fix a
mistyped line you `/undo` (removes the last) and retype.

**Proposed:** let the user edit/remove a *specific* drafted action before
finalizing — e.g. `/undo 2` removes the 2nd, or a small selectable list
(↑/↓ to pick, `e` to reload it into the input, `d` to delete).

```
Turn 5 in progress (3 actions)
  1. m1 Close Combat → o1
  2. m2 Fake Out → o2            ◀ e edit · d delete
  3. m1 switch → Garchomp
> _
```
Effort: medium — touches `BattleScreen` draft-action state + input handling
(the dual-finalize file, but only the *compose* path, not finalize). Risk:
medium; keep `/undo` working unchanged.

## 4. Quick-replay through saved snapshots *(medium)*

**Today:** `s` snapshots a match to `matches/<id>.json`; `MatchHistory` lists
past matches but there's no turn-by-turn playback.

**Proposed:** a replay viewer that loads a saved match and steps through its
`turns[]` (←/→ to scrub), re-rendering the board at each turn — effectively the
spectator board (issue with [[live-share]] reuse) driven by local turn history
instead of a live socket. Could share the read-only render path with the new
spectator mode (`BattleScreen spectator`). Effort: medium; best done *after* any
read-only-board extraction so it isn't duplicated. Risk: medium.

## 5. Resize-aware layouts *(low priority, fiddly)*

**Today:** the matchup grid + rosters assume a roomy terminal; a narrow window
wraps awkwardly.

**Proposed:** use Ink's `useStdout`/measured width to switch between a wide
(side-by-side) and a stacked layout below a threshold. Effort: low-medium but
fiddly to get right across terminals. Risk: low (cosmetic). Lowest priority.

## Suggested order

1 (match-end summary) and 2 (Tab-cycle) are the quick, self-contained wins —
do them first, each its own commit. 3 and 4 are medium and share state/render
with `BattleScreen`; 4 ideally rides on a small read-only-board extraction that
also de-duplicates the spectator screen. 5 only if a narrow-terminal complaint
actually comes up.
