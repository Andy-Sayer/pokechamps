// WebSocket auth helper. Browsers can't set Authorization headers on the WS
// handshake. Two safe paths:
//
//   - Node clients (TUI) send Authorization: Bearer <jwt|pat>. The token
//     never appears in a URL — preferred path.
//   - Browser clients first POST /matches/:id/live-ticket to mint a
//     single-use, scoped, 30s ticket, then upgrade with ?ticket=…. The
//     long-lived credential never enters a URL.
//
// `?token=` is also accepted for backwards-compat with the original Phase 2.5
// shape but should be removed before public deploy.
//
// Returns the resolved user payload or null. Does NOT send any reply — the
// caller decides how to surface the failure (HTTP routes 401; WS routes close
// with a 4401 frame).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getDb } from '../db/connection.js';
import { verifyPassword } from './passwords.js';
import type { JwtPayload } from './jwt.js';
import { consumeTicket } from '../ws/tickets.js';
import { resolveShare } from '../db/shares.js';
import { readTokenVersion } from './jwt.js';

const BEARER = /^Bearer\s+(.+)$/i;

function looksLikeJwt(token: string): boolean {
  return token.split('.').length === 3;
}

async function tryApiToken(token: string): Promise<JwtPayload | null> {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const id = token.slice(0, dot);
  const secret = token.slice(dot + 1);

  const db = getDb();
  const row = db
    .prepare<[string], { user_id: string; token_hash: string; email: string }>(
      `SELECT t.user_id AS user_id, t.token_hash AS token_hash, u.email AS email
       FROM api_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = ?`,
    )
    .get(id);
  if (!row) return null;

  const ok = await verifyPassword(secret, row.token_hash);
  if (!ok) return null;
  return { sub: row.user_id, email: row.email };
}

export interface LiveAuthResult {
  user: JwtPayload;
  /** Set when the auth came via a ticket OR a share token — the caller must
   *  verify this matches the URL's match id to prevent cross-match reuse. */
  ticketMatchId?: string;
  /** True when authed via a share token (read-only spectator). The live route
   *  is read-only regardless, but this lets callers distinguish a spectator
   *  from the owner if they ever need to. */
  spectator?: boolean;
}

export async function verifyTokenForLive(
  app: FastifyInstance,
  request: FastifyRequest<{ Querystring: { token?: string; ticket?: string; share?: string } }>,
): Promise<LiveAuthResult | null> {
  // 0) Share path (spectator): persistent, multi-use capability token. Resolves
  // to the OWNER's id + the match it unlocks; the route then loads that match
  // and the scope check (ticketMatchId === matchId) prevents cross-match reuse.
  // Read-only is guaranteed by the socket ignoring inbound frames.
  const share = (request.query.share ?? '').trim();
  if (share) {
    const resolved = resolveShare(getDb(), share);
    if (!resolved) return null;
    const db = getDb();
    const row = db
      .prepare<[string], { email: string; token_version: number }>(
        'SELECT email, token_version FROM users WHERE id = ?',
      )
      .get(resolved.ownerId);
    if (!row) return null;
    return {
      user: { sub: resolved.ownerId, email: row.email, tv: row.token_version },
      ticketMatchId: resolved.matchId,
      spectator: true,
    };
  }

  // 1) Ticket path (browser): single-use, scoped, 30s TTL.
  const ticket = (request.query.ticket ?? '').trim();
  if (ticket) {
    const consumed = consumeTicket(ticket);
    if (!consumed) return null;
    // Look up the email so the resulting payload mirrors what jwtVerify would
    // produce. We trust the ticket's userId because issueTicket only stores
    // an authenticated user's id.
    const db = getDb();
    const row = db
      .prepare<[string], { email: string; token_version: number }>(
        'SELECT email, token_version FROM users WHERE id = ?',
      )
      .get(consumed.userId);
    if (!row) return null;
    return {
      user: { sub: consumed.userId, email: row.email, tv: row.token_version },
      ticketMatchId: consumed.matchId,
    };
  }

  // 2) Header / legacy ?token= path.
  const header = request.headers.authorization;
  const m = header ? BEARER.exec(header) : null;
  const raw = m ? m[1]!.trim() : (request.query.token ?? '').trim();
  if (!raw) return null;

  if (looksLikeJwt(raw)) {
    try {
      const payload = (await app.jwt.verify(raw)) as JwtPayload;
      if (payload && typeof payload.sub === 'string') {
        // Honor the same token_version revocation that HTTP authenticate uses.
        const currentTv = readTokenVersion(getDb(), payload.sub);
        if (currentTv === null || payload.tv !== currentTv) return null;
        return { user: payload };
      }
    } catch {
      // fall through to PAT attempt
    }
  }
  const pat = await tryApiToken(raw);
  return pat ? { user: pat } : null;
}
