// Persistent playout worker for PlayoutPool. Pays the core-import cost ONCE, then
// loops: read one game task from stdin, play it to a winner under the search
// policy, write the GameResult to stdout. Spawned by domain/playoutPool.ts as
//   node --import tsx playout-worker.ts
// stderr is inherited; ONLY stdout carries results (one JSON line per game).
import { createInterface } from 'node:readline';
import { playGame, makeSearchPolicy, makePilotPolicy, derivePilotPlan } from '../domain/simPlayout.js';
import type { SearchBreadth } from '../domain/endgameSearch.js';
import type { PokemonSet } from '../domain/types.js';

interface Task { id: number; p1: PokemonSet[]; p2: PokemonSet[]; seed: [number, number, number, number]; depth?: number; budgetMs?: number; pilotOpp?: boolean; breadth?: SearchBreadth; nodeBudget?: number }

const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  const t = line.trim();
  if (!t) return;
  let task: Task;
  try { task = JSON.parse(t); } catch { return; }
  void (async () => {
    try {
      const policy = makeSearchPolicy(task.p1, task.p2, task.depth ?? 2, task.budgetMs, task.breadth, task.nodeBudget);
      const p2Policy = task.pilotOpp ? makePilotPolicy(task.p1, task.p2, task.depth ?? 2, derivePilotPlan(task.p2)) : undefined;
      const r = await playGame(task.p1, task.p2, { seed: task.seed, policy, p2Policy });
      process.stdout.write(JSON.stringify({ id: task.id, ok: true, result: r }) + '\n');
    } catch (err) {
      process.stdout.write(JSON.stringify({ id: task.id, ok: false, error: err instanceof Error ? err.message : String(err) }) + '\n');
    }
  })();
});
rl.on('close', () => process.exit(0));
