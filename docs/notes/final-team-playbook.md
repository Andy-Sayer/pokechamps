# Final Team Playbook — Reg M‑B (rain‑mb)

*Data‑derived (gauntlet Nash + deep best‑play validation + played‑out traces). Not opinion — every claim traces to a sim result. Generated 2026‑07‑01.*

## The team (spreads playout‑refined 2026‑07‑01 — see "Spread & move refinement" below)

| Mon | Item | Ability | Nature | EVs | Moves |
|---|---|---|---|---|---|
| **Talonflame** | — (itemless) | Gale Wings | Impish | 220 HP / 108 Atk / 188 Spe | Acrobatics / Tailwind / Flare Blitz / Protect |
| **Pelipper** | Damp Rock | Drizzle | Timid | 252 HP / 124 SpA / 140 Spe (SP 32/16/18) | Hurricane / Weather Ball / Tailwind / **Protect** |
| **Garchomp** | Choice Scarf | Rough Skin | Adamant | 76 HP / 100 Atk / 84 SpD / 252 Spe | Earthquake / Rock Slide / Dragon Claw / Stomping Tantrum |
| **Kingambit** | Chople Berry | Defiant | Adamant | 236 HP / 252 Atk / 20 Spe | Kowtow Cleave / Sucker Punch / Iron Head / Swords Dance |
| **Dragonite** | Dragoninite (mega) | Multiscale | Modest | 156 HP / 252 SpA / 100 Spe | Hurricane / Draco Meteor / Dragon Pulse / Protect |
| **Meowscarada** | Focus Sash | Protean | Jolly | 204 HP / 60 Atk / 252 Spe | Flower Trick / Knock Off / U‑turn / Protect |

## Spread & move refinement (playout‑validated 2026‑07‑01)
optimize‑spreads proposed changes to all 6; `attribute-spread` (real @pkmn/sim games) **adopted only the load‑bearing subset** — Talonflame/Garchomp/Meowscarada shifted toward bulk while keeping Speed, lifting the gauntlet **floor 0→50%, avg 73→86%**. Kingambit's and Dragonite's proposed changes were **rejected** (lost games) → kept at baseline. Pelipper: **Timid 18/16 speed‑creep** (Speed 113) beat the 0‑Speed max‑SpA default (43% vs 20% avg) — flips the Swampert rain mirror (0→7/8) and sweeps Metagross; Timid > Modest. **Wide Guard → Protect** (Protect 57% vs WG 48% overall; WG only wins the Swampert rain mirror via blocking Muddy Water — a rain‑mirror tech tradeoff). Dropping Pelipper's Tailwind (let Talonflame carry it) was **tested and declined** — Tailwind is load‑bearing in the many Talonflame‑less brings (Raichu 100→83 without it).

## Why this team (the bake‑off)

Chosen over anti‑meta‑mb and an optimized deception team (fakeperish‑opt) by the data:
- **Highest coverage** across the full 17‑opponent gauntlet (Nash avg ~60%).
- **8/8 under deep best‑play validation** on the contested offense meta (Raichu, Blaziken, Metagross, Sneasler) — the Nash floors were pessimistic; best play converts them.
- **Wins the *common* differentiators** (Sneasler #11 usage, the rain mirror) that the alternatives lost; structurally owns Sneasler via **Garchomp + Talonflame** (the load‑bearing answer the alternatives lacked).
- Its only losses are to **rare** weather teams (Ninetales‑Alola, Torkoal — not top‑20 usage) → a targeted‑patch problem, not a reason to switch base.

## In‑battle tactics (extracted from deep‑play traces)

**General themes (recurring across winning games):**
1. **Mega Dragonite is the primary win condition.** Multiscale tanks a hit; it megas turn 2–3 once the board opens, then Hurricane / Draco Meteor sweeps. It closed the Sneasler and Swampert games.
2. **Rain‑boosted Pelipper Weather Ball** is the nuke vs Steel (one‑shot‑range on Mega Metagross) and the weather‑war tool in the rain mirror.
3. **Focus‑fire the support turn 1.** Scarf Garchomp + Talonflame double‑target the enabler (Whimsicott/Tailwind/redirection) to remove it before it snowballs — won the Raichu game on turn 1.
4. **Kingambit Sucker Punch** mops priority‑vulnerable fast threats (Dragapult); Defiant punishes the Intimidate‑heavy meta (Incineroar).
5. **Talonflame Protect / Tailwind turn 1** scouts and buys the Dragonite mega set‑up; Tailwind flips the speed war vs faster teams.

**Per key matchup (the actual line that won):**
- **Sneasler (WIN):** lead Dragonite; Talonflame Protect turn 1 to scout, mega Dragonite turn 2 → Hurricane OHKOs Sneasler; Dragonite Draco/Hurricane cleans Garchomp → Kingambit → Whimsicott. Dragonite carries it.
- **Mega Metagross (WIN):** Kingambit pivots in to eat the EQ; **Pelipper rain Weather Ball 2‑shots Metagross**; Kingambit Sucker Punch removes Dragapult, Pelipper Hurricane finishes Talonflame.
- **Mega Raichu‑X (WIN):** turn‑1 **Garchomp EQ + Talonflame Flare Blitz focus‑KO Whimsicott** (kill the Tailwind/support); grind through with Garchomp EQ + Dragonite Draco.
- **Mega Swampert / rain mirror (WIN):** win the weather war — **Pelipper Weather Ball KOs their Swampert**; then mega Dragonite Draco/Hurricane sweeps Pelipper → Incineroar → Archaludon. (Coin‑flip on the Nash sheet, but a clean winning line exists.)

**Ninetales‑Alola — the hard one, but WINNABLE (~50% with the right bring, deep‑probed 2026‑07‑01):** originally read as an auto‑loss (0/4) — but that used a Garchomp bring with **no Pelipper**. The deep probe found the real answer:
- **Bring Pelipper, drop (or hide) Garchomp.** Pelipper's Drizzle **overrides Snow Warning** → no Aurora Veil (needs snow), Blizzard back to 70% acc. Garchomp is the 4×‑Ice liability that hands Ninetales a free Blizzard KO — the bring **Pelipper/Kingambit/Dragonite/Meowscarada** (no Garchomp) went **2/4**; **Pelipper/Garchomp/Kingambit/Dragonite went 0/4** even with rain up. So rain‑override is necessary but *not sufficient* — you must also not feed the 4× weakness.
- **The winning line:** Pelipper leads → **Tailwind + Drizzle** (rain up, speed up); **rain‑boosted Weather Ball KOs the frail Ninetales**; Kingambit/Dragonite trade into the rest; Mega Dragonite Hurricane cleans Whimsicott. In the Garchomp variant, lead Pelipper and **pivot Garchomp in behind the rain** so it never eats a turn‑1 Blizzard.
- **Verdict:** ~50% coin‑flip, not a loss. The residual ~50% is the leftover Ice weakness (Blizzard high‑rolls, Whimsicott Moonblast). Pushing *past* 50% still wants a species‑level patch (a non‑Ice‑weak / faster‑SE answer) — the open follow‑up — but it is no longer a free loss.

**Focus Sash Whimsicott:** Sash only saves at full HP → **break it, then KO.** Either same‑turn double‑target (Garchomp EQ + Talonflame Flare Blitz, as in the Raichu game) or two hits over consecutive turns (Gale Wings **priority Acrobatics** ×2). The search does this automatically; Talonflame's priority is the clean closer.

## Perish trap — the counter for THIS team (sim‑verified 2026‑07‑29)

Lost a live game to Mega Gengar + Blastoise on 2026‑07‑28. Every line below is
resolved through `@pkmn/sim` with the team's real spreads —
`packages/core/src/scripts/talonflame-perish-counter.ts`, pinned by
`talonflame-perish-counter.test.ts` (11/11).

**The team cannot escape a trap, so it must deny the song.** One pivot on the
roster (Meowscarada's U‑turn), no Shed Shell, no Ghost, no Taunt, no Soundproof.
Five of six mons are simply dead once Shadow Tag is on them.

**The answer is Garchomp, and it is not close.**

| Line | Result |
|---|---|
| **Scarf Garchomp Earthquake → Gengar** | **OHKO on 16/16 seeds, even through the mega.** Scarf 231 outspeeds Mega Gengar's 200, and Ground is 2× on Poison |
| …with **Talonflame / Pelipper / Dragonite** beside it | partner took damage on **0/16** — all three are Flying, so the spread is free |
| Talonflame **Acrobatics + Meowscarada Knock Off** | KO **16/16** before the song, base *or* already‑mega. Gale Wings makes Acrobatics **+1 priority**, so it beats the song without winning the speed race |
| Talonflame Acrobatics **alone** | leaves Gengar on **12%** and the song lands — it needs the second attacker |
| Meowscarada **U‑turn** under Shadow Tag | real escape, clears the count. The team's **only** one |
| Tailwind up | Meowscarada then moves before Mega Gengar |

**The bitter irony of the loss: the Garchomp that got trapped and killed is the
team's cleanest answer to the trap.** Choice‑locked into Earthquake is not the
problem it looks like — Earthquake is exactly the move that kills the Gengar.
The mistake was leaving it in *beside* the threat instead of pointing it *at* it.

**Two things that look like counters and are not:**
- **Knock Off does not remove Gengarite.** A mega stone is not knockable, so do
  not plan around stripping it — Gengar still held the stone afterwards.
- **Sucker Punch fails into Perish Song.** The song is a status move, so
  Kingambit's priority does nothing about it (`|-fail|p1a: Kingambit`).

### …unless they Fake Out (sim‑verified, `perish-fakeout.ts`, 7/7)

The turn‑1 answer has **two independent failure modes**, and the standard Fake Out
lead — **Incineroar** — brings both:

| Threat | What it breaks | Evidence |
|---|---|---|
| **Fake Out** (+3) | the Earthquake **happening** — beats the Scarf *and* Gale Wings | Garchomp flinched, Earthquake never used, song landed free |
| **Intimidate** (−1) | the Earthquake **killing** — becomes a NEAR‑kill | **1/16** KO; survivors on **1–16%**, alive and still able to sing |

**Garchomp cannot even Protect the flinch** — its four moves are Rock Slide /
Earthquake / Dragon Claw / Iron Head. There is no Protect on it. Talonflame does
carry one and blocks the Fake Out, but Protect does nothing about the *song*.

**Two fixes, both 16/16 through the Intimidate:**
- **FIX A — Earthquake + Talonflame Acrobatics.** The leftover 1–16% is exactly
  what Acrobatics covers.
- **FIX B — Kingambit Kowtow Cleave, alone.** **Defiant answers an Attack drop
  with +2, so Incineroar's own Intimidate leaves Kingambit at a net +1.** Kowtow
  is Dark (2× on Ghost). Kingambit is the one mon on the roster that *wants* to be
  Intimidated — consider it the lead into any Fake Out core.

**The adapted plan — Fake Out DELAYS the answer, it does not beat it:**

| Turn | Do |
|---|---|
| **T1** | Eat the Fake Out. The song lands; accept it |
| **T2** | **Kill the trapper** (EQ + Acrobatics, or Kingambit alone) |
| **T3** | **Switch the perished mons out** — Shadow Tag died with its owner, so the door is open and switching wipes the count |

Verified end to end: song T1, trapper dead T2, both counts cleared on T3, **nobody
dies**.

#### The stall line — and the exact odds

Assume they play it properly and **Protect the trapper on T2** to burn the kill turn.
The clock is: song lands T1 (count 3) → 2 → 1 → **faint at end of T4**. Survival is
therefore *exactly* "was the trapper dead by T3" — if it is alive at the start of T4 I
am still trapped for that turn's choice, and the count runs out.

| Their T3 | Trapper dead by T3 | I lose the mon |
|---|---|---|
| Protect again | **28/40 (70%)** | **30%** |
| anything else | 40/40 (100%) | 0% |

So a T2 Protect does **not** beat the plan, but it spends the whole margin: the kill has
to land on T3, and their repeat‑Protect succeeding is a straight **30% loss**. Consecutive
Protect is what saves this — it fails most of the time, which is the only reason 70%
rather than 0%.

**Practical read: the moment the song lands, the trapper's Protect is the only thing that
can still kill you. Kill it on T2 if it is exposed; never spend T2 on anything else.**

#### Priority order — Sucker Punch does NOT beat Fake Out

| Move | Priority |
|---|---|
| Protect | **+4** |
| Fake Out | **+3** |
| Sucker Punch | +1 |
| Acrobatics (Gale Wings) | +1 |
| Perish Song / Earthquake / U‑turn | 0 |

Kingambit's Sucker Punch is **two brackets below** Fake Out, so it gets flinched before
it ever resolves (`Incineroar:Fake Out → Kingambit:flinch → Gengar:Perish Song`). And it
would fail into the song anyway, being a status move. **Protect at +4 is the only thing
on this team that outruns a Fake Out.**

#### If the partner gets Fake Outed — what Talonflame does alone

Talonflame at −1 from Intimidate, hitting Mega Gengar by itself:

| Move | KO | Gengar left on |
|---|---|---|
| Acrobatics | 2/40 | **51–60%** |
| Flare Blitz | 1/40 | **41–56%** |

Neither is close. Flare Blitz hits harder but costs recoil and loses Gale Wings priority
once Talonflame is off full HP. **A flinched partner means the song lands — do not try to
race it; go to the T2 kill / T3 switch plan instead.**

**Rule of thumb:** if a Gengar is on the field, Garchomp clicks Earthquake with a
Flying partner out. Do **not** spend the turn KOing the body in front of it — the
KO opens the slot and they put the trapper back (see `docs/notes/tactics.md`).

## Bring guide (Nash‑optimal, per opponent)

Vary the bring across games (the mix) so you can't be counter‑brought. Hardest → easiest:

| vs | Nash | Bring (favorite → alternates) |
|---|---:|---|
| Torkoal (sun) | 16% | Pelipper/Garchomp/Kingambit/Meowscarada · +Talonflame/Dragonite variants |
| Ninetales‑Alola | ~50%† | **Pelipper/Kingambit/Dragonite/Meowscarada** (NOT Garchomp — deep‑probe correction) |
| Pelipper (rain) | 26% | Talonflame/Pelipper/Garchomp/Dragonite |
| Sylveon | 26% | Talonflame/Pelipper/Garchomp/Dragonite |
| Garchomp mirror | 31% | Garchomp/Kingambit/Dragonite/Meowscarada |
| Swampert (rain mirror) | 35% | Talonflame/Garchomp/Dragonite/Meowscarada · or Pelipper/Kingambit/Dragonite/Meowscarada |
| **Sneasler** | 50% | **Garchomp/Kingambit/Dragonite/Meowscarada** |
| Mega Mawile | 64% | Pelipper/Kingambit/Dragonite/Meowscarada |
| Raichu‑X | 65% | Talonflame/Garchomp/Kingambit/Dragonite |
| Mawile | 75% | Pelipper/Kingambit/Dragonite/Meowscarada |
| Gholdengo | 81% | Pelipper/Garchomp/Kingambit/Dragonite |
| Blaziken+Anni | 81% | Pelipper/Garchomp/Kingambit/Dragonite (mix, see sheet) |
| Incineroar | 81% | Pelipper/Kingambit/Dragonite/Meowscarada |
| Mega Metagross | 84% | Pelipper/Kingambit/Dragonite/Meowscarada |
| Sinistcha | 90% | Pelipper/Kingambit/Dragonite/Meowscarada |
| Maushold | 100% | Talonflame/Garchomp/Kingambit/Dragonite |
| Annihilape | 100% | Talonflame/Pelipper/Kingambit/Meowscarada |

**Backbone:** Kingambit + Dragonite in almost every bring. Garchomp/Meowscarada come in vs grounded/physical threats and Sneasler; Pelipper leads when you want rain up; Talonflame for Tailwind vs faster teams.

*Nash numbers are the adversarial floor (opponent counter‑brings + plays optimally); real‑ladder and best‑play win‑rates run meaningfully higher, as the deep validation confirmed (e.g. Sylveon 26% Nash → 2/2 under best play; Ninetales 19% Nash → ~50% deep with the corrected bring). †Ninetales' shallow‑Nash over‑weighted the Garchomp bring that loses; the Meowscarada bring is the deep‑validated answer.*

## Honest re‑validation on the FIXED engine (2026‑07‑02)
The original validation ran on a **broken engine** — three bugs found + fixed this pass: (1) the opponent policy was fed swapped args and played GREEDY, not searching (commit e4367c7); (2) the greedy fallback was type‑blind, clicking immune moves (992dad0); (3) the search budget was wall‑clock (non‑reproducible) — added a deterministic node‑budget mode (db0779a) and a pooled deterministic validator (`det-check`, d70289b). Almost every "result" before this was an artifact.

**Reproducible symmetric‑fair profile (both sides equal node budget, det‑check):**
- **Offense meta — dominant:** Sneasler 100%, Raichu 100%, Blaziken 100%, **Metagross 75%** (the earlier "Metagross soft spot" was a depth‑2‑opponent artifact — 83% flat 0.5M/1M/2M).
- **Bulky rain (Swampert) — GENUINE 0/4 loss.** NOT Rillaboom (never brought), NOT a bring artifact (0/4 even with Meowscarada's Grass 4×). Replay‑confirmed mechanism: their **Swampert runs Ice Punch = 4× OHKO on Dragonite** (our wincon), and **Incineroar removes Meowscarada** (our Grass answer) — both breakers hard‑countered.
- **Ninetales (Ice) — ~25%**, the rarer long‑known soft spot.

**Verdict: rain‑mb‑final is a top‑tier OFFENSE team with a real WEATHER weakness (bulky rain + hail).** No structural offense hole. The Swampert fix (deferred/banked 2026‑07‑02) would be a breaker that isn't Ice‑4×‑frail and doesn't fold to Intimidate, or a second win condition that isn't Dragonite — a specific, now‑honestly‑testable problem. Also: `scoreBrings` mis‑picks the weather cells (leaves Meowscarada home vs Swampert, force‑drops Garchomp vs Ninetales) — the bring guide should override it there.

## Ninetales patch — hunted, no clean swap (2026‑07‑01)
Deep‑sim‑tested 6 candidates (Steel: Gholdengo/Archaludon/Metagross × 2 slots; Sableye Prankster‑Rain/Light‑Screen × 2 slots). Findings: Kingambit‑slot swaps break Sneasler (its priority is load‑bearing); of the Meowscarada‑slot swaps, only Gholdengo edged the Ninetales baseline (33% vs 17%) — a 1‑game/6 difference (noise) that costs Meowscarada's whole‑meta utility. Sableye flopped (Pelipper already sets rain → its Rain Dance is redundant, and losing the offense outweighs Light Screen). **Verdict: no worthwhile patch — the team is a tight optimum.** Ninetales stays a **piloted ~coin‑flip**, not a slot swap: lead Pelipper (rain overrides snow), don't bring Garchomp (4× Blizzard), race it down. It's rare (not top‑20 usage), so it's an acceptable soft spot. **Build the team as‑is.**
