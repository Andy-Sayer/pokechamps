// Unit tests for the browser-side live-match subscriber.
//
// Two surfaces to mock:
//   1. fetch — for the POST /matches/:id/live-ticket call (via api.getLiveTicket)
//   2. WebSocket — passed via the WebSocketImpl seam so we don't need a server
//
// Auth/baseUrl state is set on the api module before each test so getLiveTicket
// has somewhere to talk to.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

// Minimal WebSocket double that records the URL, lets the test drive open/
// message/close events, and tracks close() calls.
type Listener = (ev: any) => void;
class FakeWS {
  static instances: FakeWS[] = [];
  static reset(): void { FakeWS.instances = []; }
  url: string;
  readyState = 0;
  closed: { code: number; reason?: string } | null = null;
  listeners = new Map<string, Listener[]>();
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  addEventListener(type: string, listener: Listener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }
  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.fire('close', { code, reason });
  }
  // Test helpers:
  fire(type: string, ev: any): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
  openIt(): void {
    this.readyState = 1;
    this.fire('open', {});
  }
  sendMessage(payload: any): void {
    this.fire('message', { data: JSON.stringify(payload) });
  }
}

async function loadFresh() {
  vi.resetModules();
  return await import('./liveMatch.js');
}

async function setupApiWithToken(): Promise<void> {
  vi.resetModules();
  const api = await import('./api.js');
  api.setBaseUrl('http://srv.test');
  // Seed localStorage so api.ts's loadPersisted finds a token; or do it more
  // directly by stubbing fetch + calling login. Direct localStorage write is
  // simpler:
  localStorage.setItem('pokechamps.auth.v1', JSON.stringify({
    baseUrl: 'http://srv.test',
    token: 'tok-jwt',
    user: { id: 'u1', email: 'a@example.com' },
  }));
}

beforeEach(() => {
  localStorage.clear();
  FakeWS.reset();
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('subscribeLiveMatch: happy path', () => {
  it('fetches a ticket then opens ws with ?ticket= in the URL', async () => {
    await setupApiWithToken();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.endsWith('/live-ticket')) {
        return jsonResponse({ ticket: 'T-123', expiresInMs: 30000 });
      }
      throw new Error('unexpected fetch ' + u);
    }));

    const { subscribeLiveMatch } = await loadFresh();
    const matches: any[] = [];
    const statuses: string[] = [];
    const sub = subscribeLiveMatch('http://srv.test', 'm-42', {
      onMatch: (m) => matches.push(m),
      onStatus: (s) => statuses.push(s),
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });

    // Allow the ticket fetch microtasks to drain.
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    expect(FakeWS.instances).toHaveLength(1);
    const ws = FakeWS.instances[0]!;
    expect(ws.url).toBe('ws://srv.test/matches/m-42/live?ticket=T-123');

    // Status flow: connecting → live on open.
    expect(statuses[0]).toBe('connecting');
    ws.openIt();
    expect(statuses).toContain('live');

    // Snapshot envelope is forwarded.
    ws.sendMessage({ type: 'snapshot', match: { id: 'm-42', name: 'snap' } });
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe('m-42');

    // Update envelope is forwarded.
    ws.sendMessage({ type: 'update', match: { id: 'm-42', name: 'upd' } });
    expect(matches).toHaveLength(2);
    expect(matches[1].name).toBe('upd');

    sub.unsubscribe();
    expect(ws.closed?.code).toBe(1000);
  });

  it('ignores malformed envelopes without crashing', async () => {
    await setupApiWithToken();
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ ticket: 'T', expiresInMs: 30000 }),
    ));

    const { subscribeLiveMatch } = await loadFresh();
    const matches: any[] = [];
    subscribeLiveMatch('http://srv.test', 'm', {
      onMatch: (m) => matches.push(m),
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });
    await new Promise(r => setTimeout(r, 0));
    const ws = FakeWS.instances[0]!;
    ws.openIt();
    ws.fire('message', { data: 'not json' });
    ws.fire('message', { data: JSON.stringify({ type: 'wat' }) }); // no match field
    expect(matches).toHaveLength(0);
  });
});

describe('subscribeLiveMatch: auth / not-found close codes', () => {
  it('4401 surfaces unauthorized + does not retry', async () => {
    await setupApiWithToken();
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ ticket: 'T', expiresInMs: 30000 }),
    ));
    const { subscribeLiveMatch } = await loadFresh();
    const errors: any[] = [];
    const statuses: string[] = [];
    subscribeLiveMatch('http://srv.test', 'm', {
      onMatch: () => {},
      onStatus: (s) => statuses.push(s),
      onError: (e) => errors.push(e),
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });
    await new Promise(r => setTimeout(r, 0));
    const ws = FakeWS.instances[0]!;
    ws.fire('close', { code: 4401, reason: 'unauthorized' });
    expect(errors[0]).toEqual({ kind: 'unauthorized', message: expect.any(String) });
    expect(statuses).toContain('closed');
    // Wait a beat to confirm no second ws was opened (no retry).
    await new Promise(r => setTimeout(r, 50));
    expect(FakeWS.instances).toHaveLength(1);
  });

  it('4404 surfaces not-found + does not retry', async () => {
    await setupApiWithToken();
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ ticket: 'T', expiresInMs: 30000 }),
    ));
    const { subscribeLiveMatch } = await loadFresh();
    const errors: any[] = [];
    subscribeLiveMatch('http://srv.test', 'm', {
      onMatch: () => {},
      onError: (e) => errors.push(e),
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });
    await new Promise(r => setTimeout(r, 0));
    FakeWS.instances[0]!.fire('close', { code: 4404, reason: 'gone' });
    expect(errors[0]).toEqual({ kind: 'not-found', message: 'match not found' });
  });

  it('401 from ticket endpoint surfaces unauthorized without opening a ws', async () => {
    await setupApiWithToken();
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ error: 'token revoked' }, { status: 401 }),
    ));
    const { subscribeLiveMatch } = await loadFresh();
    const errors: any[] = [];
    subscribeLiveMatch('http://srv.test', 'm', {
      onMatch: () => {},
      onError: (e) => errors.push(e),
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(errors[0]).toEqual({ kind: 'unauthorized', message: expect.any(String) });
    expect(FakeWS.instances).toHaveLength(0);
  });
});

describe('subscribeLiveMatch: reconnect backoff', () => {
  it('schedules a retry on non-1000 non-auth close + re-fetches a fresh ticket', async () => {
    await setupApiWithToken();
    let ticketCount = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      ticketCount += 1;
      return jsonResponse({ ticket: `T-${ticketCount}`, expiresInMs: 30000 });
    }));

    // Use fake timers so the 2s backoff doesn't slow the test down. We have
    // to weave through both the WS event and the timer.
    vi.useFakeTimers();
    const { subscribeLiveMatch } = await loadFresh();
    subscribeLiveMatch('http://srv.test', 'm', {
      onMatch: () => {},
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });
    // Flush the initial ticket fetch microtasks.
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWS.instances).toHaveLength(1);
    FakeWS.instances[0]!.fire('close', { code: 1006, reason: 'network' });

    // Schedule + execute the 2s retry timer; second connect mints a new ticket.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(ticketCount).toBeGreaterThanOrEqual(2);
    expect(FakeWS.instances).toHaveLength(2);
    expect(FakeWS.instances[1]!.url).toMatch(/ticket=T-2$/);
  });

  it('unsubscribe cancels a pending retry timer', async () => {
    await setupApiWithToken();
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ ticket: 'T', expiresInMs: 30000 }),
    ));
    vi.useFakeTimers();

    const { subscribeLiveMatch } = await loadFresh();
    const sub = subscribeLiveMatch('http://srv.test', 'm', {
      onMatch: () => {},
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    });
    await vi.advanceTimersByTimeAsync(0);
    FakeWS.instances[0]!.fire('close', { code: 1006, reason: 'network' });
    sub.unsubscribe();
    // Even after the backoff fires, no new ws is opened.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWS.instances).toHaveLength(1);
  });
});
