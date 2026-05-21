// JWT plumbing. @fastify/jwt handles the actual sign/verify; this module
// configures it and exposes the payload shape the rest of the codebase uses.
//
// Tokens are short-lived (1h) — clients refresh by re-logging in or by using
// their long-lived API token to fetch a fresh JWT (Phase 2.3+). We don't
// implement refresh tokens; the API token IS the long-lived credential.
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance } from 'fastify';

export const JWT_DEV_PLACEHOLDER = 'dev-secret-change-me-before-prod';
export const JWT_EXPIRES_IN = '1h';

export interface JwtPayload {
  sub: string;    // user id
  email: string;
  /** Per-user token version, embedded at sign time. authenticate.ts rejects
   *  the JWT when this doesn't match the current users.token_version. Absent
   *  on PAT-authenticated requests (PATs are revoked via DELETE /tokens/:id
   *  instead). */
  tv?: number;
}

export function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  const isProd = process.env.NODE_ENV === 'production';
  if (!secret) {
    if (isProd) {
      throw new Error('JWT_SECRET is required in production');
    }
    // Dev fallback. We warn loudly so it's obvious in logs.
    // eslint-disable-next-line no-console
    console.warn('[auth] JWT_SECRET unset — using dev placeholder. Do NOT ship this.');
    return JWT_DEV_PLACEHOLDER;
  }
  if (isProd && secret === JWT_DEV_PLACEHOLDER) {
    throw new Error('JWT_SECRET must not be the dev placeholder in production');
  }
  return secret;
}

export async function registerJwt(app: FastifyInstance): Promise<void> {
  await app.register(fastifyJwt, {
    secret: resolveJwtSecret(),
    sign: { expiresIn: JWT_EXPIRES_IN },
  });
}

/** Read the current token_version for a user; defaults to 0 if the row is
 *  missing (caller should treat that as auth failure, not pass 0 silently). */
export function readTokenVersion(
  db: import('better-sqlite3').Database,
  userId: string,
): number | null {
  const row = db
    .prepare<[string], { token_version: number }>(
      'SELECT token_version FROM users WHERE id = ?',
    )
    .get(userId);
  return row?.token_version ?? null;
}

// Augment Fastify's request type so handlers can read request.user.
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}
