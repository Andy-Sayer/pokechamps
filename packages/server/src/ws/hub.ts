// matchHub — in-memory pub/sub keyed by match id. Routes subscribe a WebSocket
// when a client opens GET /matches/:id/live; engine + CRUD endpoints call
// broadcastMatch() after any mutation so every connected viewer of that match
// receives the updated state without polling.
//
// This is process-local. A multi-instance deploy will need to fan out via Redis
// pub/sub or similar — out of scope for v1, single-instance Fly machine.
import type { WebSocket } from 'ws';

const subscribers = new Map<string, Set<WebSocket>>();

export interface LiveEnvelope {
  type: 'snapshot' | 'update';
  match: unknown;
  // Optional: source of the update so clients can disambiguate echoes from
  // their own POSTs vs. peer-initiated changes (multi-tab, multi-device).
  source?: 'turn' | 'state' | 'crud';
}

export function subscribe(matchId: string, ws: WebSocket): void {
  let set = subscribers.get(matchId);
  if (!set) {
    set = new Set();
    subscribers.set(matchId, set);
  }
  set.add(ws);
}

export function unsubscribe(matchId: string, ws: WebSocket): void {
  const set = subscribers.get(matchId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) subscribers.delete(matchId);
}

// Fire-and-forget broadcast. We serialize once and send to every live
// subscriber. A send() failure on one subscriber doesn't block the rest.
export function broadcastMatch(
  matchId: string,
  match: unknown,
  source: LiveEnvelope['source'] = 'crud',
): void {
  const set = subscribers.get(matchId);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify({ type: 'update', match, source } satisfies LiveEnvelope);
  for (const ws of set) {
    try {
      // readyState 1 = OPEN; skip closing/closed sockets.
      if (ws.readyState === 1) ws.send(payload);
    } catch {
      // ignored — close handler will reap this subscriber
    }
  }
}

// Test-only: drop every subscriber so the hub doesn't bleed state across
// freshApp() rebuilds in vitest.
export function _resetHub(): void {
  for (const set of subscribers.values()) {
    for (const ws of set) {
      try { ws.close(); } catch { /* ignore */ }
    }
  }
  subscribers.clear();
}

export function _subscriberCount(matchId: string): number {
  return subscribers.get(matchId)?.size ?? 0;
}
