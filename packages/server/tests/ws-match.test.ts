// WebSocket /matches/:id/live integration tests. Uses @fastify/websocket's
// app.injectWS() to drive the upgrade without spinning up a real listener.
//
// Coverage:
//   - snapshot on connect
//   - peer broadcast on POST /turns
//   - peer broadcast on POST /state
//   - peer broadcast on PATCH /:id
//   - unauthorized (no token) closes with 4401
//   - cross-user access closes with 4404
//   - missing match closes with 4404
//   - close handler de-registers (no orphan broadcasts after disconnect)
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeaders, disposeApp, freshApp, registerUser } from './helpers.js';
import { _resetHub, _subscriberCount } from '../src/ws/hub.js';

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

// Minimal seed: a valid Match with two teams and initial leads. Same shape as
// match-actions.test.ts uses, kept inline so the two tests stay independent.
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

// `ws` doesn't auto-buffer frames received before a 'message' listener is
// attached, and injectWS resolves after the upgrade — by which time the
// snapshot has already flown past. Attach a buffering listener via onInit
// (which fires *before* the socket opens) so nothing is dropped.
interface Connected {
  ws: any;
  recv: (timeoutMs?: number) => Promise<any>;
  closed: Promise<{ code: number; reason: string }>;
}

async function connect(
  path: string,
  upgradeContext: Partial<any> = {},
): Promise<Connected> {
  const queue: any[] = [];
  const waiters: Array<(v: any) => void> = [];
  let closeInfo: { code: number; reason: string } | null = null;
  const closeWaiters: Array<(v: { code: number; reason: string }) => void> = [];

  const ws: any = await app.injectWS(path, upgradeContext, {
    onInit: (sock) => {
      sock.on('message', (data: Buffer | string) => {
        const parsed = JSON.parse(String(data));
        const next = waiters.shift();
        if (next) next(parsed);
        else queue.push(parsed);
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

describe('GET /matches/:id/live', () => {
  it('sends snapshot envelope on connect', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);

    await app.ready();
    const c = await connect(`/matches/${id}/live?token=${token}`);
    const msg = await c.recv();
    expect(msg.type).toBe('snapshot');
    expect(msg.match.id).toBe(id);
    expect(msg.match.opponentTeam[0].species).toBe('Incineroar');
    c.ws.close();
  });

  it('header-based auth (Authorization: Bearer) also works', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);

    await app.ready();
    const c = await connect(`/matches/${id}/live`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const msg = await c.recv();
    expect(msg.type).toBe('snapshot');
    c.ws.close();
  });

  it('closes with 4401 when no token is supplied', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);

    await app.ready();
    const c = await connect(`/matches/${id}/live`);
    const { code } = await c.closed;
    expect(code).toBe(4401);
  });

  it('closes with 4404 when match belongs to another user', async () => {
    const alice = await registerUser(app, 'alice@test.example');
    const bob = await registerUser(app, 'bob@test.example');
    const id = await createMatch(alice.token);

    await app.ready();
    const c = await connect(`/matches/${id}/live?token=${bob.token}`);
    const { code } = await c.closed;
    expect(code).toBe(4404);
  });

  it('closes with 4404 when match id does not exist', async () => {
    const { token } = await registerUser(app, 'alice@test.example');

    await app.ready();
    const c = await connect(
      `/matches/00000000-0000-0000-0000-000000000000/live?token=${token}`,
    );
    const { code } = await c.closed;
    expect(code).toBe(4404);
  });

  it('broadcasts post-turn update to connected subscribers', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);

    await app.ready();
    const c = await connect(`/matches/${id}/live?token=${token}`);
    // Drain the initial snapshot.
    await c.recv();

    const res = await app.inject({
      method: 'POST', url: `/matches/${id}/state`,
      headers: authHeaders(token),
      payload: { update: { side: 'theirs', teamIndex: 0, hpPercent: 50 } },
    });
    expect(res.statusCode).toBe(200);

    const update = await c.recv();
    expect(update.type).toBe('update');
    expect(update.source).toBe('state');
    expect(update.match.opponentTeam[0].currentHpPercent).toBe(50);
    c.ws.close();
  });

  it('broadcasts PATCH /:id updates with source=crud', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);

    await app.ready();
    const c = await connect(`/matches/${id}/live?token=${token}`);
    await c.recv();

    const patched = { ...seedMatch(), notes: 'patched' };
    const res = await app.inject({
      method: 'PATCH', url: `/matches/${id}`,
      headers: authHeaders(token),
      payload: { match: patched },
    });
    expect(res.statusCode).toBe(200);

    const update = await c.recv();
    expect(update.source).toBe('crud');
    expect(update.match.notes).toBe('patched');
    c.ws.close();
  });

  it('close handler de-registers the subscriber', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);

    await app.ready();
    const c = await connect(`/matches/${id}/live?token=${token}`);
    await c.recv();
    expect(_subscriberCount(id)).toBe(1);

    // terminate() (not close()) — the graceful close handshake doesn't
    // reliably propagate over injectWS's in-process PassThrough pair, so we
    // hard-disconnect to deterministically trigger the server-side 'close'.
    c.ws.terminate();
    for (let i = 0; i < 50; i++) {
      if (_subscriberCount(id) === 0) break;
      await new Promise(r => setTimeout(r, 20));
    }
    expect(_subscriberCount(id)).toBe(0);
  });
});

describe('GET /matches/:id/live — ticket path', () => {
  it('connects with a single-use ticket and rejects re-use', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const id = await createMatch(token);
    await app.ready();

    const t = await app.inject({
      method: 'POST', url: `/matches/${id}/live-ticket`,
      headers: authHeaders(token),
    });
    expect(t.statusCode).toBe(200);
    const { ticket } = t.json() as { ticket: string };
    expect(ticket).toMatch(/^[A-Za-z0-9_-]+$/);

    const c = await connect(`/matches/${id}/live?ticket=${encodeURIComponent(ticket)}`);
    const msg = await c.recv();
    expect(msg.type).toBe('snapshot');
    c.ws.close();

    // Single-use: a second connect with the same ticket fails.
    const c2 = await connect(`/matches/${id}/live?ticket=${encodeURIComponent(ticket)}`);
    const { code } = await c2.closed;
    expect(code).toBe(4401);
  });

  it('rejects a ticket reused against a different match', async () => {
    const { token } = await registerUser(app, 'alice@test.example');
    const idA = await createMatch(token);
    const idB = await createMatch(token);
    await app.ready();

    const t = await app.inject({
      method: 'POST', url: `/matches/${idA}/live-ticket`,
      headers: authHeaders(token),
    });
    const { ticket } = t.json() as { ticket: string };

    const c = await connect(`/matches/${idB}/live?ticket=${encodeURIComponent(ticket)}`);
    const { code } = await c.closed;
    expect(code).toBe(4401);
  });

  it('POST /matches/:id/live-ticket 404s for another user', async () => {
    const alice = await registerUser(app, 'alice@test.example');
    const bob = await registerUser(app, 'bob@test.example');
    const id = await createMatch(alice.token);

    const t = await app.inject({
      method: 'POST', url: `/matches/${id}/live-ticket`,
      headers: authHeaders(bob.token),
    });
    expect(t.statusCode).toBe(404);
  });
});
