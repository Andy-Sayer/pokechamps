// Unit tests for the REST client. Mocks global fetch so we don't depend on a
// running server. jsdom provides localStorage so we can also assert
// persistence end-to-end.
//
// vi.resetModules() between tests is critical: api.ts pulls config from
// localStorage at module load, so each test gets a clean slate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

async function loadFresh() {
  // localStorage is jsdom's, but state persists across imports — reset
  // the module so the in-file `config` holder rebuilds from a fresh
  // localStorage snapshot.
  vi.resetModules();
  return await import('./api.js');
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api: register/login', () => {
  it('register POSTs JSON, stores token + user, marks isAuthenticated', async () => {
    const calls: FetchArgs[] = [];
    vi.stubGlobal('fetch', vi.fn(async (...args: FetchArgs) => {
      calls.push(args);
      return jsonResponse({ token: 'jwt.payload.sig', user: { id: 'u1', email: 'a@example.com' } });
    }));

    const api = await loadFresh();
    api.setBaseUrl('http://srv.test');
    const res = await api.register('a@example.com', 'hunter22');

    expect(res.token).toBe('jwt.payload.sig');
    expect(res.user.email).toBe('a@example.com');
    expect(api.isAuthenticated()).toBe(true);
    expect(api.getToken()).toBe('jwt.payload.sig');
    expect(api.getCurrentUser()?.email).toBe('a@example.com');

    // Exactly one fetch, to /auth/register, with email+password body, no
    // Authorization header (we explicitly pass auth:false on register).
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(String(url)).toBe('http://srv.test/auth/register');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('authorization')).toBeNull();
    expect(JSON.parse(init?.body as string)).toEqual({
      email: 'a@example.com',
      password: 'hunter22',
    });
  });

  it('login persists across module reload via localStorage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ token: 'tok-xyz', user: { id: 'u2', email: 'b@example.com' } }),
    ));

    const api = await loadFresh();
    api.setBaseUrl('http://srv.test');
    await api.login('b@example.com', 'hunter22');

    // Simulate a page reload: drop the module cache and re-import. The
    // localStorage write from login() should rehydrate.
    const api2 = await loadFresh();
    expect(api2.isAuthenticated()).toBe(true);
    expect(api2.getToken()).toBe('tok-xyz');
    expect(api2.getBaseUrl()).toBe('http://srv.test');
  });

  it('signOut clears in-memory state + localStorage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ token: 't', user: { id: 'u3', email: 'c@example.com' } }),
    ));

    const api = await loadFresh();
    api.setBaseUrl('http://srv.test');
    await api.login('c@example.com', 'hunter22');
    expect(api.isAuthenticated()).toBe(true);

    api.signOut();
    expect(api.isAuthenticated()).toBe(false);

    // A fresh module load also sees the cleared state.
    const api2 = await loadFresh();
    expect(api2.isAuthenticated()).toBe(false);
    expect(localStorage.getItem('pokechamps.auth.v1')).toBeNull();
  });
});

describe('api: authenticated requests', () => {
  it('attaches Authorization: Bearer header when a token is set', async () => {
    const calls: FetchArgs[] = [];
    vi.stubGlobal('fetch', vi.fn(async (...args: FetchArgs) => {
      calls.push(args);
      if (String(args[0]).endsWith('/auth/login')) {
        return jsonResponse({ token: 'tok-1', user: { id: 'u', email: 'x@example.com' } });
      }
      return jsonResponse([{ id: 'm1', startedAt: '2026-05-20', myTeamSpecies: ['Sneasler'], opponentTeamSpecies: [] }]);
    }));

    const api = await loadFresh();
    api.setBaseUrl('http://srv.test');
    await api.login('x@example.com', 'hunter22');
    await api.listMatches();

    const listCall = calls.find(([u]) => String(u).endsWith('/matches'));
    expect(listCall).toBeDefined();
    const headers = new Headers(listCall![1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer tok-1');
  });

  it('getMatch returns the parsed match body', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/auth/login')) {
        return jsonResponse({ token: 'tok', user: { id: 'u', email: 'a@example.com' } });
      }
      return jsonResponse({ id: 'm1', startedAt: '2026-05-20', myTeam: [], opponentTeam: [] });
    }));

    const api = await loadFresh();
    api.setBaseUrl('http://srv.test');
    await api.login('a@example.com', 'hunter22');
    const m = await api.getMatch('m1');
    expect(m.id).toBe('m1');
  });

  it('getLiveTicket POSTs to /matches/:id/live-ticket and returns the body', async () => {
    const calls: FetchArgs[] = [];
    vi.stubGlobal('fetch', vi.fn(async (...args: FetchArgs) => {
      calls.push(args);
      if (String(args[0]).endsWith('/auth/login')) {
        return jsonResponse({ token: 'tok', user: { id: 'u', email: 'a@example.com' } });
      }
      return jsonResponse({ ticket: 'ABC-xyz', expiresInMs: 30000 });
    }));

    const api = await loadFresh();
    api.setBaseUrl('http://srv.test');
    await api.login('a@example.com', 'hunter22');
    const t = await api.getLiveTicket('m-42');
    expect(t.ticket).toBe('ABC-xyz');

    const ticketCall = calls.find(([u]) => String(u).endsWith('/matches/m-42/live-ticket'));
    expect(ticketCall).toBeDefined();
    expect(ticketCall![1]?.method).toBe('POST');
  });
});

describe('api: error handling', () => {
  it('throws ApiError on 4xx with parsed body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ error: 'invalid email or password' }, { status: 401 }),
    ));

    const api = await loadFresh();
    api.setBaseUrl('http://srv.test');
    await expect(api.login('a@example.com', 'wrong')).rejects.toMatchObject({
      status: 401,
      message: 'invalid email or password',
    });
    expect(api.isAuthenticated()).toBe(false);
  });

  it('throws ApiError with a non-JSON body as null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('not json', { status: 500, headers: { 'content-type': 'text/plain' } }),
    ));

    const api = await loadFresh();
    api.setBaseUrl('http://srv.test');
    await expect(api.listMatches()).rejects.toMatchObject({
      status: 500,
    });
  });
});

describe('api: baseUrl', () => {
  it('strips trailing slash from setBaseUrl', async () => {
    const api = await loadFresh();
    api.setBaseUrl('http://srv.test/');
    expect(api.getBaseUrl()).toBe('http://srv.test');
  });
});
