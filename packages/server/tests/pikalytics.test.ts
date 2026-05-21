// Server-side Pikalytics cache + endpoint tests. We mock the network fetcher
// so CI doesn't hit pikalytics.com — the only thing we actually exercise is
// the route → cache → DB pipeline (parseEntry's own correctness is covered
// by core's own parser tests).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeaders, disposeApp, freshApp, registerUser } from './helpers.js';
import { _setFetcherForTests, _resetInFlight } from '../src/pikalytics/cache.js';

process.env.DATABASE_URL = 'file::memory:';
process.env.JWT_SECRET = 'test-secret-not-for-production-use-only-tests';
process.env.NODE_ENV = 'test';

let app: FastifyInstance;

// Minimal markdown stub that exercises every section parseEntry reads. parser
// regexes are forgiving — missing sections just return [] / undefined, so this
// covers the happy path.
// Mirrors the section / bullet shape parseEntry expects (see
// parsePercentSection in @pokechamps/core/scripts/refresh-pikalytics.ts).
const FAKE_MD = `
## Common Moves
- **Close Combat**: 58.000%
- **Fake Out**: 47.200%

## Common Abilities
- **Unburden**: 91.000%

## Common Items
- **Grassy Seed**: 60.500%

## Common Teammates
- **Rillaboom**: 35.000%

## Frequently Asked Questions

**Jolly** nature with an EV spread of \`2/32/0/0/0/32\`. This configuration accounts for 22.880% of competitive builds.
`;

beforeEach(async () => {
  app = await freshApp();
  _resetInFlight();
  _setFetcherForTests(async (url: string) => {
    return {
      ok: true,
      status: 200,
      text: async () => FAKE_MD,
    };
  });
});

afterEach(async () => {
  _setFetcherForTests(null);
  await disposeApp(app);
});

describe('GET /pikalytics/:species', () => {
  it('first hit returns 202 fetching, subsequent hit returns 200 with entry', async () => {
    const { token } = await registerUser(app, 'alice@test.example');

    const first = await app.inject({
      method: 'GET', url: '/pikalytics/Sneasler',
      headers: authHeaders(token),
    });
    expect(first.statusCode).toBe(202);
    expect((first.json() as any).status).toBe('fetching');

    // Wait for the background fetch to land. The mock resolves immediately
    // but the upsert lives behind a microtask boundary.
    for (let i = 0; i < 20; i++) {
      const probe = await app.inject({
        method: 'GET', url: '/pikalytics/Sneasler', headers: authHeaders(token),
      });
      if (probe.statusCode === 200) {
        const body = probe.json() as any;
        expect(body.status).toBe('ok');
        expect(body.species).toBe('Sneasler');
        expect(body.entry.topSpread.nature).toBe('Jolly');
        expect(body.entry.abilities[0].name).toBe('Unburden');
        return;
      }
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('cache never populated');
  });

  it('401 when no token is supplied', async () => {
    const res = await app.inject({
      method: 'GET', url: '/pikalytics/Sneasler',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /pikalytics/:species/refresh', () => {
  it('forces a fetch and returns the entry inline', async () => {
    const { token } = await registerUser(app, 'alice@test.example');

    const res = await app.inject({
      method: 'POST', url: '/pikalytics/Sneasler/refresh',
      headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.status).toBe('ok');
    expect(body.entry.topSpread.nature).toBe('Jolly');
  });

  it('502 when the upstream fetch returns non-OK', async () => {
    _setFetcherForTests(async () => ({
      ok: false,
      status: 503,
      text: async () => '',
    }));
    const { token } = await registerUser(app, 'alice@test.example');

    const res = await app.inject({
      method: 'POST', url: '/pikalytics/Sneasler/refresh',
      headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as any).status).toBe('error');
  });

  it('dedupes concurrent fetches for the same species', async () => {
    let fetches = 0;
    _setFetcherForTests(async () => {
      fetches += 1;
      // small delay so both calls overlap
      await new Promise(r => setTimeout(r, 30));
      return { ok: true, status: 200, text: async () => FAKE_MD };
    });
    const { token } = await registerUser(app, 'alice@test.example');

    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST', url: '/pikalytics/Sneasler/refresh',
        headers: authHeaders(token),
      }),
      app.inject({
        method: 'POST', url: '/pikalytics/Sneasler/refresh',
        headers: authHeaders(token),
      }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(fetches).toBe(1);
  });
});

describe('GET /pikalytics', () => {
  it('lists every cached species', async () => {
    const { token } = await registerUser(app, 'alice@test.example');

    await app.inject({
      method: 'POST', url: '/pikalytics/Sneasler/refresh',
      headers: authHeaders(token),
    });
    await app.inject({
      method: 'POST', url: '/pikalytics/Incineroar/refresh',
      headers: authHeaders(token),
    });

    const list = await app.inject({
      method: 'GET', url: '/pikalytics', headers: authHeaders(token),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as any;
    expect(body.species).toEqual(['Incineroar', 'Sneasler']);
  });
});
