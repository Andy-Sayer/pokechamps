// Matches CRUD integration tests. Server assigns ids; the list endpoint
// projects to MatchSummary; ownership is enforced via WHERE user_id = ?.
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

// A minimal Match-shaped object. We don't need a fully-typed Match here —
// the server treats it as an opaque blob; only startedAt / outcome /
// myTeam[].species / opponentTeam[].species are inspected.
function buildMatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startedAt: '2026-05-01T12:00:00.000Z',
    myTeam: [
      { species: 'Sneasler' },
      { species: 'Rillaboom' },
      { species: 'Iron Hands' },
      { species: 'Flutter Mane' },
    ],
    opponentTeam: [
      { species: 'Incineroar', knownMoves: [] },
      { species: 'Amoonguss', knownMoves: [] },
    ],
    bring: [0, 1, 2, 3],
    turns: [],
    field: {
      weather: null, terrain: null, trickRoom: false,
      myTailwind: false, theirTailwind: false,
      myReflect: false, myLightScreen: false,
      theirReflect: false, theirLightScreen: false,
    },
    active: { mine: [null, null], theirs: [null, null] },
    ...overrides,
  };
}

describe('matches: CRUD', () => {
  it('POST creates with server-side id; GET-by-id returns full match', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const post = await app.inject({
      method: 'POST', url: '/matches',
      headers: authHeaders(token), payload: { match: buildMatch() },
    });
    expect(post.statusCode).toBe(200);
    const created = post.json() as { id: string; match: Record<string, unknown> };
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.match.id).toBe(created.id);

    const get = await app.inject({
      method: 'GET', url: `/matches/${created.id}`, headers: authHeaders(token),
    });
    expect(get.statusCode).toBe(200);
    const fetched = get.json() as Record<string, unknown>;
    expect(fetched.id).toBe(created.id);
    expect(fetched.startedAt).toBe('2026-05-01T12:00:00.000Z');
  });

  it('POST overrides any id in the body with a server-assigned UUID', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const post = await app.inject({
      method: 'POST', url: '/matches',
      headers: authHeaders(token),
      payload: { match: buildMatch({ id: 'client-supplied-bogus-id' }) },
    });
    expect(post.statusCode).toBe(200);
    const { id, match } = post.json() as { id: string; match: { id: string } };
    expect(id).not.toBe('client-supplied-bogus-id');
    expect(match.id).toBe(id);

    // The fetched copy reflects the server id, not the client's.
    const get = await app.inject({
      method: 'GET', url: `/matches/${id}`, headers: authHeaders(token),
    });
    expect((get.json() as { id: string }).id).toBe(id);
  });

  it('GET / returns MatchSummary shape with denormalized outcome + species', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    await app.inject({
      method: 'POST', url: '/matches',
      headers: authHeaders(token),
      payload: { match: buildMatch({ outcome: 'victory' }) },
    });

    const list = await app.inject({
      method: 'GET', url: '/matches', headers: authHeaders(token),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as Array<{
      id: string;
      startedAt: string;
      outcome?: string;
      myTeamSpecies?: string[];
      opponentTeamSpecies?: string[];
    }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.outcome).toBe('victory');
    expect(body[0]!.myTeamSpecies).toEqual(['Sneasler', 'Rillaboom', 'Iron Hands', 'Flutter Mane']);
    expect(body[0]!.opponentTeamSpecies).toEqual(['Incineroar', 'Amoonguss']);
    // The full blob is NOT in the list response.
    expect(body[0]).not.toHaveProperty('turns');
    expect(body[0]).not.toHaveProperty('field');
  });

  it('list sorts newest first by startedAt', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    await app.inject({
      method: 'POST', url: '/matches',
      headers: authHeaders(token),
      payload: { match: buildMatch({ startedAt: '2026-04-01T00:00:00.000Z' }) },
    });
    await app.inject({
      method: 'POST', url: '/matches',
      headers: authHeaders(token),
      payload: { match: buildMatch({ startedAt: '2026-05-01T00:00:00.000Z' }) },
    });
    await app.inject({
      method: 'POST', url: '/matches',
      headers: authHeaders(token),
      payload: { match: buildMatch({ startedAt: '2026-03-01T00:00:00.000Z' }) },
    });

    const list = await app.inject({
      method: 'GET', url: '/matches', headers: authHeaders(token),
    });
    const body = list.json() as Array<{ startedAt: string }>;
    expect(body.map(m => m.startedAt)).toEqual([
      '2026-05-01T00:00:00.000Z',
      '2026-04-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
    ]);
  });

  it('PATCH replaces; subsequent GET shows new state', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const post = await app.inject({
      method: 'POST', url: '/matches',
      headers: authHeaders(token), payload: { match: buildMatch() },
    });
    const { id } = post.json() as { id: string };

    const patched = buildMatch({ outcome: 'defeat', startedAt: '2026-06-01T00:00:00.000Z' });
    const patch = await app.inject({
      method: 'PATCH', url: `/matches/${id}`,
      headers: authHeaders(token), payload: { match: patched },
    });
    expect(patch.statusCode).toBe(200);
    const after = patch.json() as Record<string, unknown>;
    expect(after.id).toBe(id);
    expect(after.outcome).toBe('defeat');

    // List should reflect the new outcome + startedAt.
    const list = await app.inject({
      method: 'GET', url: '/matches', headers: authHeaders(token),
    });
    const summary = (list.json() as Array<{ id: string; outcome?: string; startedAt: string }>)
      .find(m => m.id === id)!;
    expect(summary.outcome).toBe('defeat');
    expect(summary.startedAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('DELETE removes the match', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const post = await app.inject({
      method: 'POST', url: '/matches',
      headers: authHeaders(token), payload: { match: buildMatch() },
    });
    const { id } = post.json() as { id: string };

    const del = await app.inject({
      method: 'DELETE', url: `/matches/${id}`, headers: authHeaders(token),
    });
    expect(del.statusCode).toBe(204);

    const get = await app.inject({
      method: 'GET', url: `/matches/${id}`, headers: authHeaders(token),
    });
    expect(get.statusCode).toBe(404);

    const del2 = await app.inject({
      method: 'DELETE', url: `/matches/${id}`, headers: authHeaders(token),
    });
    expect(del2.statusCode).toBe(404);
  });

  it("user A's GET / list / PATCH / DELETE on user B's match all return 404", async () => {
    const alice = await registerUser(app, 'alice@test.example');
    const bob = await registerUser(app, 'bob@test.example');

    const post = await app.inject({
      method: 'POST', url: '/matches',
      headers: authHeaders(alice.token), payload: { match: buildMatch() },
    });
    const { id } = post.json() as { id: string };

    const bobGet = await app.inject({
      method: 'GET', url: `/matches/${id}`, headers: authHeaders(bob.token),
    });
    expect(bobGet.statusCode).toBe(404);

    const bobList = await app.inject({
      method: 'GET', url: '/matches', headers: authHeaders(bob.token),
    });
    expect(bobList.json()).toEqual([]);

    const bobPatch = await app.inject({
      method: 'PATCH', url: `/matches/${id}`,
      headers: authHeaders(bob.token), payload: { match: buildMatch({ outcome: 'tie' }) },
    });
    expect(bobPatch.statusCode).toBe(404);

    const bobDel = await app.inject({
      method: 'DELETE', url: `/matches/${id}`, headers: authHeaders(bob.token),
    });
    expect(bobDel.statusCode).toBe(404);

    // Alice's match is untouched (outcome still null, not 'tie').
    const aliceGet = await app.inject({
      method: 'GET', url: `/matches/${id}`, headers: authHeaders(alice.token),
    });
    const fetched = aliceGet.json() as { outcome?: string };
    expect(fetched.outcome ?? null).toBeNull();
  });

  it('bodyLimit: 300KB body returns 413', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    // Construct a match with a giant `notes` field — overshoot the 256KB cap.
    const huge = 'x'.repeat(300 * 1024);
    const r = await app.inject({
      method: 'POST', url: '/matches',
      headers: authHeaders(token),
      payload: { match: buildMatch({ notes: huge }) },
    });
    expect(r.statusCode).toBe(413);
  });
});
