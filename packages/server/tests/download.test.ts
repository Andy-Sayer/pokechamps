// Download route tests. The TUI bundle endpoint is unauthenticated (a friend
// fetches the client before they have an account) and serves the gzip artifact
// from POKECHAMPS_TUI_BUNDLE. We point that env at a temp file so the test
// doesn't depend on `npm run bundle:tui` having run, and also assert the 404
// hint path when the bundle is absent.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disposeApp, freshApp } from './helpers.js';

process.env.DATABASE_URL = 'file::memory:';
process.env.JWT_SECRET = 'test-secret-not-for-production-use-only-tests';
process.env.NODE_ENV = 'test';

let app: FastifyInstance;
let tmp: string;
const prevBundle = process.env.POKECHAMPS_TUI_BUNDLE;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'pc-dl-'));
  app = await freshApp();
});

afterEach(async () => {
  await disposeApp(app);
  rmSync(tmp, { recursive: true, force: true });
  if (prevBundle === undefined) delete process.env.POKECHAMPS_TUI_BUNDLE;
  else process.env.POKECHAMPS_TUI_BUNDLE = prevBundle;
});

describe('GET /download/tui.tar.gz', () => {
  it('serves the bundle as a gzip attachment, no auth required', async () => {
    const bundle = join(tmp, 'pokechamps-tui.tar.gz');
    const body = Buffer.from('fake-gzip-bytes');
    writeFileSync(bundle, body);
    process.env.POKECHAMPS_TUI_BUNDLE = bundle;

    const res = await app.inject({ method: 'GET', url: '/download/tui.tar.gz' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/gzip');
    expect(res.headers['content-length']).toBe(String(body.length));
    expect(res.headers['content-disposition']).toContain('pokechamps-tui.tar.gz');
    expect(res.rawPayload.equals(body)).toBe(true);
  });

  it('returns a 404 with a build hint when the bundle is missing', async () => {
    process.env.POKECHAMPS_TUI_BUNDLE = join(tmp, 'does-not-exist.tar.gz');

    const res = await app.inject({ method: 'GET', url: '/download/tui.tar.gz' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'tui_bundle_not_built' });
  });

  it('serves the .sha256 checksum as text, no auth required', async () => {
    const bundle = join(tmp, 'pokechamps-tui.tar.gz');
    writeFileSync(bundle, Buffer.from('fake-gzip-bytes'));
    const sum = `deadbeef  pokechamps-tui.tar.gz\n`;
    writeFileSync(`${bundle}.sha256`, sum);
    process.env.POKECHAMPS_TUI_BUNDLE = bundle;

    const res = await app.inject({ method: 'GET', url: '/download/tui.tar.gz.sha256' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toBe(sum);
  });

  it('404s the checksum when it is missing', async () => {
    process.env.POKECHAMPS_TUI_BUNDLE = join(tmp, 'does-not-exist.tar.gz');
    const res = await app.inject({ method: 'GET', url: '/download/tui.tar.gz.sha256' });
    expect(res.statusCode).toBe(404);
  });
});
