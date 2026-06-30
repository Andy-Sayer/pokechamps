# GPU acceleration for the playout gauntlet — feasibility study

**Status: investigated 2026-06-30 on `feature/gpu-playout-accel`. Verdict: NOT worth it for the
sim/search. The bottleneck is branchy control flow already saturating 32 CPU cores; the only
GPU-amenable sub-piece (the damage-roll arithmetic) is ~0.07% of a calc call and is gated behind
either a full calc reimplementation in WGSL (against the project rule) or a per-dispatch latency
floor that exceeds the entire per-turn grid build. Re-confirms the 2026-06-06 shelving and extends
it to the playout workload. The one place a GPU clearly fits is the *future value-model* track, not
the engine.**

This note answers: *can the idle RTX 3060 break the ~8h gauntlet wall?* Short answer: no, not the
way the premise imagines. The long answer, with a benchmarked proof-of-concept, follows.

---

## 1. The workload and where time actually goes

A full gauntlet ≈ **17 opponents × 225 4v4 cells × ~8 games** played to completion through the real
Showdown engine. It takes **~8 hours** and saturates all 32 threads of a Ryzen 9 7950X via the
30-worker child-process pool (`playoutPool.ts`). Meanwhile the RTX 3060 sits at ~6%.

The hot path is **three nested layers of branchy CPU work**, none of them numeric-kernel shaped:

```
gauntlet
└─ per cell (my bring vs opp bring), ~8 games            cachedBringWinRate / bringWinRate
   └─ playGame()  — steps @pkmn/sim turn-by-turn to a winner   simPlayout.ts  (~10–15s/game @ depth 2)
      ├─ @pkmn/sim turn resolution  ── LAYER 1             the exact Showdown engine (large JS state machine)
      └─ makeSearchPolicy() each turn                       simPlayout.ts
         └─ searchIterative/Budgeted(depth 2)               endgameSearch.ts (5460 lines)
            ├─ createSearch → buildTables  ── LAYER 2        the damage GRID
            │   └─ predictOffense/Threat → damageRange       predictions.ts → damage.ts
            │       └─ @smogon/calc calculate()              object build + modifier resolution
            │           └─ 16-roll arithmetic  ── LAYER 3    ← the ONLY GPU-amenable piece
            └─ rootSearch  ── LAYER 2                         maximin tree (alpha-beta, transposition)
```

Measured split of one full 4v4 search (from the 2026-06-06 benchmark, `endgame-search-plan.md`):

| stage | time |
|---|---|
| `createSearch` (builds the whole damage grid — the GPU's only target) | **~290 ms** |
| `toDepth(2)` (the maximin tree) | **~2.3 s** (no switch-at-depth) / ~6.1 s (with) |
| `toDepth(3)` | **~72 s** |

So even within ONE search, the **tree (Layer 2) dwarfs the damage grid ~8–20×**. And in a *playout*
this runs **every turn of every game**, on top of the `@pkmn/sim` engine (Layer 1) which is itself a
large branchy JS state machine resolving abilities/items/status/type-chart/faints. The numeric
arithmetic (Layer 3) is buried at the bottom of all of this.

How small is Layer 3? The PoC measured it (single thread):

- Full `@smogon/calc calculate()` rebuilt per call (exactly as `damage.ts` does): **~0.066 ms/call → ~15,000 calls/sec**.
- The pure 16-roll arithmetic inside it: **~400 M rolls/sec** → 16 rolls ≈ 40 ns.
- **The arithmetic is ≈ 0.07 % of a `calculate()` call.** The other 99.9 % is object construction
  and the branchy modifier resolution (type chart, abilities, items, STAB, weather, spread) — the
  part a GPU is worst at and that we are forbidden to reimplement.

**Conclusion of the hot-path analysis:** the cost is branchy control flow at all three layers. The
single piece that is uniform arithmetic is a rounding error.

---

## 2. Why GPU was shelved before (and whether it still holds)

Commit `6f51d4b` (2026-06-06, *"measure the GPU premise — it's not the bottleneck, the tree is"*)
shelved GPU work after measuring the **search**. Its reasoning:

1. The damage-grid build (the GPU's only target) is ~290 ms — a rounding error next to a search tree
   that costs seconds at depth 2 and over a minute at depth 3.
2. Step A (coarse `K=3` spread profile, `SEARCH_PROFILE_K`) already removed the per-spread explosion
   the GPU was meant to attack.
3. A GPU kernel would require **reimplementing the damage formula in WGSL**, which violates the
   project's "never reimplement the calc" rule (`damage.ts` is a thin wrapper around `@smogon/calc`).
4. The real lever is **tree efficiency** — since done: alpha-beta move ordering, transposition table,
   adaptive deepening, switch-ply gating (memory: *Search perf + status-on-hit* — alpha-beta d3 7.9×,
   transposition 16–20×).

**Does it still hold for the playout gauntlet? Yes — and more strongly.** The 2026-06 reasoning was
about a single search position; the gauntlet runs that search every turn *and* adds the full
`@pkmn/sim` engine on top, then parallelises across games. Every reason above survives, plus two new
ones specific to playouts:

- The gauntlet is **embarrassingly parallel across games** and already saturates 32 CPU cores. A GPU
  would have to beat ~32 threads' worth of throughput on the *actual* work (branchy state stepping),
  not on the arithmetic.
- `sim-divergences.md` shows we continuously chase gaps between our approximate engine and the exact
  `@pkmn/sim`. A second, GPU-resident approximation would multiply that validation burden.

---

## 3. GPU approaches assessed for THIS workload

### (a) GPU-batch the numeric kernels (the damage-roll / damage-matrix) — **NO**

This is the most-cited idea and the one the PoC implements (section 4). The kernel works and is
bit-exact, but it does not help, for three compounding reasons:

- **It's 0.07 % of a calc call.** Even an infinitely fast kernel removes ~0.07 % of Layer 3, which is
  itself a fraction of the per-turn cost. Amdahl's law kills it before transfer overhead even enters.
- **Feeding it requires the forbidden reimplementation.** To compute a damage roll the GPU needs the
  *resolved* attack/defense stats, base power, and the combined type/STAB/ability/item/weather
  multiplier. Resolving those is exactly `@smogon/calc`'s branchy work. Either you port the type
  chart + ability/item table to WGSL (violates the rule; months of work; a permanent divergence risk)
  or you pre-resolve every modifier on the CPU (in which case the CPU already paid the 99.9 %).
- **The Node→GPU round-trip floor is larger than the whole grid.** Measured below: a single small
  dispatch round-trips in **tens of ms** through the Node/Dawn binding, versus a ~290 ms CPU grid that
  contains *hundreds* of cells. Per-turn grids are tiny and data-dependent on the previous turn's
  outcome, so they can't be batched into one giant submit without restructuring the whole search.

### (b) A reduced/approximate GPU-resident simulator for rollouts — **NO (now)**

The roadmap floated "port `sim/` logic + GPU-ify an approximate engine." Honest assessment:

- Our approximate engine (`endgameSearch.ts`) is **5,460 lines of branch-heavy TS**; `@pkmn/sim` is
  far larger. A WGSL port is a multi-month effort.
- A battle is a **sequential, heavily-branching state machine**. On a GPU, games batched into a warp
  take *different* branches (this mon has Intimidate, that one procs Sash, the other is asleep) →
  lanes serialize → catastrophic occupancy. GPUs win on *uniform* work; this is maximally divergent.
- It must be validated against the exact sim forever (see `sim-divergences.md`). Building a *second*
  approximate engine to chase the *first* approximate engine's gaps is negative-leverage.

### (c) Is the bottleneck even GPU-amenable? — **No.**

The bottleneck is branchy state-machine control flow (Layer 1 + Layer 2), already parallel across 32
cores. GPUs accelerate wide, uniform, arithmetic-dense, low-divergence kernels. This workload is the
opposite on every axis.

### Tooling note (checked, not assumed)

- `nvidia-smi`: RTX 3060, 12 GB, driver CUDA 12.6. `nvcc`: **not installed** — no CUDA toolkit, and
  we deliberately did not install a multi-GB one.
- Node 22 has **no** built-in WebGPU (`navigator.gpu` undefined).
- JS-in-stack options that *are* lightweight: `@kmamal/gpu` (143 KB + a prebuilt Dawn binary
  downloaded on install — the PoC uses this) and `webgpu` (71 MB self-contained Dawn — tried first,
  but it **segfaults** non-deterministically on the readback path under Node 22, so it's unusable).
  `gpu.js` would need `headless-gl` native builds on Windows — avoided.
- **Stability caveat:** even the working binding has a coarse per-submit polling latency (see below).
  Node-WebGPU compute is viable for *one big offline batch*, not for *many small interactive
  dispatches* — which is precisely what per-turn search needs.

---

## 4. Proof-of-concept: batched damage-roll kernel (`experiments/gpu-poc/`)

The most promising tractable piece (per the task) is the batched damage kernel, so that is what the
PoC builds and benchmarks honestly. It implements the Gen-9 base-damage + 16-roll arithmetic once on
the CPU (tight typed-array loop) and once in WGSL, runs both, and validates + benchmarks them.

```
experiments/gpu-poc/
  damageKernel.ts   CPU reference + WGSL shader (shared formula)
  gpu.ts            WebGPU harness via @kmamal/gpu (Dawn-in-Node)
  bench.ts          validate vs @smogon/calc, validate GPU==CPU, benchmark, context
```

Run: `cd experiments/gpu-poc && npm install && npm run bench`.

### Correctness (non-negotiable for an honest verdict)

- **7 / 8 neutral, no-modifier cases match `@smogon/calc` BIT-EXACTLY** (the 8th, Garchomp Body Slam
  vs Tyranitar, is correctly detected as a non-neutral case — calc applied a ×0.49 type/STAB modifier
  — and skipped). This proves the kernel computes the real calc's damage on the arithmetic it owns.
- **GPU == CPU bit-exact** over 100,000 tuples × 16 rolls = 1,600,000 values, 0 differences.

### Benchmark (RTX 3060, Node 22, single CPU thread baseline)

Throughput across batch sizes. CPU is single-threaded and small on purpose (a running gauntlet
saturates the other cores). `gpu disp` includes the per-submit sync; `gpu tot` adds upload+readback.

| batch (tuples) | CPU ms | CPU Mrolls/s | GPU dispatch ms | GPU total ms | speedup (tot) |
|---:|---:|---:|---:|---:|---:|
| 256 | 0.012 | 346 | 107.8 | 217.3 | 0.00× |
| 4,096 | 0.117 | 559 | 107.9 | 217.6 | 0.00× |
| 65,536 | 2.43 | 431 | 105.5 | 217.4 | 0.01× |
| 262,144 | 11.9 | 353 | 102.6 | 216.4 | 0.05× |
| 1,048,576 | 31.8 | 528 | 89.8 | 215.4 | 0.15× |

The GPU "dispatch" time is pinned near ~100 ms regardless of batch size — that is the **Node/Dawn
per-submit synchronization floor**, not compute. Amortizing it (pack 200 dispatches into one
submit+sync) exposes the TRUE compute throughput:

- **Single-dispatch round-trip floor:** ~26 ms (warm) up to ~107 ms (cold) — tens of ms either way.
- **Amortized:** 200 dispatches of 1,048,576 tuples in **218.8 ms** → **1.09 ms/dispatch** →
  **≈ 15,300 Mrolls/s TRUE GPU compute throughput.**

### What the numbers actually say

| metric | value |
|---|---|
| GPU true compute | **~15,300 Mrolls/s** |
| 1 CPU thread | ~400 Mrolls/s → **GPU ≈ 38–42× one thread** |
| **32 CPU threads (the real competitor)** | **~12,800 Mrolls/s → GPU only ≈ 1.2× the fully-used CPU** |
| Arithmetic share of a `calculate()` call | **~0.07 %** |
| Node→GPU round-trip floor per dispatch | **tens of ms** (≫ a ~290 ms grid that holds *hundreds* of cells) |

So even on the one thing the GPU *can* do, it barely edges out the 32-core CPU it would be competing
with — and that thing is 0.07 % of the work. The 99.9 % (modifier resolution + the search tree +
the `@pkmn/sim` engine) cannot move to the GPU without reimplementing the calc and the engine in WGSL,
which is both against the rules and divergence-hostile.

---

## 5. Recommendation

**Do not pursue GPU acceleration of the sim or the search.** The PoC confirms, with numbers, the
2026-06 shelving decision and extends it to the playout gauntlet: the bottleneck is branchy control
flow already spread across 32 cores; the GPU-amenable slice is a rounding error gated behind a
forbidden reimplementation and a latency floor.

**The 8h wall is a CPU-throughput + algorithmic problem. The real levers, in value order:**

1. **Fewer games.** Variance-reduced paired seeds already help (`bringWinRate`); add early-stopping
   for cells whose win-rate is statistically decided after a few games, and skip cells dominated in
   the bring matrix-game. This attacks the `225 × 8` term directly.
2. **More cell reuse.** `cellCache.ts` already shares cells across callers; ensure the gauntlet keys
   maximise hits (a mutated team should only recompute brings touching the changed mon).
3. **Cheaper policy where it doesn't matter.** `searchBudgeted(budgetMs)` / lower depth on
   clearly-decided positions trades negligible accuracy for many more games/sec.
4. **The already-shipped tree work** (alpha-beta, transposition, adaptive depth) is the proven lever;
   keep investing there over any kernel.

**If using the GPU is itself a goal, route it to the ONE workload it fits: the future value model**
(`future-directions.md` §1 / `training-data-plan.md`). A neural value/policy net trained on
played-out win-rates is dense matmul with no divergence — the textbook GPU job. Used as
"model proposes, simulator disposes," it **reduces the number of full playouts**, which is the actual
lever on the 8h wall. This is the only GPU path with real leverage, and it uses the GPU for what GPUs
are good at instead of forcing a state machine onto a SIMD device.

### Rough effort estimates

| option | effort | payoff |
|---|---|---|
| GPU damage-roll kernel integration (this PoC, wired into workers) | ~1–2 weeks | **~0 %** net (arithmetic isn't the cost) — do not do |
| GPU-resident approximate engine port (WGSL) | **months**, high risk | uncertain; divergence-bound; validation burden — do not do |
| CPU/algorithmic levers (1–4 above) | days each | direct reduction of the `225 × 8` and per-game cost — **do these** |
| GPU value-model track (training + inference) | 2–4 weeks for a baseline (data already generated) | cuts playout count; correct use of the GPU — **do this if GPU utilisation is the goal** |
