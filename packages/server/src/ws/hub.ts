// matchHub — in-memory pub/sub keyed by match id. Routes subscribe a WebSocket
// when a client opens GET /matches/:id/live; engine + CRUD endpoints call
// broadcastMatch() after any mutation so every connected viewer of that match
// receives the updated state without polling.
//
// This is process-local. A multi-instance deploy will need to fan out via Redis
// pub/sub or similar — out of scope for v1, single-instance Fly machine.
import type { WebSocket } from 'ws';

const subscribers = new Map<string, Set<WebSocket>>();
// Sockets that authed via a share token (spectators). Tracked separately so a
// share revoke can close *just* the spectators for a match, leaving the
// owner's own authed connections (e.g. another device) untouched.
const spectatorSockets = new Set<WebSocket>();

export interface LiveEnvelope {
  type: 'snapshot' | 'update';
  match: unknown;
  // Optional: source of the update so clients can disambiguate echoes from
  // their own POSTs vs. peer-initiated changes (multi-tab, multi-device).
  source?: 'turn' | 'state' | 'crud';
}

export function subscribe(matchId: string, ws: WebSocket, spectator = false): void {
  let set = subscribers.get(matchId);
  if (!set) {
    set = new Set();
    subscribers.set(matchId, set);
  }
  set.add(ws);
  if (spectator) spectatorSockets.add(ws);
}

export function unsubscribe(matchId: string, ws: WebSocket): void {
  spectatorSockets.delete(ws);
  const set = subscribers.get(matchId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) subscribers.delete(matchId);
}

// Close every spectator (share-authed) socket for a match — called when the
// owner revokes the share. Owner-authed connections stay open. Returns the
// number of sockets closed. Each close fires the socket's 'close' handler,
// which calls unsubscribe() to tidy the maps.
export function closeSpectators(matchId: string, code = 4403, reason = 'share revoked'): number {
  const set = subscribers.get(matchId);
  if (!set) return 0;
  let closed = 0;
  for (const ws of [...set]) {
    if (!spectatorSockets.has(ws)) continue;
    try { ws.close(code, reason); } catch { /* ignore */ }
    closed += 1;
  }
  return closed;
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
  spectatorSockets.clear();
}

export function _subscriberCount(matchId: string): number {
  return subscribers.get(matchId)?.size ?? 0;
}
