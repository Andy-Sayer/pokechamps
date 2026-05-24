# Speed inference brackets

`effectivePriority(a, ctx)` in `packages/core/src/domain/speed.ts` decides which priority bracket an action sits in. Only same-bracket pairs are used by `inferOpponentSpeeds` to derive speed constraints — different-bracket pairs are skipped entirely. The bracket values:

| Bracket | Action |
|---|---|
| **+6** | switch (the natural "switches first" bracket) |
| **+5** | standalone mega declaration |
| **+N** | move's intrinsic priority, plus Quick Claw (+1), plus ability bump |
| **-99** | pivot-forced switch (sentinel; never matches anything → "skip this action") |

Ability bumps handled inside `abilityBracketBump`:

| Ability | Bump | Trigger |
|---|---|---|
| Prankster | +1 | `move.category === 'Status'`. Note: vs Dark the move FAILS but the priority bracket still applies — we still skip the bracket-equality check. |
| Gale Wings | +1 | `move.type === 'Flying'` AND `attackerHpPercent >= 100` (Gen 7+ rule) |
| Triage | +3 | `move.flags.heal` OR `move.heal` OR `move.drain` |
| Stall | -7 | any move (moves last in its bracket) |

## Context resolution

`inferOpponentSpeeds` builds a `ctxFor(action)` that pulls:

- `attackerAbility` from `myTeam[idx].ability` or `opponentTeam[idx].ability`
- `attackerHpPercent` from `myCurrentHp[idx]` or `entry.currentHpPercent` (default 100)

Without an ability we treat the move at its natural priority — no bump. So when opp abilities haven't been observed, Prankster mons are NOT auto-detected; the user has to set `opp.ability` somehow (currently via the OppInfoPanel / inference candidate selection).

## Why the bracket-equality contract matters

If a Prankster-boosted Tailwind from Whimsicott moves before my Jolly Sneasler's Close Combat, naive speed inference would conclude Whimsicott outsped Sneasler (false — Prankster put it in a higher bracket).

Treating ability bumps the same way we treat Quick Claw — by changing the bracket, not by emitting a special "skip me" flag — naturally avoids the false signal because the two actions are no longer in the same bracket and don't get compared.

## Pivot move tagging

Pivot moves (U-turn / Volt Switch / Flip Turn / Parting Shot / Teleport / Chilly Reception / Baton Pass / Shed Tail) are detected via `data.ts:isPivotMove` (reads `move.selfSwitch`). `engine.ts:finalizeTurn` walks the action sequence and tags switches that follow a same-side+same-slot pivot move as `pivot: true`. The -99 sentinel bracket then keeps those switches out of speed inference.

The switch that follows a U-turn happens inside the pivot move's priority bracket (the same +0 most of these sit in), NOT the +6 natural switch bracket — so if we'd left it at +6 we'd have generated speed signals against any other switch on the turn.
