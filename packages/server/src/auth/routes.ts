// Auth routes plugin. Mounted at /auth (see index.ts) so paths here are
// relative: /register, /login, /me, /tokens.
//
// Response shapes never leak password_hash or token_hash. Inputs are
// zod-validated; we return 400 with the zod issue list on parse failure
// (clients want a precise field name, not just "Bad Request").
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { newId, newTokenSecret } from './ids.js';
import { readTokenVersion, type JwtPayload } from './jwt.js';
import { isLocked, recordFailure, clearFailures } from './loginThrottle.js';

const credentialsSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(200),
  // Invite code — required only when REGISTRATION_SECRET is set on the server.
  invite: z.string().max(200).optional(),
});

// Registration gate. When REGISTRATION_SECRET is set, /register requires a
// matching `invite` (constant-time compare). Unset → registration is open
// (dev / single-user convenience). See SHARE.md + DEPLOY.md.
function inviteAccepted(provided: string | undefined): boolean {
  const required = process.env.REGISTRATION_SECRET;
  if (!required) return true;
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(required);
  // timingSafeEqual throws on length mismatch — guard so a wrong-length guess
  // returns false instead of erroring (and doesn't leak length via exception).
  return a.length === b.length && timingSafeEqual(a, b);
}

const createTokenSchema = z.object({
  name: z.string().min(1).max(100).optional(),
});

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
}

function publicUser(row: UserRow) {
  return { id: row.id, email: row.email, createdAt: row.created_at };
}

function badRequest(reply: FastifyReply, err: z.ZodError) {
  return reply.code(400).send({
    error: 'invalid request body',
    issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
  });
}

// Strict bucket on the credential endpoints — separate from the global limit.
// Credentials are tiny; a 4KB body limit stops anyone streaming junk at the
// bcrypt-backed endpoints.
const credentialRateLimit = {
  bodyLimit: 4 * 1024,
  config: {
    rateLimit: {
      max: 5,
      timeWindow: '1 minute',
    },
  },
};

const authRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const db = getDb();

  app.post('/register', credentialRateLimit, async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const { email, password, invite } = parsed.data;

    if (!inviteAccepted(invite)) {
      return reply.code(403).send({ error: 'invalid or missing invite code' });
    }

    const existing = db
      .prepare<[string], { id: string }>('SELECT id FROM users WHERE email = ? COLLATE NOCASE')
      .get(email);
    if (existing) {
      // Anti-enumeration: don't confirm the email exists, and don't return
      // faster than the happy path. The success branch spends ~250ms in
      // bcrypt; a fast "already registered" reply would let an attacker probe
      // which emails have accounts via timing. So we burn an equivalent hash
      // and return a generic message. (Registration is also invite-gated, so
      // an uninvited attacker can't reach this branch at all.)
      await hashPassword(password);
      return reply.code(409).send({ error: 'registration could not be completed' });
    }

    const id = newId();
    const password_hash = await hashPassword(password);
    const created_at = new Date().toISOString();
    db.prepare(
      'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
    ).run(id, email, password_hash, created_at);

    // Fresh user → token_version starts at 0 (column default).
    const token = await reply.jwtSign({ sub: id, email, tv: 0 });
    return reply.code(200).send({
      token,
      user: { id, email },
    });
  });

  app.post('/login', credentialRateLimit, async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const { email, password } = parsed.data;

    // Per-ACCOUNT throttle: the per-IP bucket above is defeated by rotating
    // IPs; this locks the targeted account after repeated failures. Checked
    // before the bcrypt spend so a locked account costs us nothing.
    if (isLocked(email)) {
      return reply.code(429).send({ error: 'too many failed attempts — try again later' });
    }

    const row = db
      .prepare<[string], UserRow>(
        'SELECT id, email, password_hash, created_at FROM users WHERE email = ? COLLATE NOCASE',
      )
      .get(email);
    // Always run a bcrypt compare even on missing user, to avoid leaking
    // account existence via response timing.
    const placeholderHash =
      '$2b$12$abcdefghijklmnopqrstuuKZ0FtY9C6vV6c0p9Yqo4SX1XvKxqyAW';
    const ok = await verifyPassword(password, row?.password_hash ?? placeholderHash);
    if (!row || !ok) {
      recordFailure(email);
      return reply.code(401).send({ error: 'invalid email or password' });
    }
    clearFailures(email);

    const tv = readTokenVersion(db, row.id) ?? 0;
    const token = await reply.jwtSign({ sub: row.id, email: row.email, tv });
    return reply.code(200).send({
      token,
      user: { id: row.id, email: row.email },
    });
  });

  // Bump the user's token_version so every JWT issued before this call is
  // immediately rejected by authenticate.ts. Useful after a password reset,
  // lost device, or compromise. PATs (api_tokens) are unaffected.
  app.post('/logout-all', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user as JwtPayload;
    const info = db
      .prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?')
      .run(user.sub);
    if (info.changes === 0) {
      return reply.code(404).send({ error: 'user not found' });
    }
    return reply.code(204).send();
  });

  app.get('/me', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user as JwtPayload;
    const row = db
      .prepare<[string], UserRow>(
        'SELECT id, email, password_hash, created_at FROM users WHERE id = ?',
      )
      .get(user.sub);
    if (!row) return reply.code(404).send({ error: 'user not found' });
    return { user: publicUser(row) };
  });

  app.post('/tokens', { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = createTokenSchema.safeParse(request.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    const { name } = parsed.data;
    const user = request.user as JwtPayload;

    // PAT format: `<rowId>.<secret>`. We store only bcrypt(secret); the id
    // is the table key so lookup is O(1).
    const id = newId();
    const secret = newTokenSecret();
    const token_hash = await hashPassword(secret);
    const created_at = new Date().toISOString();

    db.prepare(
      `INSERT INTO api_tokens (id, user_id, token_hash, name, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(id, user.sub, token_hash, name ?? null, created_at);

    return reply.code(200).send({
      // Returned exactly once — the client must persist it now.
      token: `${id}.${secret}`,
      id,
      name: name ?? null,
      createdAt: created_at,
    });
  });

  app.get('/tokens', { preHandler: app.authenticate }, async (request) => {
    const user = request.user as JwtPayload;
    const rows = db
      .prepare<
        [string],
        { id: string; name: string | null; created_at: string; last_used_at: string | null }
      >(
        `SELECT id, name, created_at, last_used_at
         FROM api_tokens
         WHERE user_id = ?
         ORDER BY created_at DESC`,
      )
      .all(user.sub);
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  });

  app.delete<{ Params: { id: string } }>(
    '/tokens/:id',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user as JwtPayload;
      const { id } = request.params;
      // Scope the delete to the authed user so one user can't revoke another's
      // tokens by guessing ids.
      const info = db
        .prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?')
        .run(id, user.sub);
      if (info.changes === 0) {
        return reply.code(404).send({ error: 'token not found' });
      }
      return reply.code(204).send();
    },
  );
};

export default authRoutes;
