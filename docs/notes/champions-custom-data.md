# Champions custom-data audit (Reg M-A)

One-shot survey (2026-06-12) of every format-custom entry reachable through
the legal lists, and whether our three layers (calc / live engine / search)
respect it. Method: scan `data/*.json` for `isNonstandard` entries reachable
via `format.champions.json` allow-lists + legal mega stones. Regenerate after
each regulation change (see [`regulation-m-b.md`](regulation-m-b.md)).

## Result: the custom surface is exactly 4 abilities

- **Custom moves in legal learnsets: 0.**
- **Custom items: only the mega stones** (`Past`/`Future`-tagged) — pure
  gimmick machinery, fully handled by `gimmicks/mega.ts` (forme resolve,
  validation, candidate enumeration).
- **Custom abilities reachable (all via mega formes):**

| Ability | Holder | Effect | Handling |
|---|---|---|---|
| **Mega Sol** | Meganium-Mega | Holder acts under personal sun | ✅ `damage.ts` emulates sun for the holder's offense (overrides ambient weather); tactics `weather` detector treats it as self-only sun |
| **Spicy Spray** | Scovillain-Mega | Burns attackers on hit | ✅ on-hit burn in both engine mirrors (defender ability resolved through mega) |
| **Dragonize** | Feraligatr-Mega | Normal-type moves become Dragon | ✅ `damage.ts` type-override mirror of the Mega Sol pattern |
| **Piercing Drill** | Excadrill-Mega | Contact moves pierce protection at ¼ damage | ✅ **fixed in this audit** — the search's Protect fizzle now lets a Piercing Drill contact move through at 0.25× (both directions; opp side only when the ability is KNOWN). Previously Protect was modeled as a full block against it |

Also re-verified this pass: Mega Raichu X/Y (Reg M-B) abilities are **standard**
(Electric Surge / No Guard) — no new custom hooks needed, only the
`refresh-data.ts` `SPECIES_PATCHES` data correction.

## Caveats / accepted simplifications

- Piercing Drill is modeled in the **search** only. The forward damage calc
  never computes "damage into Protect" (the user logs real damage), and the
  live engine takes logged damage as truth — so the search was the only layer
  that wrongly hard-blocked it.
- The pierce applies on the main single-target attack path; the spread and
  priority sub-paths still treat Protect as absolute for it (Excadrill-Mega
  has no meaningful contact spread/priority moves; revisit if a future forme
  gets the ability).
