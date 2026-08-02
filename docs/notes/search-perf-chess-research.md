# How chess engines reach depth — and what transfers to our search

> Research note, 2026-08-01, feeding the depth≥4-in-turn requirement in
> [`roadmap-2026-08.md`](roadmap-2026-08.md). Baseline from `search-bench.ts`:
> live turn-1 shows **~35× node growth per ply** (3.8k → 133k → >1.3M), depth 3
> DNF in 120s. Chess engines search depth 20+ in the same wall-clock on similar
> hardware. The gap is not evaluation cost — it's that four decades of search
> engineering keep their *effective* branching factor near √b while ours is the
> raw b. This note is the canon, mapped to our simultaneous-move maximin.

## 1. Why iterative deepening is cheap for them and expensive for us

Chess iterative deepening is **not** redundant re-search, because two carriers
move work forward between passes:

- **The transposition table** persists across passes. An entry stores
  `{searched-depth, score, bound type (exact / lower / upper), best move}`.
  A node revisited at depth d with a TT entry of depth ≥ d returns instantly;
  a shallower entry still supplies the **best move to try first**.
- **Move ordering from the previous pass.** Alpha-beta's whole value is
  proportional to ordering quality: perfect ordering gives ~√b effective
  branching, random ordering gives ~b. The depth-(d-1) pass's PV and TT moves
  are the ordering oracle for the depth-d pass — that's what iterative
  deepening is *for*.

**Our defect:** `ttKey` includes `maxDepth`, so every deepening pass starts
with a cold table — no reuse, no ordering carryover. We pay full b (~35) at
every ply of every pass. This single fix is prerequisite to everything else.

## 2. The chess toolkit, in transfer order

| Technique | What it does | Transfers? |
|---|---|---|
| **TT best-move ordering** | try the stored best move first; cutoff usually immediate | **Directly.** Store the best joint play per node |
| **Root ordering by previous-pass scores** | sort root moves by the last iteration's values | **Directly** — we already keep per-depth results |
| **Killer moves** | quiet moves that caused a cutoff at the same ply get tried early in sibling nodes | **Directly** — Protect/Fake Out/priority KOs recur across siblings constantly |
| **History heuristic** | global "this move causes cutoffs" counters | **Directly** — keyed by (species, move) |
| **Aspiration windows** | search pass d with a narrow (α,β) around pass d-1's score; widen on fail | **Directly** across deepening passes |
| **Late Move Reductions (LMR)** | after the first few ordered moves fail to raise α, search the rest at reduced depth; re-search full-depth only on fail-high | **Directly**, on both my-option and opp-response loops. This is the standard second-biggest win after TT ordering |
| **Null-move pruning** | give the opponent a free move; if the score is *still* ≥ β, prune | **Adapt with care.** Pokémon "pass" is legal-ish (recharge) and passing is almost always bad, so the null-move observation holds; but our serialized maximin changes the semantics — treat as an experiment, not a given |
| **Futility pruning** | near the leaves, skip moves that can't raise α even with a margin | **Adapt** — margin = max damage swing of a cell; cheap to try |
| **Quiescence search** | never cut mid-capture-exchange; extend until quiet | **Analog:** never cut mid-KO-trade — extend a ply when the best line has a KO in flight. Our Hail-Mary/forced logic partially covers this |
| **Lazy SMP** | N threads search the SAME root, sharing one lock-free TT; no work-splitting, no communication; the shared table dedupes work naturally; scales to hundreds of threads | **Directly, and it fits our hardware** — see §3 |
| Star1/Star2 (expectiminimax chance-node pruning) | bounds through chance nodes | **Skip** — we don't price dice, by standing policy |

## 3. Parallelism on the 7950X (16c/32t, 64 GB)

User ruling: optimize for this one home machine; parallelize; watch per-worker
memory.

- **Lazy SMP is the modern answer** (Stockfish dropped YBWC work-splitting for
  it): every worker runs the full iterative search from the root with slight
  ordering/depth jitter; the **shared TT is the only communication**. It
  scales well precisely because there's no synchronization to serialize.
- **Memory shape is favorable:** ONE shared TT (SharedArrayBuffer, sized
  512 MB–2 GB, power-of-2 buckets, depth-preferred replacement, lock-free via
  Stockfish's XOR-checksum trick or atomic 64-bit packing) + per-worker
  engine state (dex tables + cells — measure, likely ~100-200 MB each).
  12 workers ≈ well under 8 GB total. The user's memory concern is solved by
  *sharing* the big allocation, not duplicating it.
- **Stepping stone (no shared memory needed):** root-splitting across
  `worker_threads` — partition my root options over N workers, each with its
  own private TT. Near-linear for the root ply, trivial to build on the
  existing `matchupPool` pattern, and it validates worker plumbing before the
  SharedArrayBuffer TT lands. Costs: no cross-worker dedup below the root.
- Node specifics: `worker_threads` + `SharedArrayBuffer` + `Atomics` are all
  stable; the TT entry must pack into fixed-width integers (no objects).

## 4. The simultaneous-move wrinkle

Chess is alternating; our turn is a **stacked matrix game** (both sides commit
simultaneously). The literature has sound pruning for exactly this:

- **Saffidine, Finnsson & Buro — "Alpha-Beta Pruning for Games with
  Simultaneous Moves" (SMAB):** sound (α,β)-style bounds on the joint-move
  matrix.
- **Bošanský et al. — double-oracle + serialized alpha-beta (DOαβ):** solve
  each node's matrix by *iterated best response* (start with a small strategy
  subset, add best responses until neither side improves) with bounds from the
  serialized game. Reported large node reductions on simultaneous-move
  benchmarks. Maps beautifully onto our node: instead of evaluating the full
  (my options × opp options) matrix, grow it lazily — most cells never get
  touched.
- Our current serialization (maximin: opp best-responds to my committed pair)
  is already the "serialized variant" DOαβ uses for bounds, which makes the
  retrofit natural rather than a rewrite.

This is the research-grade lever — biggest structural change, so it comes
after the classical toolkit, but it attacks the joint-matrix width that chess
never has to pay.

## 5. Plan of record (maps to roadmap Focus B)

1. **TT rebuild** — key without `maxDepth`; store `{depth, score, bound, best
   joint play}`; depth-preferred replacement; persists across passes AND
   across turns (the board barely changes turn-to-turn — chess engines keep
   the table between moves for exactly this reason).
2. **Ordering stack** — TT move first, root sorted by previous pass, killers +
   history for recurring cutoff actions.
3. **Aspiration windows** on deepening passes.
4. **LMR** with fail-high re-search.
5. **Root-split workers** (existing pool pattern) → then **Lazy SMP** with a
   SharedArrayBuffer TT.
6. **DOαβ per-node matrix growth** (research-grade, last).
7. Experiments as time allows: null-move analog, futility margins, KO-trade
   quiescence extension.

**Acceptance test, unchanged:** `search-bench.ts` live turn-1 scenario
completes **depth 4 comfortably inside the turn timer**. Expected stacking:
ordering+TT (~5-20×) × LMR (~2-3×) × 12 workers (~8-10×) ≫ the ~1000× the
35×/ply baseline demands for two extra plies.

## Sources

- [Iterative Deepening — Chessprogramming wiki](https://www.chessprogramming.org/Iterative_Deepening)
- [Transposition Table — Chessprogramming wiki](https://www.chessprogramming.org/Transposition_Table)
- [Late Move Reductions — Chessprogramming wiki](https://www.chessprogramming.org/Late_Move_Reductions)
- [Null Move Pruning — Chessprogramming wiki](https://www.chessprogramming.org/Null_Move_Pruning)
- [Lazy SMP — Chessprogramming wiki](https://www.chessprogramming.org/Lazy_SMP)
- [Parallel Search — Chessprogramming wiki](https://www.chessprogramming.org/Parallel_Search)
- [Stockfish Lazy SMP PR #467](https://github.com/official-stockfish/Stockfish/pull/467)
- [Saffidine et al., "Alpha-Beta Pruning for Games with Simultaneous Moves" (AAAI)](https://cdn.aaai.org/ojs/8148/8148-13-11675-1-2-20201228.pdf)
- [Bošanský et al., "Using Double-oracle Method and Serialized Alpha-Beta Search for Pruning in Simultaneous Move Games"](https://www.researchgate.net/publication/266378318_Using_Double-oracle_Method_and_Serialized_Alpha-Beta_Search_for_Pruning_in_Simultaneous_Move_Games)
