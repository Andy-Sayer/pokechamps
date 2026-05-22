// Tests for the migrate-to-server script's HTTP helpers. We don't test main()
// directly because it walks the real file-store readers, which would require
// staging fixture files in matches/ — out of scope for a unit test. The
// putTeam / postMatch helpers are pure (serverUrl + token + payload in, result
// out) and are where all the bug-prone logic lives.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('migrate-to-server.putTeam', () => {
  it('PUTs to /teams/<name> with Bearer header and team body', async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push([url, init]);
      return jsonResponse({ name: 'staples' });
    }));

    const { putTeam } = await import('../src/scripts/migrate-to-server.js');
    const result = await putTeam('http://srv.test', 'tok-xyz', 'staples', [
      { species: 'Sneasler' } as any,
    ]);

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(String(url)).toBe('http://srv.test/teams/staples');
    expect(init?.method).toBe('PUT');
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-xyz');
    expect(JSON.parse(init?.body as string)).toEqual({
      team: [{ species: 'Sneasler' }],
    });
  });

  it('encodeURIComponent escapes weird names', async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push([url, init]);
      return jsonResponse({});
    }));
    const { putTeam } = await import('../src/scripts/migrate-to-server.js');
    await putTeam('http://srv', 'tok', 'has space / slash', []);
    expect(String(calls[0]![0])).toBe(
      'http://srv/teams/has%20space%20%2F%20slash',
    );
  });

  it('captures non-OK status + truncated body as a failure result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ error: 'team body too big' }, { status: 413 }),
    ));
    const { putTeam } = await import('../src/scripts/migrate-to-server.js');
    const result = await putTeam('http://srv', 'tok', 'big', []);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(413);
    expect(result.message).toContain('team body too big');
  });

  it('catches network errors and reports them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    const { putTeam } = await import('../src/scripts/migrate-to-server.js');
    const result = await putTeam('http://srv', 'tok', 'staples', []);
    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
    expect(result.message).toBe('ECONNREFUSED');
  });
});

describe('migrate-to-server.postMatch', () => {
  it('POSTs to /matches and reports ok on 200', async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push([url, init]);
      return jsonResponse({ id: 'srv-1', match: {} });
    }));

    const { postMatch } = await import('../src/scripts/migrate-to-server.js');
    const result = await postMatch('http://srv', 'tok', { id: 'local-1' } as any);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(String(calls[0]![0])).toBe('http://srv/matches');
    expect(calls[0]![1]?.method).toBe('POST');
    expect(JSON.parse(calls[0]![1]?.body as string)).toEqual({
      match: { id: 'local-1' },
    });
  });

  it('reports 4xx with the response body in message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ error: 'invalid match shape' }, { status: 400 }),
    ));
    const { postMatch } = await import('../src/scripts/migrate-to-server.js');
    const result = await postMatch('http://srv', 'tok', {} as any);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.message).toContain('invalid match shape');
  });
});
