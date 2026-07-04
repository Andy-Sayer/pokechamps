# Sprite-ref library build-out plan

Grow `data/sprite-refs.json` (13 refs today) to cover the meta so `readOppTeam()` can
identify the opponent's 6 at team preview. Matching is a **background-masked colour
histogram** (`colorHist.ts`) — dHash was a dead end (cross-art noise). Because it's
colour-based, every visually-distinct **variant** needs its own ref, but they all map
to one **species**.

## Variants (the core design decision)
| Variant | Needs own ref? | Why |
|---|---|---|
| **Base** (♂ / genderless) | yes | the common case |
| **Shiny** | yes | recoloured → different histogram; not rare on ladder |
| **Female** | only for the ~2 dozen species with a *visually distinct* ♀ | most ♀ == ♂ (one ref suffices); some differ hard (Basculegion ♂ red / ♀ blue) |
| **Shiny + female** | where both apply | |

**All variants map to the same species.** So the matcher must return the *species*, not
the variant — i.e. refs are **keyed by variant** but carry a canonical `species`.

### Schema change (do first — small)
Today refs are `{id, name, hist}` and bootstrap UPSERTs by `id`, so a shiny would
*overwrite* the base. Change to:
- `{ key, species, variant, hist }` where `key` = `garchomp` / `garchomp-shiny` /
  `basculegion-f` / `basculegion-f-shiny`; `species` = canonical `Garchomp`.
- UPSERT by `key` (variants coexist). `HistogramMatcher` returns `species` → the caller
  never sees the variant. Gender/shiny "usually don't matter" → collapse to species.

## Sources (priority order)
1. **Player side of the preview (BEST — auto-labelled).** The left panel shows **name +
   gender symbol + the actual (possibly shiny) sprite** → zero-guess base/shiny/♀ refs.
   Extend `bootstrap-refs` to also crop the player grid (needs a `playerSpriteBoxes`
   region, calibrated like the verified `oppTeam` one).
2. **Opponent side (by-sight).** Sprites + type-icons, no names → identify by eye + the
   type icons (Water/Ghost ⇒ Basculegion, Fighting/Poison+Unburden ⇒ Sneasler…). Good
   base coverage; catches variants I can recognise.
3. **Targeted gap-fill.** For meta species/variants still missing, pick a VOD/game that
   features them (coverage report, below, drives this).

## Laser handling (settled)
The preview's red beams are largely *static*, so temporal median can't remove them.
Don't chase pixel-perfect removal — **process ref and live-query identically** (same
crop + temporal min-redness over a burst): the laser contributes equally to both
histograms and cancels in the distance. Skip genuinely-ambiguous slots when labelling
and re-catch that species from a cleaner frame. Inpainting is an optional later refinement.

## Coverage tracking
`sprite-coverage` report: for each meta species (from Pikalytics usage / the dossier),
which variants have refs (base / shiny / ♀). Drives which VOD to harvest next, and tells
`readOppTeam` when to flag "unknown" (nearest-match distance over a threshold) so it
falls back to manual entry instead of guessing.

## Phases
1. **Schema** — variant-keyed refs + species-returning matcher + UPSERT by key. *(small)*
2. **Player-side harvest** in `bootstrap-refs` + temporal min-redness burst input. *(med)*
3. **Grind meta base coverage** from VODs (player-side auto + opp-side by-sight). *(grind)*
4. **Coverage report** → target shiny/♀ gaps. *(small + grind)*
5. **`readOppTeam()`** — per slot: median-burst → match → confidence flag; validate on
   held-out preview frames. *(med)*
6. **Wire into the TUI opponent flow** — auto-populate the 6, user confirms/edits. *(med)*

## Effort vs coverage
Meta ≈ 50 species → ~50 base + ~50 shiny + a handful of ♀ ≈ **~110 refs**. Full 208 ≈
~450. **Meta coverage is what matters** — you face meta species; the long tail is caught
over time and, until then, flagged "unknown" → manual entry. Not a blocker for shipping
`readOppTeam` on the meta.
