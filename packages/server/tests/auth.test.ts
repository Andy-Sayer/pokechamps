// Auth integration tests. Each test gets a fresh in-memory sqlite DB by
// resetting the env + closing the connection singleton before buildApp().
//
// We use app.inject() — Fastify's built-in HTTP simulator — so no port is
// bound and tests stay hermetic.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closeDb } from '../src/db/connection.js';

// In-memory DB + a known JWT secret so jwtSign/verify is deterministic across
// the build. NODE_ENV=test avoids the prod-secret guard.
process.env.DATABASE_URL = 'file::memory:';
process.env.JWT_SECRET = 'test-secret-not-for-production-use-only-tests';
process.env.NODE_ENV = 'test';

let app: FastifyInstance;

beforeEach(async () => {
  // Drop the previous in-memory DB before each test so state doesn't leak.
  closeDb();
  ({ app } = await buildApp({ logger: false }));
});

afterEach(async () => {
  await app.close();
  closeDb();
});

const REGISTER_BODY = { email: 'alice@example.com', password: 'hunter22' };

describe('auth: register + login + me', () => {
  it('round trips register → me', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: REGISTER_BODY,
    });
    expect(reg.statusCode).toBe(200);
    const regBody = reg.json() as { token: string; user: { id: string; email: string } };
    expect(regBody.token).toBeTruthy();
    expect(regBody.user.email).toBe(REGISTER_BODY.email);
    expect(regBody.user.id).toMatch(/^[0-9a-f-]{36}$/);

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${regBody.token}` },
    });
    expect(me.statusCode).toBe(200);
    const meBody = me.json() as { user: { id: string; email: string; createdAt: string } };
    expect(meBody.user.id).toBe(regBody.user.id);
    expect(meBody.user.email).toBe(REGISTER_BODY.email);
    expect(meBody.user.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Crucially: no password_hash leakage.
    expect(JSON.stringify(meBody)).not.toContain('password');
  });

  it('login succeeds with correct password', async () => {
    await app.inject({ method: 'POST', url: '/auth/register', payload: REGISTER_BODY });
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: REGISTER_BODY,
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ user: { email: REGISTER_BODY.email } });
  });

  it('rejects duplicate email with 409', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: REGISTER_BODY,
    });
    expect(first.statusCode).toBe(200);

    const dup = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: REGISTER_BODY,
    });
    expect(dup.statusCode).toBe(409);
  });

  it('rejects wrong password with 401', async () => {
    await app.inject({ method: 'POST', url: '/auth/register', payload: REGISTER_BODY });
    const bad = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { ...REGISTER_BODY, password: 'wrong-password' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('rejects missing auth on /me', async () => {
    const me = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(me.statusCode).toBe(401);
  });

  it('rejects malformed register body with 400', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'not-an-email', password: 'short' },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('auth: API tokens', () => {
  async function registerAndJwt(): Promise<string> {
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: REGISTER_BODY,
    });
    return (reg.json() as { token: string }).token;
  }

  it('create + list + delete round trip', async () => {
    const jwt = await registerAndJwt();

    const create = await app.inject({
      method: 'POST',
      url: '/auth/tokens',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { name: 'andy laptop' },
    });
    expect(create.statusCode).toBe(200);
    const created = create.json() as {
      token: string;
      id: string;
      name: string;
      createdAt: string;
    };
    expect(created.token).toContain('.');
    expect(created.token.startsWith(`${created.id}.`)).toBe(true);
    expect(created.name).toBe('andy laptop');

    const list = await app.inject({
      method: 'GET',
      url: '/auth/tokens',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(list.statusCode).toBe(200);
    const tokens = list.json() as Array<{ id: string; name: string | null }>;
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.id).toBe(created.id);
    // No raw token returned on list — only metadata.
    expect(JSON.stringify(tokens)).not.toContain(created.token.split('.')[1]);

    const del = await app.inject({
      method: 'DELETE',
      url: `/auth/tokens/${created.id}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(del.statusCode).toBe(204);

    const afterDelete = await app.inject({
      method: 'GET',
      url: '/auth/tokens',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(afterDelete.json()).toHaveLength(0);
  });

  it('API token authenticates against /me', async () => {
    const jwt = await registerAndJwt();
    const create = await app.inject({
      method: 'POST',
      url: '/auth/tokens',
      headers: { authorization: `Bearer ${jwt}` },
      payload: {},
    });
    const { token: apiToken } = create.json() as { token: string };

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${apiToken}` },
    });
    expect(me.statusCode).toBe(200);
    const meBody = me.json() as { user: { email: string } };
    expect(meBody.user.email).toBe(REGISTER_BODY.email);
  });

  it('rejects garbage token with 401', async () => {
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: 'Bearer not.a.real.token' },
    });
    expect(me.statusCode).toBe(401);
  });

  it("can't delete another user's token", async () => {
    // Alice creates a token.
    const aliceJwt = await registerAndJwt();
    const aliceTokenRes = await app.inject({
      method: 'POST',
      url: '/auth/tokens',
      headers: { authorization: `Bearer ${aliceJwt}` },
      payload: { name: 'alice' },
    });
    const aliceTokenId = (aliceTokenRes.json() as { id: string }).id;

    // Bob registers; tries to delete Alice's token.
    const bobReg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'bob@example.com', password: 'hunter22' },
    });
    const bobJwt = (bobReg.json() as { token: string }).token;

    const del = await app.inject({
      method: 'DELETE',
      url: `/auth/tokens/${aliceTokenId}`,
      headers: { authorization: `Bearer ${bobJwt}` },
    });
    expect(del.statusCode).toBe(404);

    // Alice's token still exists.
    const list = await app.inject({
      method: 'GET',
      url: '/auth/tokens',
      headers: { authorization: `Bearer ${aliceJwt}` },
    });
    expect(list.json()).toHaveLength(1);
  });
});

describe('JWT token_version revocation', () => {
  it('POST /auth/logout-all invalidates every JWT in flight for that user', async () => {
    const r1 = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { email: 'rev@example.com', password: 'hunter22' },
    });
    expect(r1.statusCode).toBe(200);
    const { token: oldJwt } = r1.json() as { token: string };

    // Sanity: the fresh token works.
    const me1 = await app.inject({
      method: 'GET', url: '/auth/me',
      headers: { authorization: `Bearer ${oldJwt}` },
    });
    expect(me1.statusCode).toBe(200);

    // Revoke.
    const logout = await app.inject({
      method: 'POST', url: '/auth/logout-all',
      headers: { authorization: `Bearer ${oldJwt}` },
    });
    expect(logout.statusCode).toBe(204);

    // Same JWT now fails with 401 'token revoked'.
    const me2 = await app.inject({
      method: 'GET', url: '/auth/me',
      headers: { authorization: `Bearer ${oldJwt}` },
    });
    expect(me2.statusCode).toBe(401);
    expect(me2.json()).toMatchObject({ error: 'token revoked' });

    // A fresh login mints a new JWT that works.
    const login = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: 'rev@example.com', password: 'hunter22' },
    });
    expect(login.statusCode).toBe(200);
    const { token: newJwt } = login.json() as { token: string };
    const me3 = await app.inject({
      method: 'GET', url: '/auth/me',
      headers: { authorization: `Bearer ${newJwt}` },
    });
    expect(me3.statusCode).toBe(200);
  });

  it('PATs survive a JWT revocation (different revocation path)', async () => {
    // Register, mint a PAT, then bump token_version. The PAT should still
    // authenticate because PATs aren't versioned — they live in api_tokens
    // and only DELETE /tokens/:id invalidates them.
    const reg = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { email: 'pat@example.com', password: 'hunter22' },
    });
    const { token: jwt } = reg.json() as { token: string };
    const tok = await app.inject({
      method: 'POST', url: '/auth/tokens',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { name: 'cli' },
    });
    const { token: pat } = tok.json() as { token: string };
    await app.inject({
      method: 'POST', url: '/auth/logout-all',
      headers: { authorization: `Bearer ${jwt}` },
    });
    const me = await app.inject({
      method: 'GET', url: '/auth/me',
      headers: { authorization: `Bearer ${pat}` },
    });
    expect(me.statusCode).toBe(200);
  });
});

describe('health', () => {
  it('returns ok with schema version', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { status: string; db: string; schemaLatest: string };
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
    expect(body.schemaLatest).toBe('005_user_token_version');
  });
});
