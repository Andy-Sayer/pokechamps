# Regulation Set M-C — what we know + switch-day runbook

> **STATUS 2026-09-05: PARTIALLY STAGED, not yet live.** M-B runs to **Sept 8, 2026
> 19:00 PDT**; M-C takes over immediately after and runs to **Dec 1, 2026 17:59 PST**
> (= Sept 9 02:00 UTC → Dec 2 01:59 UTC). Everything that is *publicly named*
> pre-launch is already in the app: 4 new base species, all 6 new mega stones, and
> 3 of the 6 new mega abilities (one of which needed engine emulation). The other
> ~20 species and 2 abilities are **unpublished** — they drop with the in-game
> roster on switch-day, and step 2 of the runbook below is the whole job.
> **Re-swept 2026-09-07** — see the research update below: Aura Guard confirmed
> official, the other two abilities still unrevealed, Mega Heatran now on the watch list.
>
> **Our earlier note said M-B ended Sept 2. That was wrong** — the official window
> is Sept 8 (Victory Road / pokemon.com / Serebii all agree). Dates corrected
> repo-wide 2026-09-05.

Researched 2026-09-05. This note follows the proven
[`regulation-m-b.md`](regulation-m-b.md) shape: confirmed facts, engine
implications, then the exact steps to flip the app over.

## Confirmed (official announcements)

- **Window**: Sept 8, 2026 19:00 PDT → Dec 1, 2026 17:59 PST. Applies to the 2027
  Latin America International Championships.
- **Gimmick stays Mega Evolution** — one per side per battle, multiple stones may
  be *held*. Species Clause + Item Clause unchanged, Lv50 flat, Doubles bring 4 of 6
  (Singles 3 of 6). Nothing in the rules layer changes: `gimmick: "mega"` carries over.
- **24 newly battle-eligible Pokémon + 6 new Mega Evolutions.** Only four species
  are named in the announcements: **Rillaboom, Salamence, Golisopod, Baxcalibur**
  (the latter three are the bases of new megas). The remaining ~20 are visible only
  in-game (Recruit → Recruit Pokémon → Roster Info → Pokémon Featured in This Roster).
- **No removals.** "Pokémon that were eligible for Ranked Battles in previous
  regulation sets remain eligible." MetaVGC's M-C roster is a strict superset of our
  M-B list (`stage-roster --mode replace` reported **0 removals**). Re-verify against
  the in-game list on switch-day anyway — M-B taught us aggregators lag.

### The six new megas

| Mega | Stone (id) | Typing | Ability | Status in the app |
| --- | --- | --- | --- | --- |
| Salamence-Mega | `salamencite` | Dragon/Flying | Aerilate | ✅ canonical, dump already correct |
| Golisopod-Mega | `golisopite` | Bug/**Steel** | **UNREVEALED** | ⚠️ placeholder (Emergency Exit) |
| Baxcalibur-Mega | `baxcalibrite` | Dragon/Ice | **UNREVEALED** | ⚠️ placeholder (Thermal Exchange) |
| Absol-Mega-Z | `absolitez` | Dark/**Ghost** | Sharpness | ✅ patched (standard ability) |
| Garchomp-Mega-Z | `garchompitez` | Dragon (mono) | Levitate | ✅ patched (standard ability) |
| Lucario-Mega-Z | `lucarionitez` | Fighting/Steel | Aura Guard (custom) | ✅ patched + **emulated**, name **CONFIRMED** 2026-09-07 |

All six formes and all six stones were **already in the `@pkmn/dex` dump** with
correct stats/types (`isNonstandard: 'Future'`, except the canonical Salamencite at
`'Past'`), and `@smogon/calc` builds every one of them — verified 2026-09-05. As with
M-A/M-B, the only data gap was the **abilities**.

Base stats as dumped (all verified against RotomLabs' Z-A dex):

```
Absol-Mega-Z      65 / 154 /  60 /  75 /  60 / 151   Dark/Ghost
Garchomp-Mega-Z  108 / 130 /  85 / 141 /  85 / 151   Dragon
Lucario-Mega-Z    70 / 100 /  70 / 164 /  70 / 151   Fighting/Steel
Salamence-Mega    95 / 145 / 130 / 120 /  90 / 120   Dragon/Flying
Golisopod-Mega    75 / 150 / 175 /  70 / 120 /  40   Bug/Steel
Baxcalibur-Mega  115 / 175 / 117 / 105 / 101 /  87   Dragon/Ice
```

### The Z-mega ability reveal (2026-08-31)

- **Mega Absol Z — Sharpness** (×1.5 on slicing moves). Standard Gen 9 ability; the
  calc applies it natively once the forme's ability is right. Night Slash / Psycho
  Cut / Sacred Sword on a 154 Atk / 151 Spe frame.
- **Mega Garchomp Z — Levitate**. Mono-Dragon that is now **immune to Ground** and to
  grounded hazards. `isLevitateAbility` + `hazards.ts` handle it with no new code;
  Earthquake into an active Garchomp-Mega-Z correctly returns the calc's immunity
  throw. Note the trade: it loses Ground STAB and becomes a 141 SpA special attacker.
- **Mega Lucario Z — a NEW ability that halves damage from contact moves.** The
  name was briefly reported **three ways** (RotomLabs "Aura Guard", Victory Road
  "Wave Shield", Future Sight "Aura Barrier" - all renderings of the same Japanese
  string). **The official @Pokemon_Champs account settled it 2026-09-06: `Aura
  Guard`**, which is what we already pinned; Bulbapedia now carries an Aura Guard
  page. The engine keeps accepting both names (`isAuraGuardAbility`) - harmless.
  Serebii adds one mechanical detail we get for free from the Fluffy alias:
  **Long Reach moves bypass it** and deal normal damage.

## Engine work already done (2026-09-05)

1. **`SPECIES_PATCHES`** (`refresh-data.ts`) + `data/species.json`: `absolmegaz →
   Sharpness`, `garchompmegaz → Levitate`, `lucariomegaz → Aura Guard`. The dump
   ships all three with the *mainline* mega's ability (Magic Bounce / Sand Force /
   Adaptability) — all three wrong — so a bare `refresh-data` would silently revert
   them without the patch table.
2. **`MEGA_ABILITY_OVERRIDES`** (`gimmicks/mega.ts`): the same three, so
   `megaFormeAbility()` — which the calc *and* the search read — resolves correctly.
3. **Aura Guard emulation** (`damage.ts`). `@smogon/calc` knows neither name, so the
   reduction would be silently dropped. The defender's ability is aliased, per move,
   to a calc-native ability with exactly the ×0.5 we want:
   - contact + non-Fire → **Fluffy** (a FINAL modifier ⇒ exact `floor(roll/2)`, and
     Long Reach / Punching Glove / Mold Breaker interactions come free);
   - contact + Fire → **Heatproof** (Fluffy alone would cancel: ×0.5 contact × ×2 Fire
     = ×1). Gen 9 Heatproof halves the *attack stat*, so this path lands within ~2 HP
     **above** an exact halving. Documented limitation; the real ability's own
     implementation is unpublished, so the "exact" target is itself a guess.
   - non-contact → untouched (an unknown ability name is inert in the calc = ×1).
4. **Format staged additively**: `legality.allow` 208 → **212**, `items.allow`
   148 → **154**. `npm run validate-format` is green (212/154, 0 unknown).
5. **Mega-variant input**, forced by the Z formes: Absol / Garchomp / Lucario now
   have **two** legal megas each (plain + `-Mega-Z`), so a bare `o1 mega` on one of
   them is genuinely ambiguous while the held stone is unknown. The suffix-less
   forme had no typeable token, so `resolveMegaForme` now accepts
   **`base`** (/`plain`/`std`/`standard`/`normal`/`og`), the turn parser takes a
   word-length variant (`o1 mega base`, `o1 mega z`), the disambiguation error lists
   only typeable choices (`base/z`, no more `(default)`), and the TUI's `/ask`
   `+mega` suffix and `-Mega-*` strip both accept `z`. A KNOWN held stone still
   resolves a bare `o1 mega` with no suffix — that path is unchanged.
6. **`tests/regulation-m-c.test.ts`** — 19 tests: stones/species legal, every stone
   resolving to the right forme *and* ability, the Aura Guard halving on all three
   move classes, Garchomp-Z's Ground immunity, Absol-Z's Sharpness jump. Plus new
   `megaResolve` cases for the base/z tokens and a `champions-sim-ready` tripwire
   (below). Whole suite green: **1765 tests / 158 files** after the second prep pass below.
7. **`/exact` sim oracle gap (accepted)**: `@pkmn/sim` 0.10.11 — still the latest —
   predates the 2026-08-31 reveal, so it resolves the three Z formes with the
   MAINLINE abilities (Magic Bounce / Sand Force / Adaptability). Our calc path is
   correct; only the sim oracle is stale. Pinned as a `PENDING_UPSTREAM` set in
   `champions-sim-ready.test.ts` with a tripwire that fails when upstream ships the
   fix (the signal to delete the entries). Bump `@pkmn/sim` on switch-day and check.
8. **Unrelated fix caught by this work**: six `data/my-teams/TalonFlameAndyBoy.json`
   reads used a cwd-relative path, so four test files failed under `npm test` (which
   runs vitest per workspace) while passing from the repo root. They now go through
   `dataDirPath()`.

**Caveat on the early staging**: it lands while M-B is still live (to Sept 8), so the
4 new species and 6 new stones validate as legal a few days early. Same trade M-B took
(the Raichunites were pre-staged the day before) — additive-only, so nothing that *was*
legal stopped being legal.

## Prep done 2026-09-05 (second pass) — the field, the tooling, the gauntlet

Staging the format made M-C *representable*. This pass made it *playable*: the
things bring-picking needs on day one, when Pikalytics still has no M-C usage.

**1. A Reg M-C threat gauntlet** (`scripts/mcThreats.ts`). Seven hand-built
archetypes — one per new mega plus Rillaboom — using the same support cast as the
M-B threats (Incineroar / Whimsicott / Scarf Garchomp) so the two halves stay
comparable. `ALL_THREATS` = M-B's five (all still legal) + these seven, and
`mb-team-check`, `bring-matrix` and `bring-search` now run on it.

**2. A real defect the pool was hiding.** Eight of the M-B threat sets held
**Assault Vest / Choice Band / Choice Specs / Safety Goggles** — none legal in
Champions Reg M (73 non-stone items; Choice Scarf is the only Choice item). The
gauntlet had been scoring us against opponents that *cannot exist*, and that were
stronger than the real thing (AV Archaludon, Specs Gholdengo, Band Dragapult).
Substituted for legal items that keep each set's intent; `threats-legal.test.ts`
now checks species/item legality, both clauses, learnsets, abilities and EV
totals for every team in both pools. **Gauntlet baselines from before 2026-09-05
are not comparable to later ones.**

**3. `regulation-readiness.ts`** — one command, format-agnostic, for switch-day:

```
npx tsx packages/core/src/scripts/regulation-readiness.ts
```

It reports (and exits 1 on a blocker): every legal species/item resolving and
building in `@smogon/calc`; any mega forme running an **unrevealed** ability
(driven by the explicit `MEGA_ABILITY_UNREVEALED` registry in `gimmicks/mega.ts`,
not a guess — a mega keeping its base ability is common and usually correct);
`@pkmn/sim` ability parity, i.e. exactly what `/exact` will get wrong; Pikalytics
slug freshness; and threat-gauntlet legality. Today: **0 blockers, 6 warnings**,
all of them the known-pending items (2 unrevealed abilities, 3 sim divergences,
1 Pikalytics repoint).

**4. Dossier fixes — the biggest accuracy win of the pass.** `mon-dossier` is
what bring-picking reasons about for any mon without usage data, which after a
rotation is most of the field. Rebuilt to 309 entries (from 299) and fixed three
classes of defect, all pinned by `dossier-inference.test.ts`:

- **Ability biases were ignored**, so signature moves went missing entirely.
  Aerilate Salamence had *no* Double-Edge (the generic Normal-coverage penalty
  buried it), No Guard Raichu-Y had no Zap Cannon, Sharpness Absol-Z no Night
  Slash, Grassy Surge Rillaboom no Grassy Glide (dedup collapsed it into Wood
  Hammer — priority moves now get their own bucket). Added: `-ate` retyping
  (incl. Champions' Dragonize), No Guard, Sharpness / Tough Claws / Iron Fist /
  Strong Jaw / Mega Launcher / Punk Rock, Technician, auto-terrain and
  auto-weather type boosts.
- **Utilities flooded the sets.** Lucario-Mega-Z came out as six setup moves and
  one attack; Salamence-Mega ran Rest + Roost + Wish together. Sets now allow at
  most one recovery / setup / speed-control / pivot move, reserve slots for
  attacks, and rank Rest below instant recovery.
- **Megas inherited the wrong usage.** Pikalytics keys megas under the base name,
  so Garchomp-Mega-Z — a 141 SpA Levitating mono-Dragon — was being handed
  physical Garchomp's Earthquake / Rock Slide. A mega now inherits base usage
  only when its offensive orientation matches; otherwise it infers.

**5. Gauntlet baseline** (`TalonFlameAndyBoy` = the rain team, 8 meta + 12 hand,
deepen 1→5, 20 s/board, heuristic bring):

| | floor | avg |
| --- | --- | --- |
| meta (M-B usage teams) | −1108 | −411 |
| hand (M-B + M-C archetypes) | −1090 | −217 |

> **CORRECTION 2026-09-07: the per-mega numbers immediately below are not
> measuring those megas.** Seven of the twelve gauntlet teams bench their own
> mega at the heuristic top-1 bring, including Salamence, Lucario Z, Absol Z and
> Golisopod — so those four rows scored a generic goodstuff four instead. Only
> Baxcalibur, Garchomp Z, Metagross and Swampert actually brought their anchor.
> See "The benched-anchor defect" below; re-score with `--oppBringK 15` before
> quoting any of them.

The six new megas mostly land **even**: Lucario Z +42, Golisopod +10, Rillaboom
−80, Garchomp Z −113, Absol Z −115, Salamence −115. The exception is
**Mega Baxcalibur under Trick Room at −1090**, a new worst-case on par with our
existing bad matchups (the M-B meta Garchomp teams at −1044…−1108 and Mega
Swampert rain at −1071). Note the Golisopod team runs the *same* Trick Room
shell and scores +10, so it is Baxcalibur's 175 Atk doing the damage, not Trick
Room by itself.

**No bring rescues it.** Re-run with EXHAUSTIVE brings (all 15 of C(6,4)) against
a searched opp-3 response at 45 s/board: **−1074**, best bring Talonflame /
Meowscarada / Pelipper / Dragonite. So the heuristic bring was giving up only ~16
points — the matchup is genuinely bad, not a bring-selection artifact, and the
searched answer swaps Kingambit + Garchomp out for Meowscarada + Pelipper (both
of our Trick-Room-relevant slow-ish attackers are the ones that get punished).
Caveat that remains: Baxcalibur-Mega's ability is a placeholder, so its set is
provisional — re-measure on switch-day once the real ability is known.

**Not done / deliberately deferred**: no team re-tune. The rain team was built
against an M-B field and the honest re-tune needs real M-C usage, which is ~2
weeks out. `--only <anchor substring>` was added to `mb-team-check` for focused
deep dives on a single matchup at a bigger budget.

## Tactics / meta implications

- **Rillaboom** is the headline non-mega add: Grassy Surge + Grassy Glide priority.
  The `terrain` tactic detector picks it up automatically; the Grassy Terrain
  interaction with Earthquake (−50%) and the priority-Glide speed tier both already
  exist in the engine. It is a *direct* answer to the M-B rain core
  (Pelipper/Archaludon/Swampert-Mega) — expect our rain team's matchup spread to move.
- **Mega Garchomp Z vs. our Scarf Garchomp perish counter**: the Z forme is mono-Dragon
  and Levitating, so a Ground-immune Garchomp now exists on the *other* side of the
  table. The [Talonflame perish counter](final-team-playbook.md) line (Scarf Chomp EQ
  OHKOs Mega Gengar) is unaffected — it is our own Chomp, un-mega'd — but "EQ hits
  everything grounded" reads in the playbook need re-checking against a Chomp-Z.
- **Mega Lucario Z** is a 164 SpA / 151 Spe special attacker that halves contact
  damage — physical priority (Grassy Glide, Sucker Punch, Fake Out) gets much worse
  into it. Our Talonflame/Kingambit pressure is largely *contact*; check the bring
  matrix once real usage data lands.
- **Mega Golisopod** (Bug/**Steel**, 175 Def / 120 SpD, 40 Spe) is a Trick Room-shaped
  wall with a 4× Fire weakness. **Its ability is the open question** — Emergency Exit
  on a mega would be self-defeating, so assume it changes.
- **Mega Baxcalibur** 175 Atk / 115 HP Dragon/Ice — Glaive Rush + Icicle Crash off a
  87 Spe frame; another TR-friendly breaker.

## Research update 2026-09-07 (day before switch)

Swept the official channels, Serebii, Victory Road, RotomLabs, MetaVGC, Game8 and
the community-tool dexes. Net: **one open question closed, one new watch item, and
the two unrevealed abilities are still unrevealed.**

- **Aura Guard is official.** @Pokemon_Champs posted the English name and effect on
  2026-09-06 ("halving the damage of incoming attacks that make contact"). Victory
  Road's "Wave Shield" and Future Sight's "Aura Barrier" were fan translations. Our
  pin was already right; **no switch-day action**. Serebii adds that **Long Reach**
  moves bypass it — the Fluffy alias gives us that for free.
- **Golisopod-Mega / Baxcalibur-Mega abilities: STILL UNREVEALED.** Every outlet
  says the same thing ("announced on Sept 8"), and the community dexes
  (gamewith.ai, PokéBase) render their ability fields **blank** while listing the
  correct stats — which independently re-confirms our dumped lines (Golisopod-Mega
  75/150/175/70/120/40 Bug/Steel, Baxcalibur-Mega 115/175/117/105/101/87
  Dragon/Ice). Beware: search-engine summaries keep asserting **"Mega Golisopod:
  Shell Armor"** — that is a conflation with **Mega Scolipede**, which really did
  get Shell Armor in M-B. No primary source. Runbook step 3 stands unchanged.
- **NEW: Mega Heatran was teased** in the 2026-08-31 update trailer ("stay tuned for
  more details") and is *not* one of the four named species — so it is either one of
  the ~20 unnamed M-C additions or a later drop. We are not ready for it: `heatran`
  is **not** in `legality.allow` and `heatranite` is **not** in `items.allow`,
  though both exist in the dump (`heatranmega` 91/120/106/175/141/67 Fire/Steel,
  `isNonstandard: 'Future'`) carrying the **base** abilities (Flash Fire / Flame
  Body) — i.e. the same "dump ships the wrong ability" trap as every other mega.
  **Switch-day: check the in-game roster for Heatran specifically**; if it is in,
  add species + stone and pin the mega ability in both patch tables.
- **Roster counts still disagree, so trust only the in-game list.** MetaVGC now
  renders 234 entries under a "Total Pokémon: 248" header, with only the same four
  marked new; it counts formes, we count base species (212 staged). Neither number
  reconciles to 208 + 24 = 232, which is exactly why step 2 reads the game itself.
- No removals reported anywhere; the "previous sets remain eligible" line holds.

## Prep done 2026-09-07 (day before switch)

### One table, not two

A mega's Champions ability used to be pinned in TWO places with no mechanical
link: `MEGA_ABILITY_OVERRIDES` (`gimmicks/mega.ts`), which the domain reads, and
`SPECIES_PATCHES` (`refresh-data.ts`), which writes `data/species.json`. Runbook
step 3 said "pin in BOTH" — a hand-maintained invariant, on the one night of the
quarter when there is time pressure. **`MEGA_ABILITY_OVERRIDES` is now the single
source of truth**: refresh-data derives its mega patches from it, so switch-day is
one edit plus `npm run refresh-data`. Three tripwires back it up:

- `regulation-readiness` now BLOCKS when `data/species.json` disagrees with the
  table (i.e. someone pinned an ability and never re-ran refresh-data). Verified
  by deliberately breaking a pin — it fired, naming the forme and the fix.
- `tests/mega-ability-table.test.ts` pins the same invariant, plus "no forme is
  both pinned and marked unrevealed" and "refresh-data derives rather than lists".
- `megaResolve.ts` had its own private copy of `megaFormeAbility` that read the
  dump directly and ignored the override table. They agreed today only because
  the dump happened to be current. It now calls the canonical one.

Also folded the Raichu X/Y pins in, so every mega ability in the app is in that
one table, and armed `Heatran-Mega` in `MEGA_ABILITY_UNREVEALED` — inert while
Heatran is illegal, and it starts warning the moment Heatran joins the roster.

### The benched-anchor defect (found by the sensitivity sweep)

**Seven of the twelve gauntlet teams never bring the mega they are named after.**

`evaluateMatchup` does not force the anchor into the opponent's four; it takes
`scoreBrings`' top-1 bring for that side. And `scoreBrings` scores a stone holder
on its **base forme** — `bring.ts` only swaps in the mega forme once
`entry.megaUsed` is set, which happens when `/mega` is LOGGED in a live battle,
never at preview time. A held stone is a guaranteed mega, so for a side scoring
its OWN bring that is simply wrong, and it is wrong in a predictable direction:
the mons whose entire point is the mega get benched. Mega Mawile is the clearest
case — base Mawile without Huge Power really is a weak 50/85/85 mon.

```
npx tsx packages/core/src/scripts/gauntlet-anchor-check.ts
  Mega Mawile          BENCHED (rank 2/15)   Mega Metagross     BROUGHT
  Mega Raichu-X        BENCHED (rank 5/15)   Mega Swampert      BROUGHT
  Mega Blaziken        BENCHED (rank 2/15)   Mega Garchomp Z    BROUGHT
  Mega Salamence       BENCHED (rank 2/15)   Mega Baxcalibur    BROUGHT
  Mega Lucario Z       BENCHED (rank 2/15)   Rillaboom/Swampert BROUGHT
  Mega Absol Z         BENCHED (rank 6/15)
  Mega Golisopod       BENCHED (rank 2/15)
```

The failure is silent and reads like a result: a sweep over a benched mon returns
a perfectly flat line, indistinguishable from "the ability does not matter".

**NOT FIXED, deliberately.** The fix is to make `scoreBrings` resolve a held
stone to the mega forme, but that is the scorer behind OUR bring picking too —
the priority-one feature — with calibration baselines behind it
(`bring-truth*.regmb.json`, `calibrate-bring`, `analyze-bring-models`). Changing
it invalidates those and needs a re-calibration pass, not a midnight edit. What
shipped instead is detection: `gauntlet-anchor-check.ts` reports it and exits 1,
and the sensitivity sweep escalates the opponent to an exhaustive 15-bring
maximin whenever its anchor is benched, so it always measures the real mega.

### Ability sensitivity: what the two unknowns are worth

`mc-ability-sensitivity.ts` sweeps a spanning set of ability EFFECT CLASSES over
the unrevealed formes (driven by `MEGA_ABILITY_UNREVEALED`, so a forme drops out
the moment it is pinned) and reports how far our score moves. The point is to
make switch-day a lookup rather than a re-derivation. **The probe list is not a
set of predictions** — the classes are chosen to span what an ability can
mechanically do, using calc-native abilities so every number is a real search
result. And the threat SET is held fixed, so each row isolates the ability and
excludes the archetype re-tune a real reveal would enable (Speed Boost on a Trick
Room shell is the clearest case: a floor on its true impact, not an estimate).

Run 2026-09-07 vs `TalonFlameAndyBoy`, deepen 1->5, 5 s/board, opponent bring
exhaustive where the anchor was benched. Score is OURS, + favours us.

| effect class | probe | Golisopod-Mega | Baxcalibur-Mega |
| --- | --- | --- | --- |
| *placeholder* | Emergency Exit / Thermal Exchange | **-86** | **-1090** |
| combat-inert | Shell Armor | -86 | -1090 |
| offense x1.3 contact | Tough Claws | -86 | -1090 |
| offense x1.3 secondary | Sheer Force | -86 | -1090 |
| defense x0.75 vs SE | Filter | **-94** | **-1106** |
| defense x0.5 Fire/Ice | Thick Fat | **-94** | -1090 |
| entry disruption | Intimidate | -86 | -1090 |
| speed plan | Speed Boost | -86 | -1090 |
| | **envelope** | -94 .. -86 (spread 8) | -1106 .. -1090 (spread 16) |

**Both are ability-INSENSITIVE.** Whatever Champions reveals, neither matchup
moves more than ~16 points, so the placeholder baselines stand and neither needs
an emergency re-score on switch-day. Mega Baxcalibur under Trick Room stays our
worst matchup for reasons that have nothing to do with its ability — 175 Atk off
a 115 HP frame — and Mega Golisopod stays near-even because Talonflame's Flare
Blitz does 112-134% to it (4x Fire on a 75 HP frame) through almost anything.

The only class that moves either row is **damage reduction** (Filter, and Thick
Fat on Golisopod, which halves that Flare Blitz from a guaranteed OHKO to a
2HKO). If the reveal is a bulk ability, expect a small negative move; every other
class is worth nothing here.

READ THE FLAT ROWS CAREFULLY. A row at +0 means that class does not change the
searched line's OUTCOME at this budget — not that the override was ignored. The
harness was verified two ways: the non-zero Filter/Thick Fat rows prove the
mutation reaches the search, and a direct calc probe confirmed the swap
(Talonflame Flare Blitz into Golisopod-Mega: 204-244 plain, 100-124 with Thick
Fat, 153-183 with Filter). The first version of this sweep returned a perfectly
flat line for Golisopod for a completely different reason — the mon was benched
and never played — which is what turned up the defect above.

Absolute scores here are NOT comparable to the 20 s/board gauntlet baselines;
the sweep is a relative A/B at a fixed budget, which is the only claim it makes.

### Also shipped

- `switch-regulation.ts` — runs the five mechanical runbook steps in order,
  stopping at the first failure and gating the verdict on `regulation-readiness`
  exiting 0. It prints the three judgement steps it deliberately does NOT do
  (roster paste, ability pin, Pikalytics repoint) rather than pretending to.
- A cloud routine (`trig_01UfqkR9Luyi365bwcfDACVq`) fires every 6h from Sept 9
  03:00 UTC through Sept 14, researches the two abilities under explicit sourcing
  rules, and opens a PR if and only if it clears the bar. It bails early once the
  formes leave `MEGA_ABILITY_UNREVEALED`.

### Checked, nothing to do

- `@pkmn/dex`, `@pkmn/sim`, `@pkmn/data` are all on 0.10.11 (latest) and
  `@smogon/calc` on 0.11.0. The sim still predates the 2026-08-31 Z-mega reveal,
  so the three `/exact` divergences stand — bump and re-check on switch-day.
- Upstream `@pkmn/dex` HAS caught up on the M-B abilities (Electric Surge, No
  Guard, Fire Mane, Eelevate, Shell Armor all come from the raw dex now), so the
  M-B half of the override table is redundant today. Keeping it: it costs nothing
  and a dump regression would otherwise be silent.

## Switch-day runbook (Sept 8, 2026, 19:00 PDT)

Steps 1, 3–7 are the M-B runbook verbatim; **step 2 is the real work.**

1. `npm run refresh-data` — pull the updated `@pkmn/dex` (bump first if needed:
   `npm i @pkmn/dex@latest -w @pokechamps/core`). Verify the `patched species.json/…`
   lines print for all six mega patches (three M-C + the M-B set).
2. **Stage the full roster.** Open the in-game list (Recruit → Recruit Pokémon →
   Roster Info → Pokémon Featured in This Roster), paste it into the staging helper,
   and paste its output between the `[ ]` of `"legality": { "allow": [ … ] }`:

   ```
   npx tsx packages/core/src/scripts/stage-roster.ts --mode replace
   ```

   `--mode replace` also reports **removals** — expect none, but check. The ~20
   unnamed additions land here — **watch for Heatran** (teased 2026-08-31; needs
   `heatran` + `heatranite` + a mega-ability pin if it is in). Then confirm `items.allow`
   in; add anything else the official item list introduces) and update `__notes`.
3. **Pin the two unrevealed mega abilities** — Golisopod-Mega and Baxcalibur-Mega —
   in `MEGA_ABILITY_OVERRIDES` (`gimmicks/mega.ts`) and drop them from
   `MEGA_ABILITY_UNREVEALED` in the same edit. **That is now the ONLY table** —
   refresh-data derives `data/species.json`'s patches from it (changed 2026-09-07),
   so step 1 materializes the pin and `regulation-readiness` blocks if you skip it.
   If either ability is a *custom* effect that touches damage, it needs an emulation
   in `damage.ts` like Aura Guard / Fire Mane / Dragonize — a name @smogon/calc does
   not know is silently inert, so the pin alone does nothing.
   Lucario-Mega-Z's name is settled (`Aura Guard`, official) — no action there.
   Then re-measure that matchup: the sensitivity envelope says how much it moves.
4. `npm run validate-format` — every id must resolve.
5. Pikalytics: repoint `CHAMPIONS_PIKA_FORMAT` in `packages/core/src/domain/data.ts`
   to `gen9championsvgc2026regmc` (the server's `pikalytics/cache.ts` mirrors the
   constant — update both), then `npm run refresh-pikalytics`. **Expect no usage data
   for ~2 weeks** post-launch; until then the gauntlet keeps running on the M-B dump.
   Re-verify the `/ai` export layout — it has degraded once already (M-B: usage `N/A`,
   teammates `undefined%`, blank nature).
6. `npx tsx packages/core/src/scripts/tactics-catalog.ts` — regenerate the combo
   catalog over the new legal lists (Rillaboom grassy cores, the new megas).
   (steps 1, 4, 6, 7 and the readiness gate all run in order via
   `npx tsx packages/core/src/scripts/switch-regulation.ts --with-tests`.)
7. `npx tsx packages/core/src/scripts/smoketest.ts` + `npm test`. Then sanity-check a
   Mega Lucario Z contact halving and a Mega Absol Z Night Slash against the
   Pikalytics calc.
8. **Team re-tune** — the M-B final team (`rain-mb-final`) was built against an
   M-B field. Re-run `npx tsx packages/core/src/scripts/mb-hill-climb.ts` / the gauntlet once M-C usage data
   exists; Rillaboom into our rain core is the specific thing to measure.

## Open questions (resolve on switch-day)

- The ~20 unnamed new species.
- Golisopod-Mega + Baxcalibur-Mega abilities. **Measured 2026-09-07 as low-stakes**
  for us either way (envelopes of 8 and 16 points) — pin them on switch-day for
  correctness, but neither reveal forces a re-tune. See the sensitivity table above.
- Whether Aura Guard's halving is a final modifier or a BP/attack modifier (we
  assume final, via the Fluffy alias).
- Whether the announced Garchomp-Mega-Z typing is really mono-Dragon: our dump,
  Serebii and RotomLabs' dex all say **Dragon**; RotomLabs' *article* says
  "Dragon/Ground". Ground-immune-via-Levitate only makes sense on the mono read, and
  that is what the app uses.

Sources: [pokemon.com — Get Ready for Regulation Set M-C](https://www.pokemon.com/us/news/get-ready-for-regulation-set-m-c-in-pokemon-champions),
[Serebii M-C](https://www.serebii.net/pokemonchampions/rankedbattle/regulationm-c.shtml),
[Victory Road — Champions regulations](https://victoryroad.pro/champions-regulations/),
[MetaVGC M-C](https://metavgc.com/regulations/regulationm-c),
[RotomLabs — Z mega abilities revealed](https://rotomlabs.net/article/abilities-revealed-for-mega-absol-z-mega-lucario-z-and-mega-garchomp-z),
[RotomLabs dex — Mega Garchomp Z](https://rotomlabs.net/dex/mega-dimension/garchomp/mega-z),
[Game8 — M-C roster and schedule](https://game8.co/games/Pokemon-Champions/archives/618064).
Added 2026-09-07: [@Pokemon_Champs — Aura Guard](https://x.com/Pokemon_Champs/status/2095572534347301014),
[Nintendo Life — Mega Heatran teased](https://www.nintendolife.com/news/2026/08/pokemon-champions-update-adds-z-mega-evolutions-this-september),
[Game Rant — Golisopod/Baxcalibur abilities announced Sept 8](https://gamerant.com/pokemon-mega-golisopod-baxcalibur-september-8/).
