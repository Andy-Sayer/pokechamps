# Harvested VOD ledger

Every VOD pulled for the sprite-ref campaign, so we never re-download one. Update this
whenever a VOD is processed. See [`sprite-refs-plan.md`](sprite-refs-plan.md) for the method.

## USED — yielded refs/crops (do NOT re-pull)
| VOD id | Creator / title | Yielded |
|---|---|---|
| `Pd-8eg-bDZs` | Cybertron — SAND ladder | Blastoise, Metagross, Politoed, Sinistcha, Maushold, Charizard, Incineroar, Dragonite, Talonflame, Kingambit, Venusaur, Archaludon, Dragapult (+ crops) |
| `9R5YJuM-h5Y` | Cybertron — Raichu-X ladder | Kangaskhan, Swampert, Torkoal, Delphox, Primarina, grimmsnarl-shiny (was mislabelled "Mewtwo") |
| `NWbeosiGkac` | Cybertron — Eelektross ladder | Sableye, Meowscarada, Grimmsnarl, Eelektross, Raichu, Milotic |
| `dUzYKEU_8TA` | Cybertron — Scrafty/Torkoal | Scrafty, Vileplume, Sylveon, Torkoal |
| `C370Q58qnFI` | Cybertron — Pyroar | Pyroar, Ninetales (base) |
| `8BtFlPO3yLY` | Cybertron — Rain | Pelipper, Swampert, Grimmsnarl, Aerodactyl |
| `yAXAAdHakiM` | Cybertron — Barbaracle ladder | Mawile (ref) |
| `0ANi8qgr8do` | Cybertron — Blaziken ladder | Mawile (crop) |
| `apejN-EFTXM` | Jeans — Mega Gengar | Gengar, Ninetales-Alola, Blaziken, Basculegion |
| `t13jL3LoI5A` | Jeans — Mega Gardevoir | Gardevoir |
| `wIM2wV9_MUM` | Jeans — Bulk-Up Ceruledge | Ceruledge, Lucario, Hydreigon, Starmie, Kangaskhan, Sableye |
| `FEVwyQyRJzk` | Wolfey — Mega Scovillain | Scovillain |
| `YH5bi7H4c9k` | Wolfey — Reach #1 ladder (14 games) | no new sprites; FOUND the `sneasler` ref = mislabelled Kingambit (deleted) |
| `JJhMx9ErPEs` | Cybertron — Toxapex ladder (6 games) | no new sprites (all [NEED] flags were mismatches: Gallade/Lopunny/Farigiraf) |

## STILL OPEN after ~17 VODs (they are NOT appearing as opponents → likely rarer in the LIVE meta than Pikalytics says)
- Meta gaps (no ref): Annihilape, Corviknight, Froslass, Glimmora, **Sneasler** (never actually seen — every "sneasler" was a Kingambit), Tsareena, Vivillon.
- Crop-less refs (have ref, no crop): Arcanine, Azumarill, Florges, Gholdengo, Meowscarada, Zoroark-Hisui.

## REJECTED — do NOT re-pull (not usable)
| VOD id | Creator / title | Why |
|---|---|---|
| `VlrcX3aXpgY` | Wolfey — Worst Ghost Type | analysis/graphics, not gameplay |
| `pPFmzwkaa7w` | MrSteelixYourGirl — Weather | Pokémon Showdown teambuilder (2D icons) |
| `NH8oESyJ0zg` | Haydunn — Vivillon | **Scarlet/Violet SINGLES**, not Champions |
| `uK43-dVZyyY` | Haydunn — Glimmora | Champions doubles BUT edited montage, NO team-preview screens |
| `2Tgzb78QGz4` | BlindJon — Annihilape | edited showcase, no preview screens |
| `o26KGpqj-fk` | KantoClark — Corviknight | edited showcase, no preview screens |
| `1qo8uAxpihc` | James Baek — Tsareena | download failed (retry candidate) |

## LESSONS (see sprite-refs-plan.md)
- Only **RAW ladder VODs** (Cybertron/Wolfey/Jeans) reliably show team-preview screens.
  Showcase/analysis edits jump-cut past them → `find-previews` returns 0.
- Some "pokemon champions" search hits are **Scarlet/Violet** (shared mons). Midpoint-check
  must confirm **Champions doubles + stadium UI**, not just "a 3D Pokémon battle".

## Candidate UNUSED raw-ladder VODs (creators verified to show previews)
- Wolfey: `YH5bi7H4c9k` (Reach #1, 1h13m), `lKMl8qWVf1A` (Became #1, 1h59m), `abXBnl1Cwp8`
- Cybertron: `JJhMx9ErPEs` (Toxapex, 1h40m), `ES4APGm7KPw` (Staraptor), `iqbvIZC4uvc` (speedran ladder, 2h32m), `5bws1BfLA-4`, `08T2WWdumTo`, `vbMZ1uMzDq8`, `o0FJYfN9g_k`
