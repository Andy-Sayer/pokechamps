// Share-token + spectator tests. Covers the owner CRUD (POST/GET/DELETE
// /matches/:id/share), the unauthenticated snapshot (GET /spectate/:token),
// and the live WS spectator path (?share=). Mirrors ws-match.test.ts's
// injectWS helper for the socket cases.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeaders, disposeApp, freshApp, registerUser } from './helpers.js';
import { _resetHub } from '../src/ws/hub.js';

process.env.DATABASE_URL = 'file::memory:';
process.env.JWT_SECRET = 'test-secret-not-for-production-use-only-tests';
process.env.NODE_ENV = 'test';

let app: FastifyInstance;

beforeEach(async () => {
  app = await freshApp();
});

afterEach(async () => {
  _resetHub();
  await disposeApp(app);
});

function seedMatch(): Record<string, unknown> {
  return {
    startedAt: '2026-05-20T12:00:00.000Z',
    myTeam: [
      {
        species: 'Sneasler', level: 50, ability: 'Unburden', nature: 'Jolly',
        evs: { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
        ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
        moves: ['Close Combat', 'Dire Claw', 'Fake Out', 'Protect'],
      },
    ],
    opponentTeam: [
      { species: 'Incineroar', knownMoves: [] },
      { species: 'Amoonguss', knownMoves: [] },
    ],
    bring: [0],
    opponentBrought: [0, 1],
    turns: [],
    field: {
      weather: null, terrain: null, trickRoom: false,
      myTailwind: false, theirTailwind: false,
      myReflect: false, myLightScreen: false,
      theirReflect: false, theirLightScreen: false,
    },
    active: { mine: [null, null], theirs: [null, null] },
  };
}

async function createMatch(token: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/matches',
    headers: authHeaders(token),
    payload: { match: seedMatch() },
  });
  if (res.statusCode !== 200) throw new Error(`createMatch: ${res.statusCode} ${res.body}`);
  return (res.json() as { id: string }).id;
}

// --- WS helper (trimmed copy of ws-match.test.ts's connect) ---
async function connect(path: string, upgradeContext: Partial<any> = {}) {
  const queue: any[] = [];
  const waiters: Array<(v: any) => void> = [];
  let closeInfo: { code: number; reason: string } | null = null;
  const closeWaiters: Array<(v: { code: number; reason: string }) => void> = [];

  const ws: any = await app.injectWS(path, upgradeContext, {
    onInit: (sock: any) => {
      sock.on('message', (data: Buffer | string) => {
        const parsed = JSON.parse(String(data));
        const next = waiters.shift();
        if (next) next(parsed); else queue.push(parsed);
      });
      sock.on('close', (code: number, reason: Buffer) => {
        closeInfo = { code, reason: String(reason) };
        for (const w of closeWaiters.splice(0)) w(closeInfo);
      });
    },
  } as any);

  const recv = (timeoutMs = 2000): Promise<any> => {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws message timeout')), timeoutMs);
      waiters.push((v) => { clearTimeout(t); resolve(v); });
    });
  };
  const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
    if (closeInfo) return resolve(closeInfo);
    const t = setTimeout(() => reject(new Error('ws close timeout')), 2000);
    closeWaiters.push((v) => { clearTimeout(t); resolve(v); });
  });
  return { ws, recv, closed };
}

describe('owner share CRUD', () => {
  it('POST creates a token and is idempotent (create-or-return)', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);

    const r1 = await app.inject({ method: 'POST', url: `/matches/${id}/share`, headers: authHeaders(token) });
    expect(r1.statusCode).toBe(200);
    const t1 = (r1.json() as { token: string; url: string });
    expect(t1.token).toBeTruthy();
    expect(t1.url).toContain(`/spectate/${t1.token}`);

    const r2 = await app.inject({ method: 'POST', url: `/matches/${id}/share`, headers: authHeaders(token) });
    expect((r2.json() as { token: string }).token).toBe(t1.token);
  });

  it('GET returns null before share, the token after', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);

    const before = await app.inject({ method: 'GET', url: `/matches/${id}/share`, headers: authHeaders(token) });
    expect((before.json() as { token: string | null }).token).toBeNull();

    const created = (await app.inject({ method: 'POST', url: `/matches/${id}/share`, headers: authHeaders(token) }).then(r => r.json())) as { token: string };
    const after = await app.inject({ method: 'GET', url: `/matches/${id}/share`, headers: authHeaders(token) });
    expect((after.json() as { token: string }).token).toBe(created.token);
  });

  it('DELETE revokes the share (GET then null)', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);
    await app.inject({ method: 'POST', url: `/matches/${id}/share`, headers: authHeaders(token) });

    const del = await app.inject({ method: 'DELETE', url: `/matches/${id}/share`, headers: authHeaders(token) });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: `/matches/${id}/share`, headers: authHeaders(token) });
    expect((after.json() as { token: string | null }).token).toBeNull();
  });

  it('a non-owner cannot share (404, no leak)', async () => {
    const { token: alice } = await registerUser(app, 'alice@test.example');
    const { token: bob } = await registerUser(app, 'bob@test.example');
    const id = await createMatch(alice);

    const res = await app.inject({ method: 'POST', url: `/matches/${id}/share`, headers: authHeaders(bob) });
    expect(res.statusCode).toBe(404);
  });

  it('share requires auth', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);
    const res = await app.inject({ method: 'POST', url: `/matches/${id}/share` });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /spectate/:token (unauthenticated snapshot)', () => {
  it('returns the match for a valid token, no auth header', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);
    const share = (await app.inject({ method: 'POST', url: `/matches/${id}/share`, headers: authHeaders(token) }).then(r => r.json())) as { token: string };

    const res = await app.inject({ method: 'GET', url: `/spectate/${share.token}` });
    expect(res.statusCode).toBe(200);
    const match = res.json() as any;
    expect(match.id).toBe(id);
    expect(match.opponentTeam[0].species).toBe('Incineroar');
  });

  it('404 for an unknown token', async () => {
    const res = await app.inject({ method: 'GET', url: '/spectate/not-a-real-token' });
    expect(res.statusCode).toBe(404);
  });

  it('404 after the share is revoked', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);
    const share = (await app.inject({ method: 'POST', url: `/matches/${id}/share`, headers: authHeaders(token) }).then(r => r.json())) as { token: string };
    await app.inject({ method: 'DELETE', url: `/matches/${id}/share`, headers: authHeaders(token) });

    const res = await app.inject({ method: 'GET', url: `/spectate/${share.token}` });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /matches/:id/live?share= (spectator socket)', () => {
  it('a spectator with a share token gets the snapshot + live updates', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);
    const share = (await app.inject({ method: 'POST', url: `/matches/${id}/share`, headers: authHeaders(token) }).then(r => r.json())) as { token: string };

    await app.ready();
    const spectator = await connect(`/matches/${id}/live?share=${share.token}`);
    const snap = await spectator.recv();
    expect(snap.type).toBe('snapshot');
    expect(snap.match.id).toBe(id);

    // Owner mutates → spectator receives the broadcast. Shape matches
    // match-actions.test.ts's known-good state update.
    const upd = await app.inject({
      method: 'POST', url: `/matches/${id}/state`, headers: authHeaders(token),
      payload: { update: { side: 'theirs', teamIndex: 0, hpPercent: 42 } },
    });
    expect(upd.statusCode).toBe(200);
    const live = await spectator.recv();
    expect(live.type).toBe('update');
    expect(live.match.id).toBe(id);
    spectator.ws.close();
  });

  it('closes spectator sockets when the owner revokes the share', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);
    const share = (await app.inject({ method: 'POST', url: `/matches/${id}/share`, headers: authHeaders(token) }).then(r => r.json())) as { token: string };

    await app.ready();
    const spectator = await connect(`/matches/${id}/live?share=${share.token}`);
    expect((await spectator.recv()).type).toBe('snapshot');

    // Owner revokes → the spectator socket is closed with the revoke code.
    const del = await app.inject({ method: 'DELETE', url: `/matches/${id}/share`, headers: authHeaders(token) });
    expect(del.statusCode).toBe(204);
    const { code } = await spectator.closed;
    expect(code).toBe(4403);
  });

  it('closes 4401 for an invalid share token', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);
    await app.ready();
    const c = await connect(`/matches/${id}/live?share=bogus`);
    const { code } = await c.closed;
    expect(code).toBe(4401);
  });

  it('closes 4401 when a valid token is used on the wrong match url (scope check)', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id1 = await createMatch(token);
    const id2 = await createMatch(token);
    const share = (await app.inject({ method: 'POST', url: `/matches/${id1}/share`, headers: authHeaders(token) }).then(r => r.json())) as { token: string };

    await app.ready();
    const c = await connect(`/matches/${id2}/live?share=${share.token}`);
    const { code } = await c.closed;
    expect(code).toBe(4401);
  });
});
