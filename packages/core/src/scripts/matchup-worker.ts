// Persistent matchup worker for the team-sim pool. Pays the core-module import
// cost ONCE at startup, then loops: read one newline-delimited JSON task from
// stdin, run the depth-N maximin matchup, write one newline-delimited JSON
// result to stdout. Spawned by domain/matchupPool.ts as
//   node --import tsx matchup-worker.ts
// stderr is inherited (left for real errors); ONLY stdout carries results, so
// nothing else may write to stdout here.
import { createInterface } from 'node:readline';
import { evaluateMatchup } from '../domain/teamSim.js';
import type { PokemonSet } from '../domain/types.js';

interface Task { id: number; mine: PokemonSet[]; oppSets: PokemonSet[]; oppAnchor: string; depth: number; budgetMs?: number; bringK?: number }

const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  const t = line.trim();
  if (!t) return;
  let task: Task;
  try { task = JSON.parse(t); } catch { return; }
  try {
    const m = evaluateMatchup(task.mine, task.oppSets, task.oppAnchor, task.depth, task.budgetMs, { bringK: task.bringK });
    process.stdout.write(JSON.stringify({ id: task.id, ok: true, matchup: m }) + '\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({ id: task.id, ok: false, error: err instanceof Error ? err.message : String(err) }) + '\n');
  }
});
// Exit when stdin closes (pool shutting down).
rl.on('close', () => process.exit(0));
