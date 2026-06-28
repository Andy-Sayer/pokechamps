# Regulation Set M-B — what we know + switch-day runbook

Researched 2026-06-12. Reg M-A ends **June 17, 2026**; Regulation Set M-B runs
**June 17 → September 2, 2026** (Season M-3). The full legal roster is NOT
published yet — it drops with the update on the 17th. This note holds the
confirmed facts and the exact steps to flip the app over on day one.

## STATUS 2026-06-28: real meta data INGESTED + team re-tune underway

Pikalytics now publishes `gen9championsvgc2026regmb` (built from ~2 weeks of
post-launch Reg M-B tournaments), so the "no usage data yet" constraint is over.
Done this pass:
- **Format slug repointed `regma → regmb`** via a single source of truth
  (`CHAMPIONS_PIKA_FORMAT` in `domain/data.ts`; the server keeps its own copy
  across the package boundary). Runbook step 4 ✅.
- **Parser hardened for the M-B /ai schema** (`refresh-pikalytics.ts`): the M-B
  export reports usage as `N/A` (ranks by raw game volume, exposing **win rate**
  + W-L-T record instead), renders Common Teammates as `undefined%` (names
  intact), and leaves the FAQ **nature blank**. The parser now tolerates all
  three and **infers the nature from the EV-spread shape** (`inferNatureFromSp`)
  — a neutral fallback would make the gauntlet artificially weak. `winRate`/
  `record` added to `PikalyticsEntry`. Covered by `tests/pikalytics-parse.test.ts`.
- **Freshness verified**: the `/ai` header's `Data Date: 2026-05` is a
  mislabeled template field; the dump is genuinely current (M-B-only species
  present: Swampert-Mega, Staraptor-Mega, Grimmsnarl, Gholdengo, Floette-Eternal;
  Recent Top Teams are all Reg M-B events). `mb-meta-report.ts` prints this.
- **Real meta** (rank by usage volume): Garchomp, Sinistcha, Basculegion,
  Whimsicott, Kingambit, Staraptor, Incineroar, Charizard-Y, Raichu-Y, Pelipper,
  Sneasler, Archaludon, Grimmsnarl… Dominant structure is **rain**
  (Archaludon+Pelipper+Swampert-Mega) + **Whimsicott Tailwind/Prankster** +
  **Trick Room** (Sinistcha/Farigiraf). **No new mechanic-port gaps** — every
  mechanic the field leans on (Prankster, Fake Out incl. Raichu-Y, Tailwind,
  Trick Room, Choice lock incl. Basculegion Scarf, Unburden+White Herb, and
  resist berries — 8 of top 25) is already modelled. Terrain setters and
  Protosynthesis/Quark Drive are absent from the top 25 (stay low-value).
- **Gauntlet rebuilt** from the real meta (`mb-team-check.ts` / `mb-hill-climb.ts`
  label real-usage boards `[meta]` and keep the hand-built threats as `[hand]`
  spice). `mb-hill-climb.ts` gained `--from`/`--out` + a no-regression save guard
  so a team can be tuned from several starts, keeping the best.

## STATUS 2026-06-16: format STAGED

The Serebii M-B additions list is live, so the format is pre-staged off it:
legality.allow **208** (+22 base species), items.allow **148** (+15 standard
items, +14 mega stones; Raichunite X/Y were staged earlier). `validate-format`
clean. Assumes M-A carries forward with NO removals — re-verify on the official
in-game list. The one open task is the **custom mega abilities** — see
[`champions-custom-data.md`](champions-custom-data.md) (2 names confirmed +
patched, 7 unpublished, effect emulation pending). New base species (22):
Vileplume, Qwilfish, Sceptile, Blaziken, Swampert, Mawile, Metagross, Staraptor,
Musharna, Scolipede, Scrafty, Eelektross, Pyroar, Malamar, Barbaracle, Dragalge,
Grimmsnarl, Falinks, Overqwil, Houndstone, Annihilape, Gholdengo.

## Confirmed (official announcements)

- **Gimmick stays Mega Evolution** — no Terastallization. Our `gimmick: "mega"`
  layer carries over unchanged.
- **Mobile launch same day** (June 17, iOS/Android) — expect a player surge and
  a meta shake-up bigger than a normal rotation.
- **New megas: Mega Raichu X and Mega Raichu Y** (login gift Raichu + both
  stones, claimable June 17 → Sept 1).
  - **Mega Raichu X — Electric Surge** (auto Electric Terrain on entry).
  - **Mega Raichu Y — No Guard** (every move by/against it hits).
  - Both Electric-type. Stones: `raichunitex` / `raichunitey` — already in our
    dex dump along with `raichumegax`/`raichumegay` formes. Upstream had a
    placeholder ability (Surge Surfer) on both; `refresh-data.ts` now patches
    the official abilities into every dump (`SPECIES_PATCHES`), and the current
    `data/species.json` is already corrected.
- "Multiple Pokémon and Mega Evolutions" join the roster; the rest of the list
  is unannounced. Serebii's M-B page currently lists only the two Raichu formes.
- Singles: 3-6 mons; Doubles: 4-6 brings — same shapes as M-A. Level 50 flat.

## Tactics implications (already supported by the engine)

- **Raichu X is an auto terrain setter**: the `terrain` tactic detector picks
  it up via Electric Surge the moment it's profiled (Rising Voltage abusers,
  Quark Drive, Surge Surfer partners — Alolan Raichu itself if legal). Raichu's
  learnset has Rising Voltage, Volt Switch, Fake Out, Nuzzle.
- **Raichu Y + No Guard**: Zap Cannon (learnset-confirmed) becomes a 100%
  accurate 120 BP guaranteed-paralysis nuke; Focus Blast/Thunder never miss.
  Flip side: everything aimed at it also never misses — Hail-Mary miss outs
  vanish against it (the search's miss-out logic keys off accuracy, which No
  Guard pins to 100).
- A No Guard + inaccurate-nuke detector ALREADY EXISTS (`detectNoGuard` in
  `tactics.ts`, pattern `no-guard`: No Guard holder + ≥90 BP / ≤90% accuracy
  moves, recharge/charge filtered). It fires on Mega Raichu Y automatically once
  the stone is profiled — Zap Cannon / Focus Blast / Thunder are all in Raichu's
  learnset. Covered by `tests/regulation-m-b.test.ts`.

## Switch-day runbook (June 17)

1. `npm run refresh-data` — pull the updated `@pkmn/dex` (bump the dep first if
   needed: `npm i @pkmn/dex@latest -w @pokechamps/core`). The `SPECIES_PATCHES`
   map re-applies Champions corrections; verify the patch log lines print.
2. Update `data/format.champions.json`:
   - `__notes`: new dates + source link.
   - `legality.allow`: add the new species ids (MetaVGC / Serebii M-B list).
     **Use the staging helper** — paste the official roster (names or ids, any
     separators) and it emits a validated, sorted, paste-ready block + a diff,
     flagging typos / ids not in the dex and any mega formes that belong in
     `items.allow` instead:
       `npx tsx packages/core/src/scripts/stage-roster.ts --mode replace`
     (`--mode replace` = the paste is the full new list, so it also reports
     removals; `--mode add` = the paste is only additions. `--in roster.txt` to
     read a file instead of stdin.) Then paste the printed block between the
     `[ ]` of `"legality": { "allow": [ … ] }`. The watch-list candidates
     (Indeedee/Indeedee-F/Rillaboom/Pincurchin/Weezing-Galar) already resolve in
     the dump — but confirm against the OFFICIAL list before committing.
   - `items.allow`: add new items. **`raichunitex` / `raichunitey` were
     PRE-STAGED 2026-06-16** (commit "pre-stage Raichunite X/Y") and verified by
     `tests/regulation-m-b.test.ts` — just add anything else the official list
     introduces.
   - Check for removals — rotations can drop species/items too.
3. `npm run validate-format` — every id must resolve.
4. Pikalytics ✅ DONE 2026-06-28: the format id is now `gen9championsvgc2026regmb`,
   sourced from the single `CHAMPIONS_PIKA_FORMAT` constant in `domain/data.ts`
   (the server's `pikalytics/cache.ts` mirrors it). `npm run refresh-pikalytics`
   wrote `data/pikalytics.gen9championsvgc2026regmb.json`. NOTE the M-B /ai
   export degrades vs M-A (usage `N/A` → win-rate-ranked, teammates `undefined%`,
   blank nature) — `refresh-pikalytics.ts` was hardened to tolerate all three +
   infer nature from the spread shape. Re-verify the parser if the export layout
   changes again.
5. `npx tsx packages/core/src/scripts/tactics-catalog.ts` — regenerate the
   combo catalog over the new legal lists (new Raichu cores will appear).
6. `npx tsx packages/core/src/scripts/smoketest.ts` + `npm test`.
7. Sanity: damage-calc a Mega Raichu X Rising Voltage in terrain vs a known
   spread against the Pikalytics calc.

Sources: pokemon.com news (mobile launch + Raichu reveal, 2026-06-03),
serebii.net/pokemonchampions/rankedbattle/regulationm-b.shtml,
victoryroad.pro/champions-regulations, game8 season schedule.
