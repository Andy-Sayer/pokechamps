// Spectator client helpers. A spectator has no account — the share token is
// the capability. We fetch the read-only snapshot over HTTP, then subscribe to
// the same live WS the owner uses, authed with ?share=<token>. See
// docs/notes/live-share-plan.md.
import type { Match } from '@pokechamps/core/domain/types.js';

export interface ShareTarget {
  /** Server origin, no trailing slash, e.g. https://pokechamps.duckdns.org */
  baseUrl: string;
  /** The share capability token. */
  token: string;
}

// Accept either a full spectator URL (https://host/spectate/<token>) — the
// friendly thing to paste — or a bare token, in which case fallbackBaseUrl
// (the configured server URL) supplies the origin. Returns null if neither
// yields a usable (baseUrl, token).
export function parseShareInput(input: string, fallbackBaseUrl?: string): ShareTarget | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Full URL form.
  try {
    const u = new URL(trimmed);
    const m = u.pathname.match(/\/spectate\/([^/]+)\/?$/);
    if (m && m[1]) {
      return { baseUrl: `${u.protocol}//${u.host}`, token: decodeURIComponent(m[1]) };
    }
  } catch {
    // not a URL — fall through to bare-token handling
  }
  // Bare token: needs a configured server URL to talk to.
  if (fallbackBaseUrl) {
    return { baseUrl: fallbackBaseUrl.replace(/\/$/, ''), token: trimmed };
  }
  return null;
}

// One-shot read-only snapshot. Throws on network error or a non-2xx (e.g. 404
// for a revoked/unknown token — the caller surfaces that to the user).
export async function fetchSpectateSnapshot(target: ShareTarget): Promise<Match> {
  const res = await fetch(`${target.baseUrl}/spectate/${encodeURIComponent(target.token)}`);
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? 'Share link not found — it may have been revoked.'
        : `Couldn't load match (${res.status}).`,
    );
  }
  return (await res.json()) as Match;
}

export type SpectateStatus = 'connecting' | 'live' | 'closed';

export interface SpectateHandlers {
  onMatch: (m: Match) => void;
  onStatus?: (s: SpectateStatus) => void;
}

// Subscribe to live frames for a match via the share token. matchId comes from
// the snapshot (match.id). Returns an unsubscribe fn. Read-only — we never send
// on this socket.
export function subscribeSpectate(
  target: ShareTarget,
  matchId: string,
  handlers: SpectateHandlers,
): () => void {
  const wsBase = target.baseUrl.replace(/^http(s?):/, 'ws$1:');
  const url = `${wsBase}/matches/${encodeURIComponent(matchId)}/live?share=${encodeURIComponent(target.token)}`;
  let closed = false;
  const ws = new WebSocket(url);
  handlers.onStatus?.('connecting');
  ws.addEventListener('open', () => { if (!closed) handlers.onStatus?.('live'); });
  ws.addEventListener('message', (ev: MessageEvent) => {
    if (closed) return;
    try {
      const env = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as { type?: string; match?: Match };
      if ((env.type === 'snapshot' || env.type === 'update') && env.match) handlers.onMatch(env.match);
    } catch {
      // ignore malformed frames
    }
  });
  ws.addEventListener('close', () => { if (!closed) handlers.onStatus?.('closed'); });
  return () => {
    closed = true;
    try { ws.close(); } catch { /* ignore */ }
  };
}
