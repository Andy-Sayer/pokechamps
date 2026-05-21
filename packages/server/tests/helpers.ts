// Shared test helpers. Every test file should:
//   1. Set the env vars at module top-level (DATABASE_URL=:memory:, etc.) so
//      buildApp() picks up the in-memory sqlite singleton.
//   2. Use beforeEach/afterEach to close+reopen so state doesn't leak.
//
// freshApp() handles step 2. registerUser() bypasses the 5/min credential
// rate limit by registering once and handing back the JWT; pass it via
// `headers: { authorization: 'Bearer ${token}' }` on subsequent inject()
// calls instead of re-logging in.
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closeDb } from '../src/db/connection.js';

export async function freshApp(): Promise<FastifyInstance> {
  closeDb();
  const { app } = await buildApp({ logger: false });
  return app;
}

export async function disposeApp(app: FastifyInstance): Promise<void> {
  await app.close();
  closeDb();
}

export interface RegisteredUser {
  token: string;
  userId: string;
  email: string;
}

export async function registerUser(
  app: FastifyInstance,
  email: string,
  password = 'hunter22',
): Promise<RegisteredUser> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`registerUser(${email}) failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json() as { token: string; user: { id: string; email: string } };
  return { token: body.token, userId: body.user.id, email: body.user.email };
}

export function authHeaders(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}
