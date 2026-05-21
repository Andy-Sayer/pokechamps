// WebSocket auth helper. Browsers can't set Authorization headers on the WS
// handshake (only on the HTTP fallback), so we accept ?token=<jwt|pat> as a
// fallback. The header path remains canonical for Node clients (tui).
//
// Returns the resolved user payload or null. Does NOT send any reply — the
// caller decides how to surface the failure (HTTP routes 401; WS routes close
// with a 4401 frame).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getDb } from '../db/connection.js';
import { verifyPassword } from './passwords.js';
import type { JwtPayload } from './jwt.js';

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

export async function verifyTokenForLive(
  app: FastifyInstance,
  request: FastifyRequest<{ Querystring: { token?: string } }>,
): Promise<JwtPayload | null> {
  // Prefer the header — that's what server-to-server / Node clients send.
  const header = request.headers.authorization;
  const m = header ? BEARER.exec(header) : null;
  const raw = m ? m[1]!.trim() : (request.query.token ?? '').trim();
  if (!raw) return null;

  if (looksLikeJwt(raw)) {
    try {
      const payload = (await app.jwt.verify(raw)) as JwtPayload;
      if (payload && typeof payload.sub === 'string') return payload;
    } catch {
      // fall through to PAT attempt
    }
  }
  return tryApiToken(raw);
}
