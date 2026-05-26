// parseShareInput edge cases — the one piece of spectator logic with real
// branching (full URL vs bare token vs garbage). The fetch/WS halves need a
// live server, covered by the server-side shares.test.ts instead.
import { describe, expect, it } from 'vitest';
import { parseShareInput } from '../src/spectate.js';

describe('parseShareInput', () => {
  it('parses a full spectator URL into baseUrl + token', () => {
    const t = parseShareInput('https://pokechamps.duckdns.org/spectate/abc123');
    expect(t).toEqual({ baseUrl: 'https://pokechamps.duckdns.org', token: 'abc123' });
  });

  it('keeps the port and tolerates a trailing slash', () => {
    const t = parseShareInput('http://localhost:3000/spectate/tok-en/');
    expect(t).toEqual({ baseUrl: 'http://localhost:3000', token: 'tok-en' });
  });

  it('url-decodes the token', () => {
    const t = parseShareInput('https://h/spectate/a%2Fb');
    expect(t).toEqual({ baseUrl: 'https://h', token: 'a/b' });
  });

  it('treats a bare token as a token when a fallback base URL is given', () => {
    const t = parseShareInput('justatoken', 'https://srv.example/');
    expect(t).toEqual({ baseUrl: 'https://srv.example', token: 'justatoken' });
  });

  it('returns null for a bare token with no fallback base URL', () => {
    expect(parseShareInput('justatoken')).toBeNull();
  });

  it('returns null for empty / whitespace input', () => {
    expect(parseShareInput('   ')).toBeNull();
  });

  it('returns null for a URL without a /spectate/<token> path and no fallback', () => {
    // A non-spectate URL with no fallback can't yield a target. (With a
    // fallback, the whole string would be treated as a token — not this case.)
    expect(parseShareInput('https://host/matches/123')).toBeNull();
  });
});
