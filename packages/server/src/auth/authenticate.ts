// Authentication preHandler. Accepts either:
//   1. A JWT (three dot-separated base64 segments, signed with JWT_SECRET).
//   2. A long-lived API token in `<rowId>.<secret>` form — looked up against
//      the api_tokens table, secret half bcrypt-verified.
//
// We try JWT first because it's the cheaper path (no DB hit, no bcrypt). If
// the token has exactly one dot we know it's a PAT and skip the JWT attempt.
//
// Sets `request.user = { sub, email }` on success. 401 on failure.
import type { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { getDb } from '../db/connection.js';
import { verifyPassword } from './passwords.js';
import type { JwtPayload } from './jwt.js';

const BEARER = /^Bearer\s+(.+)$/i;

function looksLikeJwt(token: string): boolean {
  // A JWT has exactly two dots (header.payload.signature). A PAT has exactly
  // one (id.secret). Different counts → invalid in both schemes.
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

  // Bump last_used_at. We don't await this in a transaction; a failed update
  // shouldn't fail the request, just means stale timestamp.
  try {
    db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      id,
    );
  } catch {
    // ignore — clock or write contention isn't worth a 500
  }

  return { sub: row.user_id, email: row.email };
}

export function authenticateFactory(app: FastifyInstance) {
  return async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const header = request.headers.authorization;
    const match = header ? BEARER.exec(header) : null;
    if (!match) {
      await reply.code(401).send({ error: 'missing or malformed Authorization header' });
      return;
    }
    const token = match[1]!.trim();

    if (looksLikeJwt(token)) {
      try {
        // verify() sets request.user as a side effect (via @fastify/jwt typing).
        await request.jwtVerify();
        return;
      } catch {
        // fall through to API-token attempt — token could still be a malformed PAT
      }
    }

    const apiUser = await tryApiToken(token);
    if (apiUser) {
      // Mirror what jwtVerify would have done: stash the user on the request.
      // We cast because @fastify/jwt's type augmentation expects its own payload.
      (request as FastifyRequest & { user: JwtPayload }).user = apiUser;
      return;
    }

    await reply.code(401).send({ error: 'invalid token' });
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: ReturnType<typeof authenticateFactory>;
  }
}
