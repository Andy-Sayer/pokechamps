// httpStore unit tests. We stub fetch + WebSocket via the cfg overrides so
// the tests don't need a running server — the server side of these contracts
// is exercised in @pokechamps/server's integration suite.
import { describe, expect, it, vi } from 'vitest';
import { createHttpStores, type HttpStoreConfig } from '../src/storage/httpStore.js';
import type { Match, PokemonSet } from '../src/domain/types.js';

const baseUrl = 'http://server.test';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeCfg(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  WebSocketImpl?: typeof WebSocket,
): HttpStoreConfig {
  return {
    baseUrl,
    getToken: () => 'test-token',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    WebSocketImpl,
  };
}

describe('httpStore.teams', () => {
  it('list passes auth header and returns rows', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.authorization).toBe('Bearer test-token');
      return jsonResponse([{ name: 'staples', team: [{ species: 'Sneasler' }] }]);
    });
    const stores = createHttpStores(makeCfg(fetchMock));
    const teams = await stores.teams.list();
    expect(teams).toEqual([{ name: 'staples', team: [{ species: 'Sneasler' }] }]);
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/teams`,
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it('get returns null on 404', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"not found"}', { status: 404 }));
    const stores = createHttpStores(makeCfg(fetchMock));
    expect(await stores.teams.get('missing')).toBeNull();
  });

  it('save PUTs JSON body with team payload', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${baseUrl}/teams/demo`);
      expect(init?.method).toBe('PUT');
      const parsed = JSON.parse(init?.body as string);
      expect(parsed.team[0].species).toBe('Rillaboom');
      return jsonResponse({ name: 'demo', team: parsed.team });
    });
    const stores = createHttpStores(makeCfg(fetchMock));
    await stores.teams.save('demo', [{ species: 'Rillaboom' } as unknown as PokemonSet]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('httpStore.matches', () => {
  it('create POSTs and returns server-assigned id', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id: 'srv-id-123', match: { id: 'srv-id-123' } }),
    );
    const stores = createHttpStores(makeCfg(fetchMock));
    const res = await stores.matches.create({ id: 'client-id' } as Match);
    expect(res.id).toBe('srv-id-123');
  });

  it('subscribe opens a ws with token in the query and forwards updates', async () => {
    const sent: string[] = [];
    type Listener = (ev: { data: string }) => void;
    const listeners: Listener[] = [];
    class FakeWS {
      url: string;
      constructor(url: string) { this.url = url; sent.push(url); }
      addEventListener(_type: string, listener: Listener) { listeners.push(listener); }
      close() { /* no-op */ }
    }
    const cfg = makeCfg(async () => jsonResponse({}), FakeWS as unknown as typeof WebSocket);
    const stores = createHttpStores(cfg);

    const seen: Match[] = [];
    const unsubscribe = stores.matches.subscribe('m1', m => seen.push(m));
    expect(sent[0]).toBe('ws://server.test/matches/m1/live?token=test-token');

    // Server pushes a snapshot then an update.
    listeners[0]!({ data: JSON.stringify({ type: 'snapshot', match: { id: 'm1' } }) });
    listeners[0]!({ data: JSON.stringify({ type: 'update', match: { id: 'm1', notes: 'turn-1' } }) });
    expect(seen).toHaveLength(2);
    expect((seen[1] as any).notes).toBe('turn-1');

    unsubscribe();
  });
});

describe('httpStore.pikalytics', () => {
  it('caches a hit and surfaces via get()', async () => {
    const entry = { rank: 0, usage: 0, moves: [], abilities: [], items: [], teammates: [], featuredSets: [] };
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: 'ok', species: 'Sneasler', entry }),
    );
    const cfg = makeCfg(fetchMock);
    const stores = createHttpStores(cfg);
    expect(stores.pikalytics.get('Sneasler')).toBeNull();
    stores.pikalytics.fetchAndCache('Sneasler');
    expect(stores.pikalytics.isFetching('Sneasler')).toBe(true);

    // Let the microtask queue drain so doFetch resolves.
    await new Promise(r => setTimeout(r, 10));
    expect(stores.pikalytics.get('Sneasler')).toEqual(entry);
    expect(stores.pikalytics.isFetching('Sneasler')).toBe(false);
  });

  it('does not refire fetch for an in-flight species', async () => {
    const fetchMock = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 30));
      return jsonResponse({
        status: 'ok',
        species: 'Incineroar',
        entry: { rank: 0, usage: 0, moves: [], abilities: [], items: [], teammates: [], featuredSets: [] },
      });
    });
    const stores = createHttpStores(makeCfg(fetchMock));
    stores.pikalytics.fetchAndCache('Incineroar');
    stores.pikalytics.fetchAndCache('Incineroar');
    stores.pikalytics.fetchAndCache('Incineroar');
    await new Promise(r => setTimeout(r, 60));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
