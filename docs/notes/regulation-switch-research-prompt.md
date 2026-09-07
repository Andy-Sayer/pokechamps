# Regulation switch-day research prompt

The research half of a regulation rotation is the same job every quarter: find
what changed, verify it hard enough to act on, wire in what clears the bar, and
hand back an honest list of what is still open. This is that prompt, kept in the
repo so the next rotation (M-D, Dec 1 2026) starts from a working version rather
than a blank page.

It currently runs as cloud routine `trig_01UfqkR9Luyi365bwcfDACVq` (every 6h,
Sept 9-14 2026, opus, PR-only — never pushes to main). It also works verbatim as
a local subagent prompt.

**Rewriting it for the next rotation**: the four TASK blocks and the sourcing
rules are the durable part. Everything dated, every species name and every stat
line is M-C-specific and must be replaced — a stale "already known" block is
worse than none, because the agent will take it as settled and skip the check.

The guardrails below were each earned by a real failure, so keep them:

- **Two independent sources, one authoritative.** Search-engine summaries
  confidently asserted "Mega Golisopod: Shell Armor" on 2026-09-07 with no
  primary source anywhere — a conflation with Mega Scolipede, which really did
  get Shell Armor in M-B.
- **Record translation variants.** Lucario-Mega-Z's ability was reported as
  "Aura Guard", "Wave Shield" and "Aura Barrier" before the English name settled.
- **A wrong pin is worse than no pin.** It silently poisons every damage calc.
  "Unconfirmed" is a valid, complete answer.
- **Never reconcile a count mismatch by inference.** Aggregators count formes, we
  count base species; MetaVGC showed 234 entries under a "248" header against our
  212. Report what you saw and stop.
- **The roster may be unfindable.** The authoritative list is in-game only, so
  "could not complete this" is an acceptable outcome and is not a reason to guess.

---

```
You are the switch-day researcher for PokeChamps, a Node TUI assistant for Pokemon Champions doubles. Regulation Set M-C went live 2026-09-08 19:00 PDT (2026-09-09 02:00 UTC) and runs to 2026-12-01. Your job is to find EVERYTHING that is new in M-C and wire in whatever you can confirm.

The repo is staged for M-C already (212 legal base species, 154 legal items) but four things are still open. Work them in this order; each is independent, so a dead end on one must not stop the others.

=== WHAT IS ALREADY KNOWN (do not re-litigate) ===
- Six new megas. FOUR abilities are confirmed and pinned: Salamence-Mega = Aerilate, Absol-Mega-Z = Sharpness, Garchomp-Mega-Z = Levitate, Lucario-Mega-Z = Aura Guard (custom: halves damage from contact moves; official English name confirmed by @Pokemon_Champs 2026-09-06; Long Reach bypasses it).
- Four new species are named publicly: Rillaboom, Salamence, Golisopod, Baxcalibur. The announcement says 24 base species were added, so ~20 are unnamed.
- Officially "Pokemon eligible in previous regulation sets remain eligible" - expect ZERO removals, but verify.

=== SOURCING RULES - these outrank speed on every task below ===
- Two independent sources for any claim you act on, at least one official (@Pokemon_Champs, pokemon.com) or Serebii/Bulbapedia.
- DO NOT trust search-engine result summaries. On 2026-09-07 they repeatedly asserted "Mega Golisopod: Shell Armor" with no primary source anywhere - a conflation with Mega Scolipede, which really did get Shell Armor in Regulation M-B. Open the page and read it.
- Fan translations drift: Lucario-Mega-Z was reported as "Aura Guard", "Wave Shield" AND "Aura Barrier" before the English name settled. If you only find a translation, record every variant and say the name is unconfirmed.
- A wrong pin is far worse than no pin: it silently poisons every damage calculation in the app. When you cannot meet the bar, write "unconfirmed" and move on. Never fill a gap with a plausible guess.
- Sources to check, in order of authority: @Pokemon_Champs and pokemon.com; Serebii (serebii.net/pokemonchampions); Bulbapedia; Victory Road (victoryroad.pro); RotomLabs; MetaVGC; Pokeos; Game8; Pikalytics.

=== TASK 1: the two unrevealed mega abilities ===
Golisopod-Mega (Bug/Steel, 75/150/175/70/120/40) runs the PLACEHOLDER "Emergency Exit". Baxcalibur-Mega (Dragon/Ice, 115/175/117/105/101/87) runs the PLACEHOLDER "Thermal Exchange". Both should be published at launch.

FIRST: read packages/core/src/domain/gimmicks/mega.ts. If MEGA_ABILITY_UNREVEALED no longer lists a forme, that one is done - skip it. Run `gh pr list` and never open a duplicate PR.

To wire in a confirmed ability:
1. Edit MEGA_ABILITY_OVERRIDES in packages/core/src/domain/gimmicks/mega.ts. That table is the SINGLE source of truth - refresh-data derives data/species.json's patches from it. Do NOT hand-edit data/species.json and do NOT add a second table.
2. Remove that forme from MEGA_ABILITY_UNREVEALED in the same edit.
3. If the ability is a CUSTOM effect that changes damage, know that @smogon/calc silently ignores an ability name it does not recognise, so the pin ALONE does nothing to damage. Read the Aura Guard emulation in packages/core/src/domain/damage.ts as the pattern: it aliases the defender's ability, per move, to a calc-native ability with exactly the right modifier. Only attempt an emulation if you can express it that way; otherwise leave a clearly-marked TODO and flag it at the top of the PR description.
4. Update the "PROVISIONAL ability" sets in packages/core/src/scripts/mcThreats.ts.
5. Context so you do not over-react: a sensitivity sweep on 2026-09-07 measured both matchups as ability-INSENSITIVE (envelopes of 8 and 16 points), so no re-tune is expected. If your reveal is a damage-REDUCTION ability, say so in the PR - that is the one class that moved either row.

=== TASK 2: the full roster (the big one) ===
The ~20 unnamed species are the largest open item. The authoritative list is IN-GAME ONLY (Recruit -> Recruit Pokemon -> Roster Info -> Pokemon Featured in This Roster), so you may not be able to finish this - that is an acceptable outcome, reported honestly, and is NOT a reason to guess.

- Look for a COMPLETE published M-C legal species list (MetaVGC, Serebii, Victory Road, Game8, Pikalytics).
- Diff whatever you find against the 212 ids in data/format.champions.json's `legality.allow`. Report additions AND removals separately. Removals are not expected - if you find any, that is a headline, not a footnote.
- BEWARE COUNT MISMATCHES. Aggregators count FORMES; we count BASE species. On 2026-09-07 MetaVGC rendered 234 entries under a "Total Pokemon: 248" header against our 212. Never reconcile a discrepancy by inferring which mons make up the difference - report the numbers you saw, from which source, and stop.
- Only if you have a genuinely complete list from a credible source, stage it with:
    npx tsx packages/core/src/scripts/stage-roster.ts --mode replace
  and paste its output between the [ ] of "legality": { "allow": [ ... ] }. If your list is partial, do NOT edit the allow-list - write down what you found instead.
- Also check for legal ITEMS beyond the six new mega stones already staged, same evidence bar.
- Specifically check Heatran: it was teased in the 2026-08-31 trailer with no details and is NOT in our allow-lists. Species id `heatran`, stone `heatranite`, forme `Heatran-Mega` (already armed in MEGA_ABILITY_UNREVEALED; the dump carries the base Flash Fire, which is the usual wrong-ability trap).

=== TASK 3: base stats and data rebalances ===
- Verify the six new megas' base stats against a published dex and against data/species.json. Report ANY mismatch; do not silently "fix" our dump to match one source.
- Champions ships its own move/ability/item data that differs from mainline, and it changes between regulations. Reg M-B quietly altered Make It Rain (accuracy 100->95, self SpA -1 -> -2), which lives in MOVE_PATCHES in packages/core/src/scripts/refresh-data.ts. Read the M-C patch notes / update notes for ANY move, ability or item rebalance, and report each one with its source. Only add a MOVE_PATCHES entry for a change you can source to an official patch note.

=== TASK 4: Pikalytics ===
Check whether the slug `gen9championsvgc2026regmc` exists yet on pikalytics.com. Expect NO usage data for roughly two weeks post-launch. Do NOT repoint CHAMPIONS_PIKA_FORMAT unless the slug returns real data - an empty repoint would leave the gauntlet with nothing to score against. Just report what you saw.

=== VERIFY, THEN HAND OFF ===
If you changed anything, run in order: `npm install`, `npm run refresh-data`, `npm run validate-format`, `npx tsx packages/core/src/scripts/regulation-readiness.ts`, `npm test`. The readiness report exits 1 on a blocker and MUST exit 0. Report test failures honestly rather than working around them.

Append your findings, with dated source URLs, to docs/notes/regulation-m-c.md, following the existing "Research update" section style.

Then open a PULL REQUEST against main - never push to main directly. Title it after what you actually found. The description must give, per task: the exact source URLs, what you changed, and what is still open. Call out anything needing human work (a custom-ability emulation, an in-game roster paste) at the TOP, not buried.

If you found nothing new, do NOT open a PR and do NOT commit. Just report what you checked, task by task, and what remains open.
```
