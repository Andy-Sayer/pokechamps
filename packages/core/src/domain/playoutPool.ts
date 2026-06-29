// A pool of persistent child-process workers that play full games in parallel —
// the embarrassingly-parallel win for simulation: each game (~15s under the search
// policy) is independent, so a win-rate over K games, or a ranking of all 15
// brings, drops from minutes to seconds across cores. Mirrors MatchupPool exactly
// (same spawn/queue/pump/fallback machinery); the unit of work here is ONE GAME.
// Falls back to synchronous playGame if workers can't spawn, so callers never branch.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { cpus } from 'node:os';
import { playGame, makeSearchPolicy, makePilotPolicy, derivePilotPlan, type GameResult } from './simPlayout.js';
import type { PokemonSet } from './types.js';

export interface PlayoutTask { p1: PokemonSet[]; p2: PokemonSet[]; seed: [number, number, number, number]; depth?: number; budgetMs?: number; pilotOpp?: boolean }

const WORKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'playout-worker.ts');

interface Pending { resolve: (r: GameResult) => void; reject: (e: Error) => void; task: PlayoutTask }

const playSync = async (t: PlayoutTask): Promise<GameResult> => {
  const r = await playGame(t.p1, t.p2, {
    seed: t.seed,
    policy: makeSearchPolicy(t.p1, t.p2, t.depth ?? 2, t.budgetMs),
    p2Policy: t.pilotOpp ? makePilotPolicy(t.p1, t.p2, t.depth ?? 2, derivePilotPlan(t.p2)) : undefined,
  });
  if ('error' in r) throw new Error(r.error);
  return r;
};

export class PlayoutPool {
  private workers: { proc: ChildProcess; rl: Interface; busy: boolean }[] = [];
  private queue: { id: number; p: Pending }[] = [];
  private inflight = new Map<number, Pending>();
  private nextId = 1;
  private usable = true;

  constructor(private size: number = Math.max(1, Math.min(cpus().length - 1, 30))) {}

  private ensure(): void {
    if (this.workers.length || !this.usable) return;
    for (let i = 0; i < this.size; i++) {
      try {
        const proc = spawn(process.execPath, ['--import', 'tsx', WORKER], { stdio: ['pipe', 'pipe', 'inherit'] });
        proc.on('error', () => { this.usable = false; });
        const rl = createInterface({ input: proc.stdout! });
        const w = { proc, rl, busy: false };
        rl.on('line', line => this.onLine(w, line));
        proc.on('exit', () => { w.busy = false; });
        this.workers.push(w);
      } catch { this.usable = false; break; }
    }
    if (!this.workers.length) this.usable = false;
  }

  private onLine(w: { busy: boolean }, line: string): void {
    const s = line.trim();
    if (!s) return;
    let msg: { id: number; ok: boolean; result?: GameResult; error?: string };
    try { msg = JSON.parse(s); } catch { return; }
    const p = this.inflight.get(msg.id);
    if (!p) return;
    this.inflight.delete(msg.id);
    w.busy = false;
    if (msg.ok && msg.result) p.resolve(msg.result);
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

  private one(task: PlayoutTask): Promise<GameResult> {
    return new Promise<GameResult>((resolve, reject) => {
      const id = this.nextId++;
      this.queue.push({ id, p: { resolve, reject, task } });
      this.pump();
    });
  }

  /** Play every task; results in input order. Parallel across the pool, or
   *  synchronous (same results) if workers are unavailable. */
  async run(tasks: PlayoutTask[]): Promise<GameResult[]> {
    this.ensure();
    if (!this.usable) {
      const out: GameResult[] = [];
      for (const t of tasks) out.push(await playSync(t));
      return out;
    }
    try {
      return await Promise.all(tasks.map(t => this.one(t)));
    } catch {
      this.usable = false;
      const out: GameResult[] = [];
      for (const t of tasks) out.push(await playSync(t));
      return out;
    }
  }

  close(): void {
    for (const w of this.workers) { try { w.proc.stdin!.end(); } catch { /* already gone */ } }
    this.workers = [];
  }
}

/** Win-rate for `myBring` vs `oppBring` over K paired-seed games (common random
 *  numbers — far less noise when comparing brings). Returns wins/games + the raw
 *  results (each a labeled training row). */
export async function bringWinRate(
  pool: PlayoutPool, myBring: PokemonSet[], oppBring: PokemonSet[], games: number, depth = 2, pilotP2 = false,
): Promise<{ wins: number; losses: number; ties: number; winRate: number; results: GameResult[] }> {
  const tasks: PlayoutTask[] = Array.from({ length: games }, (_, k) => ({
    p1: myBring, p2: oppBring, seed: [k + 1, 2 * k + 5, 3 * k + 7, 5 * k + 11], depth, pilotOpp: pilotP2,
  }));
  const results = await pool.run(tasks);
  const wins = results.filter(r => r.winner === 'p1').length;
  const ties = results.filter(r => r.winner === 'tie').length;
  return { wins, losses: games - wins - ties, ties, winRate: wins / games, results };
}
