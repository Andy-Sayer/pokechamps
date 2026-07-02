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
import type { SearchBreadth } from './endgameSearch.js';
import { type CellCache, cellKey } from './cellCache.js';
import type { PokemonSet } from './types.js';

export interface PlayoutTask { p1: PokemonSet[]; p2: PokemonSet[]; seed: [number, number, number, number]; depth?: number; budgetMs?: number; pilotOpp?: boolean; breadth?: SearchBreadth; nodeBudget?: number }

const WORKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'playout-worker.ts');

interface Pending { resolve: (r: GameResult) => void; reject: (e: Error) => void; task: PlayoutTask }
interface QueueItem { id: number; p: Pending; tries: number }

const playSync = async (t: PlayoutTask): Promise<GameResult> => {
  const r = await playGame(t.p1, t.p2, {
    seed: t.seed,
    policy: makeSearchPolicy(t.p1, t.p2, t.depth ?? 2, t.budgetMs, t.breadth, t.nodeBudget),
    p2Policy: t.pilotOpp ? makePilotPolicy(t.p1, t.p2, t.depth ?? 2, derivePilotPlan(t.p2)) : undefined,
  });
  if ('error' in r) throw new Error(r.error);
  return r;
};

type Worker = { proc: ChildProcess; rl: Interface; busy: boolean; curId?: number };

export class PlayoutPool {
  private workers: Worker[] = [];
  private queue: QueueItem[] = [];
  private inflight = new Map<number, { p: Pending; tries: number }>();
  private nextId = 1;
  private usable = true;
  private closed = false;
  // Circuit breaker: deaths-without-an-intervening-success. A healthy pool resets
  // this on every completed game, so rare crashes never trip it; a fundamentally
  // broken pool (every worker dies before finishing anything) trips fast → we give
  // up on workers and fall back to synchronous play instead of looping forever.
  private deathsSinceProgress = 0;
  private static readonly MAX_TRIES = 3;

  constructor(private size: number = Math.max(1, Math.min(cpus().length - 1, 30))) {}

  private spawnWorker(): void {
    try {
      const proc = spawn(process.execPath, ['--import', 'tsx', WORKER], { stdio: ['pipe', 'pipe', 'inherit'] });
      const rl = createInterface({ input: proc.stdout! });
      const w: Worker = { proc, rl, busy: false };
      // Both 'error' (spawn/IO failure) and 'exit' (crash/OOM) funnel through the
      // same recovery path; handleDown is idempotent per worker.
      proc.on('error', () => this.handleDown(w));
      proc.on('exit', () => this.handleDown(w));
      rl.on('line', line => this.onLine(w, line));
      this.workers.push(w);
    } catch { /* couldn't spawn this one; ensure()/the breaker handle usability */ }
  }

  private ensure(): void {
    if (this.workers.length || !this.usable || this.closed) return;
    for (let i = 0; i < this.size; i++) this.spawnWorker();
    if (!this.workers.length) this.usable = false;
  }

  /** A worker died (crash, OOM, IO error). Requeue the task it was running so its
   *  Promise never hangs, respawn a replacement to hold the pool at size, and trip
   *  the breaker if nothing is making progress. */
  private handleDown(w: Worker): void {
    const idx = this.workers.indexOf(w);
    if (idx < 0) return; // already handled (error+exit can both fire)
    this.workers.splice(idx, 1);
    if (this.closed) return; // shutting down — nothing to recover
    if (w.curId !== undefined) {
      const entry = this.inflight.get(w.curId);
      if (entry) {
        this.inflight.delete(w.curId);
        if (entry.tries + 1 < PlayoutPool.MAX_TRIES) this.queue.push({ id: w.curId, p: entry.p, tries: entry.tries + 1 });
        else entry.p.reject(new Error('playout worker crashed repeatedly'));
      }
    }
    if (++this.deathsSinceProgress > this.size * 2) { this.usable = false; this.drainReject(); return; }
    if (this.usable && this.workers.length < this.size && (this.queue.length || this.inflight.size)) this.spawnWorker();
    this.pump();
  }

  /** Pool is unusable — fail everything outstanding so run()'s catch falls back to sync. */
  private drainReject(): void {
    for (const { p } of this.inflight.values()) p.reject(new Error('playout pool unusable'));
    this.inflight.clear();
    for (const q of this.queue) q.p.reject(new Error('playout pool unusable'));
    this.queue = [];
  }

  private onLine(w: Worker, line: string): void {
    const s = line.trim();
    if (!s) return;
    let msg: { id: number; ok: boolean; result?: GameResult; error?: string };
    try { msg = JSON.parse(s); } catch { return; }
    const entry = this.inflight.get(msg.id);
    if (!entry) return;
    this.inflight.delete(msg.id);
    w.busy = false;
    w.curId = undefined;
    this.deathsSinceProgress = 0; // progress made → reset the breaker
    if (msg.ok && msg.result) entry.p.resolve(msg.result);
    else entry.p.reject(new Error(msg.error ?? 'worker error'));
    this.pump();
  }

  private pump(): void {
    for (const w of this.workers) {
      if (w.busy) continue;
      const next = this.queue.shift();
      if (!next) return;
      w.busy = true;
      w.curId = next.id;
      this.inflight.set(next.id, { p: next.p, tries: next.tries });
      w.proc.stdin!.write(JSON.stringify({ id: next.id, ...next.p.task }) + '\n');
    }
  }

  private one(task: PlayoutTask): Promise<GameResult> {
    return new Promise<GameResult>((resolve, reject) => {
      const id = this.nextId++;
      this.queue.push({ id, p: { resolve, reject, task }, tries: 0 });
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
    this.closed = true; // exits from here on are intentional, not crashes to recover
    for (const w of this.workers) { try { w.proc.stdin!.end(); } catch { /* already gone */ } }
    this.workers = [];
  }
}

/** Win-rate for `myBring` vs `oppBring` over K paired-seed games (common random
 *  numbers — far less noise when comparing brings). Returns wins/games + the raw
 *  results (each a labeled training row). */
export async function bringWinRate(
  pool: PlayoutPool, myBring: PokemonSet[], oppBring: PokemonSet[], games: number, depth = 2, pilotP2 = false,
  opts: { budgetMs?: number; breadth?: SearchBreadth; nodeBudget?: number } = {},
): Promise<{ wins: number; losses: number; ties: number; winRate: number; results: GameResult[] }> {
  const tasks: PlayoutTask[] = Array.from({ length: games }, (_, k) => ({
    p1: myBring, p2: oppBring, seed: [k + 1, 2 * k + 5, 3 * k + 7, 5 * k + 11], depth, pilotOpp: pilotP2,
    budgetMs: opts.budgetMs, breadth: opts.breadth, nodeBudget: opts.nodeBudget,
  }));
  const results = await pool.run(tasks);
  const wins = results.filter(r => r.winner === 'p1').length;
  const ties = results.filter(r => r.winner === 'tie').length;
  return { wins, losses: games - wins - ties, ties, winRate: wins / games, results };
}

/** Cached win-rate for one 4v4 (my bring vs their bring), keyed by the mon SETS
 *  + eval mode. The reuse layer for the gauntlet AND evolution: any caller —
 *  bring-matrix, bringEval/bring-search — shares cells, so a mutated team only
 *  recomputes the brings touching the changed mon. Returns the rate (callers that
 *  need wins/games detail should use bringWinRate directly). */
export async function cachedBringWinRate(
  cache: CellCache, pool: PlayoutPool, my4: PokemonSet[], their4: PokemonSet[],
  games: number, depth = 2, pilotP2 = false, opts: { budgetMs?: number; breadth?: SearchBreadth } = {},
): Promise<number> {
  // Fold non-default settings into the cache mode so cells at different search
  // settings never collide — but keep the DEFAULT key byte-identical (no suffix)
  // so existing depth-2 cells stay reusable.
  const spl = opts.breadth?.switchPlyLimit, sk = opts.breadth?.spreadK, b = opts.budgetMs;
  let mode = `${pilotP2 ? 'pilot' : 'minimax'}-d${depth}`;
  if (spl !== undefined) mode += `-spl${spl}`;
  if (sk !== undefined) mode += `-sk${sk}`;
  if (b) mode += `-b${b}`;
  const key = cellKey(my4, their4, mode);
  const hit = cache.get(key, games);
  if (hit !== undefined) return hit;
  const wr = (await bringWinRate(pool, my4, their4, games, depth, pilotP2, opts)).winRate;
  cache.put(key, wr, games);
  return wr;
}
