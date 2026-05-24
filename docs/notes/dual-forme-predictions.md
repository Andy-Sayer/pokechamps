# Dual-forme predictions

A held mega stone alone does NOT auto-megify damage calcs. The contract:

- `gimmicks/mega.ts:resolveSpecies({ set, active })` returns the mega forme name **only when** `active === true`. With `active: false` (the default for pre-mega mons), it returns `null` and the calc uses the base forme — which is the truth right now, since mega evolution actually changes base stats / ability / sometimes type only after activation.
- After `/mega` is logged, `applyMegaAction` in `megaResolve.ts` remaps the relevant candidate sets so `set.species` becomes the mega forme name. Post-mega calcs then use the mega forme directly (no `active` flag needed).

## Pre-fix bug

`resolveSpecies` used to ignore its `active` arg and always return the mega forme when a stone was held. Pre-mega Charizard Y was being calc'd as Mega-Y — overstating my own damage output. Same bug applied to speed, but `actualSpeed` always used the base forme so speed was understated. The two were inconsistent.

## Dual-forme display in BattleScreen matchups

For each of my active mons, the matchup builder checks `myMegaUsed.includes(myIdx)` and `getMegaOptions(set.species).find(o => o.stone === set.item)`. If the mon hasn't activated mega yet AND holds a legal stone, we compute predictions twice — once at base (current truth) and once with `attackerGimmickActive: true` (potential mega). Both surface inline:

```
→ Flamethrower 45-67% (KO) ⭢mega 78-95%
← Earthquake 30-40%        ⭢mega 18-25%
speed glyph ✓/✗  pair
```

Header line gains `spd 95 (mega Charizard-Mega-Y: 100)`.

Speed verdict uses `actualSpeed(set, formeOverride)` to look up the post-mega base speed — same EVs/nature, just a different species lookup. `speedVerdict({ ..., myFormeOverride })` lets the verdict be computed for either forme; the matchup row passes both base and mega and renders both glyphs.

## Opp-side dual is deferred

Would need item inference + candidate filtering to know which opp mons actually hold a stone vs which don't. The `enumerateOpponentVariants` hook on the mega gimmick already gives the candidate stones, but threading dual display through `predictThreat` hasn't been done.

## Related concepts

- `[Speed inference brackets](speed-inference-brackets.md)` — what bracket the standalone `m1 mega` action sits in (+5).
- `CLAUDE.md` — the canonical short note: "PokemonSet has no mega flag — a held mega stone is sufficient signal." That's true for *team validation*; for *in-battle calcs* we still need `active` to flip between base/mega.
