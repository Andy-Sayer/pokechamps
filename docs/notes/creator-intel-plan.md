# Creator-intel ingest — spec

Turn VGC content-creator videos into **structured opponent threat intelligence**
(recommended teams + how they're piloted) to feed the gauntlet and the opponent
model. **NOT for our own strategy** — purely to understand what we'll face and how
it'll be played against us. Fleshes out [`future-directions.md`](future-directions.md);
memory: `project_creator_intel`.

## Why (the gap it fills)

Pikalytics ([`refresh-pikalytics`](../../packages/core/src/scripts/refresh-pikalytics.ts))
is a **lagging** meta signal — usage *after* teams ladder. Creators are a
**leading** signal: they define/popularize teams *before* the usage data moves.
Reg M-B started 2026-06-17, the meta is fresh, creators are defining it now → this
is **early warning on emerging threats**, fed into the gauntlet before they show
up in usage stats.

## Guardrails (standing AI direction — `feedback_ai_direction` / `feedback_pokemon_strategy`)

- **Opt-in, off by default.**
- The **judgment is the human creator's** (an expert); any LLM step only
  **transcribes/structures** what they said — verifiable facts, not opinion.
- **Validate every extracted team** (`isLegalSpecies`, parse) — never trust a
  read blindly.
- **Source-tagged** (creator + URL + date) so a claim is always attributable.
- **Never auto-feeds our recommender.** It populates the opponent/threat model
  that the deterministic engine + simulator then reason about.
- **LLM is isolated to ONE optional stage** (4 below); stages 1–3 are LLM-free and
  already useful — so the feature degrades to "no LLM" cleanly.

## Output type

```ts
interface ThreatProfile {
  source: { creator: string; url: string; date: string };
  team: PokemonSet[];        // validated, Champions-legal; spreads default unless stated
  leads?: [string, string];  // the two it leads (creator's stated lead)
  gamePlan?: string;         // short, creator's stated intent ("rain → Archaludon Electro Shot")
  tech?: string[];           // notable items/moves/EVs the creator called out
  confidence: 'vision' | 'transcript' | 'mixed';
}
```

## Pipeline

1. **Source** — a curated seed list of creator channels / video URLs (manual to
   start; a channel poll for "new uploads" later). Input = URL(s).
2. **Fetch** — extend [`packages/vision/scripts/youtube.ts`](../../packages/vision/scripts/youtube.ts)
   (already wraps `yt-dlp`): add a caption pull
   (`--write-auto-sub --sub-format vtt --skip-download`) → transcript text (cheap,
   no audio). Frame extraction for team-preview is already there.
3. **Team extraction — NO LLM, verifiable.**
   - Primary: **vision** on team-preview frames — the existing sprite/nameplate
     reader (`project_sprite_match`, `@pokechamps/vision`) → 6 species.
   - Augment: string-match species named in the transcript against
     `searchLegalSpecies`.
   - **Validate**: each species ∈ Champions legal list (`isLegalSpecies`); dedupe;
     expect 6. A team that fails validation is dropped, not guessed.
4. **Piloting extraction — LLM, optional, source-tagged.** LLM over the transcript
   (+ the validated team) → `{ leads, gamePlan, tech }` as **extraction of what the
   creator said**, not advice. Validate any items/moves mentioned against the legal
   lists. Marked `confidence` + source.
5. **Integrate.**
   - **Gauntlet**: ThreatProfile teams become a `[creator]` source alongside
     `metaTeams` (`[meta]`) and `MB_THREATS` (`[hand]`) in `mb-team-check` /
     `MatchupPool` — so we tune/test our team (and the playout win-rates) against
     emerging threats ahead of the usage curve.
   - **Opponent-piloting prior**: the `leads`/`gamePlan` seed the opponent's policy
     in the playout (`simPlayout` / the search-as-policy) — the sim opponent plays
     the team the creator's way → more realistic bring win-rate evaluation.

## Build increments (each shippable; LLM-free value first)

1. **Caption fetch** (yt-dlp) → transcript file. *(no LLM)*
2. **Team from transcript species-match + legality** → a team-only `ThreatProfile`;
   wire into the gauntlet as `[creator]`. **This alone delivers "emerging creator
   teams in our gauntlet" with ZERO LLM** — the highest-value, lowest-risk slice.
3. **Vision team-read** from team-preview frames → more reliable team than
   transcript names.
4. **LLM piloting extraction** (`leads`/`gamePlan`/`tech`) — opt-in, source-tagged.
5. **Opponent-piloting prior** into the playout policy.

## Risks / open questions

- **Auto-caption quality** is messy (species names mis-transcribed) → vision is the
  reliable team source; transcript is augmentation.
- **Discovery** — which creators, how to find new videos (manual seed first; poll
  later).
- **LLM dependency** stays quarantined to stage 4 and opt-in; 1–3 are deterministic.
- **Fair use** — private analysis of public content; don't redistribute transcripts.

## Sequencing

Start with **increments 1–2** (LLM-free: caption + transcript-species team +
legality + gauntlet). That ships emerging-threat teams into the gauntlet with no
LLM and no new model. Vision (3) and the LLM piloting (4–5) layer on after. Slots
in **after** the hybrid bring flow (`project_sim_playout`) — it's the same gauntlet/
opponent model this would enrich.
