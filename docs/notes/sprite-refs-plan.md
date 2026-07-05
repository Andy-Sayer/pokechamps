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

### Regional formes are DISTINCT species — the OPPOSITE of shiny/gender
Alola / Galar / Hisui / Paldea formes have their own **types, stats, movesets** —
Ninetales-Alola is **Ice/Fairy**, not Fire — so each gets its own ref *and* its own
species label; they do NOT collapse to the base. The preview **type-icons disambiguate**
them (Ice/Fairy vs Fire). **17 are legal in M-B** (via base-fallback), all now in the
dossier (`buildDossier` enumerates each base's regional `otherFormes`) — so they're
threat-assessed, not "unknown." Their shiny/gender still collapse onto the forme
(`ninetalesalola-shiny` → `Ninetales-Alola`). Coverage must include all 17.

### Schema change (do first — small)
Today refs are `{id, name, hist}` and bootstrap UPSERTs by `id`, so a shiny would
*overwrite* the base. Change to:
- `{ key, species, variant, hist }` where `key` = `garchomp` / `garchomp-shiny` /
  `basculegion-f` / `basculegion-f-shiny`; `species` = canonical `Garchomp`.
- UPSERT by `key` (variants coexist). `HistogramMatcher` returns `species` → the caller
  never sees the variant. Gender/shiny "usually don't matter" → collapse to species.

## Sources
**Coverage comes from the OPPONENT side.** A ladder VOD faces a *new* team every game, so
one 3-hour VOD yields *dozens* of different species. The player side is the SAME ~6 mons
all video (the streamer's team) — auto-labelled but low-diversity, a bonus not the driver.

1. **Opponent side (the coverage driver).** Sprites + type-icons, no names. Make the ID
   FAST via the **type-icons**: read the 2 icons (a fixed **18-type** closed set — easy,
   reliable to template/colour-match; no shiny/gender/regional variation) → shortlist
   legal species with that type combo from the dossier (usually 1–5, often unique:
   Water/Ghost⇒Basculegion, Ice/Fairy⇒Ninetales-Alola, Fighting/Poison+Unburden⇒Sneasler)
   → confirm the sprite from the *shortlist*, not from 200. As colour-hist refs grow, the
   matcher pre-fills the guess and I just confirm/correct — self-improving.
2. **Player side (bonus, auto-labelled).** Name + gender + sprite shown → 6 zero-guess
   refs per VOD (incl. shiny/gender the streamer runs). Nice, but ~10 different-team VODs
   ≈ one ladder VOD's opponent diversity — so it's the accelerator, not the engine.
3. **Targeted gap-fill** for meta species/variants still missing (coverage report drives).

**Efficiency unlock = a type-icon reader** (18 fixed UI icons → the type combo). Small,
reliable build; turns opponent ID from "eyeball 200 sprites" into "confirm 1 of 1–5."

## Laser handling (settled)
The preview's red beams are largely *static*, so temporal median can't remove them.
Don't chase pixel-perfect removal — **process ref and live-query identically** (same
crop + temporal min-redness over a burst): the laser contributes equally to both
histograms and cancels in the distance. Skip genuinely-ambiguous slots when labelling
and re-catch that species from a cleaner frame. Inpainting is an optional later refinement.

## Harvest runbook (constraints + steps)
**Sources:** VODs from the **last ~2 months only** — keeps both the *meta* (species that
actually appear) and the *UI* (preview layout) current; older footage risks a different
metagame and a shifted grid. Filter with `yt-dlp --dateafter now-2months`; prefer
well-framed channels (Wolfey, Cybertron). **Recalibrate the crop boxes per VOD (or at
least per streamer)** — facecam / overlay / resolution shift the boxes, so the calibrated
`oppTeam`/`playerTeam` grid must be *verified* (and adjusted) for each source before
trusting any ref.

**VOD size (the cost is extraction, not download).** A 1080p ladder VOD is ~1.5 GB/hr and
extraction at 0.2 fps yields ~720 frames/hr — the OCR preview-scan over those frames is the
real time sink (~40 min for a 1h43m VOD). Trade-off: the SHORT VODs (Draft League 15-45 min)
are single-matchup / showcase = 1-2 opponents = ~2 sprites; the LONG ladder climbs (1.5-2 h)
are long *because* they pack ~10-12 games = ~12 opponent teams = the diversity we need. So
**prefer the ~1h15m ladder band** (e.g. Raichu-X `9R5YJuM-h5Y`, Eelektross `NWbeosiGkac`) —
~40% smaller than the 2 h climbs, still a full ladder run. Extract at **0.15 fps** (the
"Select 4" screen shows 15-90 s, so 1/6.7 s still catches it) to cut frames ~25%. Always
`rm _vod.*` right after extraction and prune non-preview frames after `find-previews`.

Per VOD:
1. `youtube.ts <url> --start MM:SS --end MM:SS --fps 2` on a *short* window at a team
   preview (delete the `_vod` segment immediately).
2. `calibrate-preview.ts <frame.png>` → crops the grid boxes for a visual check; if they
   miss the sprites, adjust the box coords for that source (a named calibration).
3. `bootstrap-refs.ts <frame.png> <ids>` (opp side by-sight; player side auto-labelled),
   `-` to skip covered/ambiguous slots; temporal min-redness burst for laser slots.
4. Delete the frames (keep only `sprite-refs.json`). Disk stays flat.

## Harvest roster (curated creators)
Framing is per-creator, so calibrate ONCE (a `calibrate-preview` pass on one preview
frame), then their whole catalog is harvestable. Pick well-framed, active, Reg-M-B
ladder/tournament creators (many opponents per VOD).

| Creator | Calibrated? | Notes |
|---|---|---|
| **CybertronVGC** | ✅ oppTeam + **playerSpriteBoxes** (y_top=0.167+i·0.111) verified; transfers across his VODs (facecam moves, game UI fixed) | Primary source. Mined 2026-07-04: Pd-8eg-bDZs (SAND, +12), 9R5YJuM-h5Y (Raichu-X, +5), NWbeosiGkac (Eelektross, +Sableye/Meowscarada), + player-side targeted: dUzYKEU_8TA (Scrafty), C370Q58qnFI (Pyroar), 8BtFlPO3yLY (Pelipper). **Meta 11→34/48.** |
| **WolfeyVGC** | ✅ framing IDENTICAL to Cybertron (fullscreen 1080p → same player/opp boxes, zero recalibration); verified on FEVwyQyRJzk | Facecam BOTTOM-RIGHT → covers only opp rows 4-5 (player column + opp rows 0-3 clear). His *tournament/ladder* VODs are real gameplay; his "Worst X Type" **analysis** vids are graphics/commentary (NOT harvestable). Gave Scovillain. |
| **Jeans** | ✅ framing identical (fullscreen 1080p); verified on apejN-EFTXM | Facecam bottom-centre. Gave Gengar + Ninetales-Alola. |
| _(add trusted creators here)_ | ⬜ | verify framing → add. |

**Recon method (validated 2026-07-04):** before committing to a VOD, grab ONE frame at
its MIDPOINT (`youtube.ts <url> --fps 1 --start MID --end MID+3`) and eyeball it — instantly
filters out Showdown-teambuilder vids (2D icons, wrong art), produced analysis/commentary
(overlay graphics), and confirms fullscreen-1080p framing. All three creators so far share
the SAME calibration (game fills the frame), so the only per-creator variable is facecam
position (which slots it occludes) — no box re-measuring needed.

**Remaining 11 meta gaps** (2026-07-04): Annihilape, Ceruledge, Corviknight, Froslass,
Gardevoir, Glimmora, Hydreigon, Mawile, Milotic, Tsareena, Vivillon. Common ones
(Gardevoir/Corviknight/Hydreigon/Milotic/Annihilape) will surface opponent-side in 1–2 more
ladder VODs; the rarer tail (Ceruledge/Vivillon/Glimmora/Mawile/Tsareena) is faster via a
player-side VOD titled after them (Wolfey/Jeans/Cybertron all work). Regionals 2/17 (Zoroark-
Hisui, Ninetales-Alola) — the rest need dedicated catches.

Different creators face different opponents → diversity (long tail + regionals). Each new
creator: one `calibrate-preview`, adjust `regions.ts` if boxes miss, then harvest.

## Allocation review + the readOppTeam SAFETY CONTRACT (do NOT skip)
An allocation is a (crop → species) label. Both colour-hist matching AND a human eye
misfire — a **shiny Grimmsnarl** was once labelled **Mewtwo** (a non-legal restricted
legendary). **THE THREAT:** once `readOppTeam` feeds the bring recommender, a mislabelled
ref makes the app read the WRONG opponent 6 → optimise the bring against the wrong team →
recommend the wrong 4 to bring. Silent and costly. So:

- **Every ref carries provenance + a `verified` flag** (`bootstrap-refs` saves the source
  crop to `data/sprite-ref-crops/<id>.png` and sets `verified:false`). Unverified until a
  human confirms.
- **Review sheet:** `scripts/review-sheet.ts` → self-contained HTML contact sheet (crop +
  species + nearest-RIVAL species/distance; red = ambiguous). Human confirms each; wrong
  ones get relabelled (and re-set unverified). A legality guard already blocks non-allow-list
  labels at bootstrap time.
- **`readOppTeam` MUST gate on this (contract):** auto-accept a slot's ID only if
  `ref.verified === true` AND `distance < ACCEPT_THRESHOLD` AND the nearest *other-species*
  rival is a clear margin farther. Otherwise mark the slot **UNKNOWN → manual confirm** —
  NEVER pass a low-confidence / unverified guess to the bring. A wrong "unknown→ask the user"
  is cheap; a wrong silent ID is not. (readOppTeam not built yet — this is its build spec.)
- **Backfill:** the ~47 legacy refs (bootstrapped before crop-saving) have no crop yet →
  not reviewable → treat as UNVERIFIED. Re-capture their crops during ongoing harvest (or a
  dedicated pass) so the whole table can be reviewed before readOppTeam is trusted.

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
