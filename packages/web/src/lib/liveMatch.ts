// Browser-flavour WebSocket subscription for /matches/:id/live.
//
// Mirrors @pokechamps/core/storage/httpStore.ts subscribe() but stays
// type-only on the core import so we don't drag Node-y code into the bundle.
// Envelope shape is the same: { type: 'snapshot' | 'update', match }.
//
// The browser WS handshake can't set arbitrary headers, so the JWT rides
// the query string. Server enforces close codes:
//   4401 = unauthorized (bad/expired token)
//   4404 = match not found
//   1000 = normal closure (do not reconnect)
//   anything else = retry with backoff.
import type { Match } from '@pokechamps/core/domain/types.js';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'closed';

export interface LiveError {
  kind: 'unauthorized' | 'not-found' | 'gave-up' | 'network';
  message: string;
}

export interface LiveSubscription {
  unsubscribe(): void;
}

interface SubscribeOptions {
  onMatch: (match: Match) => void;
  onStatus?: (status: LiveStatus) => void;
  onError?: (err: LiveError) => void;
  // Test seam.
  WebSocketImpl?: typeof WebSocket;
}

// Backoff schedule (ms): 2s, 5s, 15s — then give up.
const BACKOFF_MS = [2_000, 5_000, 15_000];

export function subscribeLiveMatch(
  baseUrl: string,
  token: string,
  matchId: string,
  opts: SubscribeOptions,
): LiveSubscription {
  const Ctor = opts.WebSocketImpl ?? WebSocket;
  const wsBase = baseUrl.replace(/^http(s?):/, 'ws$1:').replace(/\/$/, '');
  const url =
    `${wsBase}/matches/${encodeURIComponent(matchId)}/live?token=${encodeURIComponent(token)}`;

  let ws: WebSocket | null = null;
  let cancelled = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const status = (s: LiveStatus): void => {
    if (cancelled) return;
    opts.onStatus?.(s);
  };

  const fail = (err: LiveError): void => {
    if (cancelled) return;
    opts.onError?.(err);
  };

  const connect = (): void => {
    if (cancelled) return;
    status(attempt === 0 ? 'connecting' : 'reconnecting');
    let socket: WebSocket;
    try {
      socket = new Ctor(url);
    } catch (e) {
      // Constructor itself failed (malformed URL etc.) — treat as network.
      scheduleRetry();
      fail({ kind: 'network', message: e instanceof Error ? e.message : 'ws ctor failed' });
      return;
    }
    ws = socket;

    socket.addEventListener('open', () => {
      if (cancelled) return;
      attempt = 0;
      status('live');
    });

    socket.addEventListener('message', (ev: MessageEvent) => {
      if (cancelled) return;
      try {
        const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
        const env = JSON.parse(raw) as { type?: string; match?: Match };
        if ((env.type === 'snapshot' || env.type === 'update') && env.match) {
          opts.onMatch(env.match);
        }
      } catch {
        // ignore malformed frames
      }
    });

    socket.addEventListener('close', (ev: CloseEvent) => {
      if (cancelled) return;
      ws = null;
      if (ev.code === 1000) {
        status('closed');
        return;
      }
      if (ev.code === 4401) {
        status('closed');
        fail({ kind: 'unauthorized', message: 'session expired — please sign in again' });
        return;
      }
      if (ev.code === 4404) {
        status('closed');
        fail({ kind: 'not-found', message: 'match not found' });
        return;
      }
      scheduleRetry();
    });

    socket.addEventListener('error', () => {
      // 'error' fires before 'close' on most failures. Surface it as
      // status only; the close handler decides whether to retry.
      if (cancelled) return;
      status('reconnecting');
    });
  };

  const scheduleRetry = (): void => {
    if (cancelled) return;
    if (attempt >= BACKOFF_MS.length) {
      status('closed');
      fail({ kind: 'gave-up', message: 'lost connection — refresh to retry' });
      return;
    }
    const delay = BACKOFF_MS[attempt] ?? 15_000;
    attempt += 1;
    status('reconnecting');
    retryTimer = setTimeout(connect, delay);
  };

  connect();

  return {
    unsubscribe(): void {
      cancelled = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (ws) {
        try {
          ws.close(1000);
        } catch {
          // ignore
        }
        ws = null;
      }
    },
  };
}
