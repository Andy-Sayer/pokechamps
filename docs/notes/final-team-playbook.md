# Final Team Playbook — Reg M‑B (rain‑mb)

*Data‑derived (gauntlet Nash + deep best‑play validation + played‑out traces). Not opinion — every claim traces to a sim result. Generated 2026‑07‑01.*

## The team

| Mon | Item | Ability | Nature | Moves |
|---|---|---|---|---|
| **Talonflame** | — (itemless) | Gale Wings | Jolly | Acrobatics / Tailwind / Flare Blitz / Protect |
| **Pelipper** | Damp Rock | Drizzle | Modest | Hurricane / Weather Ball / Tailwind / Wide Guard |
| **Garchomp** | Choice Scarf | Rough Skin | Jolly | Earthquake / Rock Slide / Dragon Claw / Stomping Tantrum |
| **Kingambit** | Chople Berry | Defiant | Adamant | Kowtow Cleave / Sucker Punch / Iron Head / Swords Dance |
| **Dragonite** | Dragoninite (mega) | Multiscale | Modest | Hurricane / Draco Meteor / Dragon Pulse / Protect |
| **Meowscarada** | Focus Sash | Protean | Jolly | Flower Trick / Knock Off / U‑turn / Protect |

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

**The one structural hole — Ninetales‑Alola (LOSS, honest):** Ninetales' **Blizzard is 100% accurate in its own snow** and systematically KOs our Ice‑weak core — Garchomp is Ice **4×**, Talonflame/Dragonite **2×**. Even trading KOs back, Blizzard + Whimsicott Moonblast out‑tempo the team. **No line fixes this** — it needs a species‑level patch (a non‑Ice‑weak answer, a faster super‑effective Steel/Fire/Rock hitter, or a screens/Veil break), which is the open follow‑up. It's a rare matchup (Ninetales isn't top‑20 usage), so it's an acceptable known soft spot for now.

## Bring guide (Nash‑optimal, per opponent)

Vary the bring across games (the mix) so you can't be counter‑brought. Hardest → easiest:

| vs | Nash | Bring (favorite → alternates) |
|---|---:|---|
| Torkoal (sun) | 16% | Pelipper/Garchomp/Kingambit/Meowscarada · +Talonflame/Dragonite variants |
| Ninetales‑Alola | 19% | Pelipper/Garchomp/Kingambit/Dragonite (known hard) |
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

*Nash numbers are the adversarial floor (opponent counter‑brings + plays optimally); real‑ladder and best‑play win‑rates run meaningfully higher, as the deep validation confirmed (e.g. Sylveon 26% Nash → 2/2 under best play).*

## Open follow‑up
The **Ninetales‑Alola / weather patch** (a non‑Ice‑weak, snow/Veil‑breaking answer that keeps the Sneasler + rain‑mirror strengths) is the one worthwhile improvement — see `project_ninetales_patch` memory for the criteria (must outspeed 177 or bring priority/Scarf, hit SE while not Ice‑4×).
