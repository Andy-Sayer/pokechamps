// A pool of persistent child-process workers that evaluate team matchups in
// parallel — the embarrassingly-parallel win for the team scripts (12+
// independent matchups, each a self-contained maximin search). On a 32-core
// box this is a ~Nx speedup over the sequential path with IDENTICAL results
// (each worker runs the same pure evaluateMatchup). Falls back to synchronous
// evaluation transparently if a worker can't be spawned (e.g. a packaged
// build without tsx), so callers never need a branch.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { cpus } from 'node:os';
import { evaluateMatchup, type Matchup } from './teamSim.js';
import type { PokemonSet } from './types.js';

export interface MatchupTask { mine: PokemonSet[]; oppSets: PokemonSet[]; oppAnchor: string; depth: number; budgetMs?: number }

const WORKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'matchup-worker.ts');

interface Pending { resolve: (m: Matchup) => void; reject: (e: Error) => void; task: MatchupTask }

export class MatchupPool {
  private workers: { proc: ChildProcess; rl: Interface; busy: boolean }[] = [];
  private queue: { id: number; p: Pending }[] = [];
  private inflight = new Map<number, Pending>();
  private nextId = 1;
  private usable = true;

  constructor(private size: number = Math.max(1, Math.min(cpus().length - 1, 30))) {}

  /** Lazily spawn workers on first use; on any spawn failure, mark the pool
   *  unusable so run() degrades to synchronous evaluation. */
  private ensure(): void {
    if (this.workers.length || !this.usable) return;
    for (let i = 0; i < this.size; i++) {
      try {
        const proc = spawn(process.execPath, ['--import', 'tsx', WORKER], {
          stdio: ['pipe', 'pipe', 'inherit'],
        });
        proc.on('error', () => { this.usable = false; });
        const rl = createInterface({ input: proc.stdout! });
        const w = { proc, rl, busy: false };
        rl.on('line', line => this.onLine(w, line));
        proc.on('exit', () => { w.busy = false; });
        this.workers.push(w);
      } catch {
        this.usable = false;
        break;
      }
    }
    if (!this.workers.length) this.usable = false;
  }

  private onLine(w: { busy: boolean }, line: string): void {
    const s = line.trim();
    if (!s) return;
    let msg: { id: number; ok: boolean; matchup?: Matchup; error?: string };
    try { msg = JSON.parse(s); } catch { return; }
    const p = this.inflight.get(msg.id);
    if (!p) return;
    this.inflight.delete(msg.id);
    w.busy = false;
    if (msg.ok && msg.matchup) p.resolve(msg.matchup);
    else p.reject(new Error(msg.error ?? 'worker error'));
    this.pump();
  }

  private pump(): void {
    for (const w of this.workers) {
      if (w.busy) continue;
      const next = this.queue.shift();
      if (!next) return;
      w.busy = true;
      this.inflight.set(next.id, next.p);
      w.proc.stdin!.write(JSON.stringify({ id: next.id, ...next.p.task }) + '\n');
    }
  }

  private one(task: MatchupTask): Promise<Matchup> {
    return new Promise<Matchup>((resolve, reject) => {
      const id = this.nextId++;
      this.queue.push({ id, p: { resolve, reject, task } });
      this.pump();
    });
  }

  /** Evaluate every task; returns results in input order. Parallel across the
   *  worker pool, or synchronous (same results) if workers are unavailable. */
  async run(tasks: MatchupTask[]): Promise<Matchup[]> {
    this.ensure();
    if (!this.usable) {
      return tasks.map(t => evaluateMatchup(t.mine, t.oppSets, t.oppAnchor, t.depth, t.budgetMs));
    }
    try {
      return await Promise.all(tasks.map(t => this.one(t)));
    } catch {
      // A worker died mid-run → finish synchronously rather than lose the run.
      this.usable = false;
      return tasks.map(t => evaluateMatchup(t.mine, t.oppSets, t.oppAnchor, t.depth, t.budgetMs));
    }
  }

  close(): void {
    for (const w of this.workers) { try { w.proc.stdin!.end(); } catch { /* already gone */ } }
    this.workers = [];
  }
}
