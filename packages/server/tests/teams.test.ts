// Teams CRUD integration tests. Uses the in-memory sqlite isolation pattern
// from auth.test.ts, lifted into tests/helpers.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeaders, disposeApp, freshApp, registerUser } from './helpers.js';

process.env.DATABASE_URL = 'file::memory:';
process.env.JWT_SECRET = 'test-secret-not-for-production-use-only-tests';
process.env.NODE_ENV = 'test';

let app: FastifyInstance;

beforeEach(async () => {
  app = await freshApp();
});

afterEach(async () => {
  await disposeApp(app);
});

const SAMPLE_TEAM = [
  {
    species: 'Sneasler',
    level: 50,
    nature: 'Jolly',
    item: 'Focus Sash',
    ability: 'Unburden',
    evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    moves: ['Close Combat', 'Dire Claw', 'Fake Out', 'Protect'],
  },
];

describe('teams: CRUD', () => {
  it('PUT then GET returns the saved team', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const put = await app.inject({
      method: 'PUT',
      url: '/teams/main',
      headers: authHeaders(token),
      payload: { team: SAMPLE_TEAM },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ name: 'main', team: SAMPLE_TEAM });

    const get = await app.inject({
      method: 'GET',
      url: '/teams/main',
      headers: authHeaders(token),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ name: 'main', team: SAMPLE_TEAM });
  });

  it('GET / lists saved teams sorted by name', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    await app.inject({
      method: 'PUT', url: '/teams/zeta',
      headers: authHeaders(token), payload: { team: SAMPLE_TEAM },
    });
    await app.inject({
      method: 'PUT', url: '/teams/alpha',
      headers: authHeaders(token), payload: { team: SAMPLE_TEAM },
    });
    const list = await app.inject({
      method: 'GET',
      url: '/teams',
      headers: authHeaders(token),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as Array<{ name: string }>;
    expect(body.map(t => t.name)).toEqual(['alpha', 'zeta']);
  });

  it('PUT to existing name overwrites (upsert)', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    await app.inject({
      method: 'PUT', url: '/teams/main',
      headers: authHeaders(token), payload: { team: SAMPLE_TEAM },
    });
    const updatedTeam = [{ ...SAMPLE_TEAM[0], item: 'Life Orb' }];
    const put2 = await app.inject({
      method: 'PUT',
      url: '/teams/main',
      headers: authHeaders(token),
      payload: { team: updatedTeam },
    });
    expect(put2.statusCode).toBe(200);

    const get = await app.inject({
      method: 'GET', url: '/teams/main', headers: authHeaders(token),
    });
    expect((get.json() as { team: typeof updatedTeam }).team[0]!.item).toBe('Life Orb');

    // And there's still only one team named "main".
    const list = await app.inject({
      method: 'GET', url: '/teams', headers: authHeaders(token),
    });
    expect((list.json() as unknown[])).toHaveLength(1);
  });

  it('DELETE removes the team; subsequent GET = 404', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    await app.inject({
      method: 'PUT', url: '/teams/main',
      headers: authHeaders(token), payload: { team: SAMPLE_TEAM },
    });

    const del = await app.inject({
      method: 'DELETE', url: '/teams/main', headers: authHeaders(token),
    });
    expect(del.statusCode).toBe(204);

    const get = await app.inject({
      method: 'GET', url: '/teams/main', headers: authHeaders(token),
    });
    expect(get.statusCode).toBe(404);

    // DELETE again is also 404 (idempotent semantics aside, we report missing).
    const del2 = await app.inject({
      method: 'DELETE', url: '/teams/main', headers: authHeaders(token),
    });
    expect(del2.statusCode).toBe(404);
  });

  it("user A can't see user B's team (404, not 403)", async () => {
    const alice = await registerUser(app, 'alice@test.example');
    const bob = await registerUser(app, 'bob@test.example');

    await app.inject({
      method: 'PUT', url: '/teams/secret',
      headers: authHeaders(alice.token), payload: { team: SAMPLE_TEAM },
    });

    const bobGet = await app.inject({
      method: 'GET', url: '/teams/secret', headers: authHeaders(bob.token),
    });
    expect(bobGet.statusCode).toBe(404);

    const bobList = await app.inject({
      method: 'GET', url: '/teams', headers: authHeaders(bob.token),
    });
    expect(bobList.json()).toEqual([]);

    const bobDel = await app.inject({
      method: 'DELETE', url: '/teams/secret', headers: authHeaders(bob.token),
    });
    expect(bobDel.statusCode).toBe(404);

    // Alice's team is untouched.
    const aliceGet = await app.inject({
      method: 'GET', url: '/teams/secret', headers: authHeaders(alice.token),
    });
    expect(aliceGet.statusCode).toBe(200);
  });

  it('malformed body (missing team field) returns 400', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const r = await app.inject({
      method: 'PUT',
      url: '/teams/main',
      headers: authHeaders(token),
      payload: { notTheTeamField: [] },
    });
    expect(r.statusCode).toBe(400);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const r = await app.inject({ method: 'GET', url: '/teams' });
    expect(r.statusCode).toBe(401);
  });
});
