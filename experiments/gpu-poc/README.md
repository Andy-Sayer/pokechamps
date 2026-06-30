# gpu-poc — batched damage-roll kernel (GPU vs CPU)

Throwaway proof-of-concept for the GPU-acceleration feasibility study. See the
full write-up in [`docs/notes/gpu-acceleration.md`](../../docs/notes/gpu-acceleration.md).

## What it does

- `damageKernel.ts` — the Gen-9 base-damage + 16-roll arithmetic (the pure,
  GPU-amenable inner loop), implemented once on the CPU and once in WGSL.
- `gpu.ts` — a minimal WebGPU compute harness via [`@kmamal/gpu`](https://www.npmjs.com/package/@kmamal/gpu)
  (a maintained Dawn-in-Node binding; no CUDA toolkit needed).
- `bench.ts` — (1) validates the kernel BIT-EXACTLY against `@smogon/calc` on
  neutral cases, (2) validates GPU == CPU on a large sample, (3) benchmarks
  throughput across batch sizes, (3b) measures TRUE GPU compute throughput by
  amortizing the Node/Dawn per-submit sync floor, (4) reports the full
  `calculate()` per-call cost for context.

## Run

```
cd experiments/gpu-poc
npm install          # pulls @kmamal/gpu (Dawn prebuilt), tsx, @smogon/calc
npm run bench
```

`node_modules` is gitignored; `package-lock.json` pins the versions used.

## Headline result (RTX 3060, Node 22)

The GPU does the damage arithmetic ~40x faster than ONE CPU thread, but that
arithmetic is **~0.07% of a real `@smogon/calc` call** and the search/sim
bottleneck is branchy control flow the GPU can't run. Net: **not worth it.**
Numbers and reasoning in the doc.
