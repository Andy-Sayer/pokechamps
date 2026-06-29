# Training-data plan — historic games → a purpose-trained model

> **PIVOT (2026-06-28): native SIMULATION replaced replay-scraping as the primary
> data source.** The scraped gen9 replay corpus was a proxy (no Champions megas,
> hidden EV spreads) and the baseline proved bring-quality isn't in simple features.
> Then we discovered `@pkmn/sim` 0.10.11 simulates Champions **natively** (megas +
> custom abilities — see `project_sim_champions_native`), so we can PLAY matchups
> out on the exact engine with KNOWN spreads (`domain/simPlayout.ts` —
> `project_sim_playout`). Current direction: use played-out **win-rates** directly
> in the bring/team decision (gated by the Step-0 validation, `sim-playout-validate.ts`,
> on whether they beat the static opening-search score). A LEARNED model distilled
> from these simulated games (Tasks A-C below) is now a DEFERRED follow-on, only if
> the live-preview bring decision needs a fast approximation of the slow playout.

Fleshes out [`future-directions.md`](future-directions.md) §1. **Guardrails
(standing AI direction):** a purpose-trained model, **not** an LLM; **opt-in**;
**advisory** — it augments or sits beside the deterministic search, never
silently overrides it. The user distrusts LLM VGC judgement, so this is the
sanctioned path: learn from real outcomes, keep the engine as the honest floor.

## The asset we're building

A growing, versioned corpus of **decision records** — `(observed state, legal
options, chosen action, eventual outcome)` — harvested from real games. The
records are a *serialisable projection of the types the engine already uses*, so
"state" is exactly what the engine sees. Do NOT invent a parallel battle
representation.

```ts
// sketch — lands in packages/core/src/domain/trainingData.ts
type Source = 'showdown-replay' | 'match-snapshot' | 'vision';

interface DecisionRecord {
  source: Source;            // fidelity tag (see "Label quality")
  gameId: string;
  turn: number;
  side: 'mine' | 'theirs';   // whose decision this row is
  // Observable state at decision time — a flat projection of `Match` +
  // `OpponentEntry[]` + field: revealed teams, actives, HP% / status / boosts,
  // weather/terrain/TR/tailwind, hazards, KNOWN items/abilities/moves, and the
  // opp inference candidates. Reuse domain/types.ts `Match`; serialise, don't redefine.
  state: ObservedState;
  legal: GameOption[];       // moves / switches available (the choice space)
  chosen: GameOption;        // what was actually played
  // The engine's read at the time — lets us train a DISTILLATION target and
  // measure model-vs-search agreement. From SearchResult (endgameSearch.ts).
  engineRec?: { plays: SearchPlay[]; score: number; verdict: string; winChance?: number };
  // Outcome labels, filled by a backward pass once the game's winner is known.
  outcome: { win: boolean; turnsToEnd: number };
}
```

## Data sources (and how each is already half-built)

1. **Showdown replay corpus** — *abundant, proxy meta.* The J pipeline
   (`showdownReplay.ts` → `replayDriver.ts`) already parses the `|`-protocol into
   a `BattleTranscript` (typed `TranscriptEvent`s: `move` / `switch` / `damage` /
   …) and walks it through the production `finalizeTurn`/`applyStateUpdate`,
   reconciling against transcript-truth HP/field each turn. **That walk already
   produces, per turn, the `Match`-shaped state + the action taken** — i.e. it's
   90% of the exporter. 16 games are cached under `tests/replays/`; `winner` is on
   the transcript for the outcome label. Caveat: gen9 VGC, not Champions, and EV
   spreads are hidden.
2. **Match snapshots** — *scarce, first-party, exact.* The TUI persists
   `matches/<id>.json` (`Match`, incl. the turn log + `outcome`). These are real
   Champions games with our own spreads known exactly — the highest-fidelity rows.
3. **Vision-captured games** — *automatic, once reliable.* When the vision
   adapter's screen-read is trustworthy (`vision-plan.md`), watched VODs / live
   play become a hands-free Champions data source. Folds in last.

## First target task — bring/outcome value (most labels, most user value)

Reordered from the note's "spread prior first" after grounding: **outcome labels
are abundant; spread labels are mostly hidden.** So start where the data is:

- **Task A — bring/team value (supervised, lots of labels).** Input = both teams
  at preview + my bring; label = win/loss (every replay gives `teams` + `winner`).
  Trains a learned evaluation that can *augment* `scoreBrings` / the gauntlet
  fitness in team-building (the thing the user is actively using). Tractable,
  directly useful, and validates the whole pipeline end-to-end.
- **Task B — move policy (behavioural cloning of strong play).** Input =
  `ObservedState`; label = the move a strong player chose (replays are
  ranked/tournament). A learned *prior over moves* that can order/seed the
  search's branching — never replace its maximin. Same records, different head.
- **Task C — opponent spread prior (later).** Input = species + revealed
  set + observed damage so far; label = the true spread. Labels exist only where
  spreads are known: **OTS replays** + the **J.4 sim-generated games** (we author
  the sets, the sim plays them — ready-made ground truth) + first-party snapshots.
  Improves the heuristic inverse solver in `inference.ts`. Deferred because the
  label supply is thin until we lean on sim-generated data.

## Status (2026-06-28)

**Started — steps 1–2 shipped.** `domain/trainingData.ts` (`BringOutcomeRow` +
`bringOutcomeRows`) + `scripts/export-training.ts` walk the replay corpus into a
`data/training/bring-outcomes.jsonl` dataset; `training-data.test.ts` pins it.
Why now: the bring-weight calibration was a **proven negative result** — a linear
re-weighting of the heuristic caps at ~28% agreement with the exhaustive bring
and doesn't generalize, so a learned evaluator is the real path to a smart live
bring (see [[project_mb_team]]). **Corpus grown 2026-06-28:** a batch OTS **Bo3** fetch (`fetch-replay --search …
--out data/replays-train --quiet`, Reg F/H/I bo3) pulled 204 games → **361 usable
rows** (full OTS 6 + bring of 4 + decided; 437/442 rows are full OTS teams), up
from 24. Trainable for a baseline. (Showdown `search.json` has no pagination, so
this is ~the recent list per format — repeat over days to grow further.)
**Baseline model (step 3) ✅ built — honest NEGATIVE result.** `mb-bring-model.ts`
(logistic regression over (my−opp) bring stat-sum features, game-level split):
train ~56% ≈ majority, test 72% (small-sample noise on 81 rows), BST-heuristic
28% (anti-correlated — restricted-legend formats make BST-diff meaningless). So
crude bring stat-sums DON'T predict the winner — the same lesson as the
`scoreBrings` calibration (28% ceiling): **bring quality isn't in simple aggregate
features**; VGC outcomes are dominated by play + specific matchups. NOT wired.

**Where this leaves it.** Two experiments now agree the easy path fails. A
genuinely smart LIVE bring model needs EITHER (a) a much bigger corpus (thousands
of OTS games, fetched over time — `search.json` has no pagination) + RICH
matchup-aware features (per-opp type/speed/role coverage, synergy, not stat
sums), a real ML investment; OR (b) accept that exact bring-SEARCH (offline,
already shipped via `--allBrings`) is the right tool where the opp's six is known,
and the live preview heuristic has inherent limits. The full pipeline +
harnesses are committed for whenever (a) is resourced.

## The build (when picked up — incremental, each step shippable)

1. **`ObservedState` + `DecisionRecord` types** (`domain/trainingData.ts`) — the
   serialisable projection + a `projectMatchState(match, …)` that flattens the
   live `Match` into `ObservedState`. Unit-test the projection round-trips.
2. **Exporter over the replay corpus** (`scripts/export-training.ts`) — reuse
   `replayDriver` to walk each cached replay, emit one `DecisionRecord` per
   decision, backfill the `outcome` from `winner`. Writes JSONL to a gitignored
   `data/training/` dir. Start with **Task A** rows (cheapest: preview teams +
   winner — barely needs the per-turn walk).
3. **A baseline model + an eval harness** — keep it boring and inspectable first
   (logistic / gradient-boosted trees over hand-features, or a small MLP). The
   eval that matters: does it beat `scoreBrings` at predicting replay outcomes on
   a held-out split? Ship the metric before the model.
4. **Opt-in wiring** — surface as an advisory column/flag in the BringPicker
   (and later a search move-ordering prior), defaulted OFF, side-by-side with the
   engine number. Never an automatic override.

## Label quality (tag it, weight it)

- `showdown-replay`: gen9-VGC proxy, spreads hidden → great for Task A/B, not C.
- `match-snapshot` / sim-generated: Champions-native + exact spreads → the only
  clean Task-C labels; weight them up.
- The J reachability/round-trip machinery already reasons about hidden spreads —
  reuse it rather than re-deriving.

## Open questions

- Model family for Task A/B (trees-over-features vs small net) — decide after the
  eval harness exists, on the held-out metric.
- How much Champions-native data we can realistically gather vs leaning on the
  Showdown proxy + sim-generated games for Champions-specific tasks.
- Whether Task B's policy seeds the search's move ordering or stays a separate
  advisory line (start separate; only wire into search if it provably speeds the
  read without changing the maximin).

Related: the J north-star + pillars **H (AI)** / **C (decision support)** in
[`roadmap.md`](roadmap.md); sources reused from `showdownReplay.ts` /
`replayDriver.ts` / `storage.ts` / `endgameSearch.ts` / `inference.ts`.
