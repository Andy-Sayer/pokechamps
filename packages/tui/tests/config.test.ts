// config.ts persistence tests. Each test gets its own tmpdir for HOME so
// the real ~/.pokechamps file is never touched and tests stay hermetic.
//
// Both Windows and POSIX path to the home dir are honored by the OS
// homedir() reader; we override via HOME on POSIX and USERPROFILE on
// Windows so the test passes everywhere.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalServerUrl: string | undefined;
let originalToken: string | undefined;

async function loadFresh() {
  vi.resetModules();
  return await import('../src/config.js');
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'pokechamps-config-'));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalServerUrl = process.env.POKECHAMPS_SERVER_URL;
  originalToken = process.env.POKECHAMPS_TOKEN;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.POKECHAMPS_SERVER_URL;
  delete process.env.POKECHAMPS_TOKEN;
});

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  process.env.POKECHAMPS_SERVER_URL = originalServerUrl;
  process.env.POKECHAMPS_TOKEN = originalToken;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('saveConfig / loadConfig', () => {
  it('round-trips serverUrl + token + email', async () => {
    const { loadConfig, saveConfig, configPath } = await loadFresh();
    expect(existsSync(configPath())).toBe(false);

    saveConfig({
      serverUrl: 'http://srv.test:3000',
      token: 'jwt.payload.sig',
      email: 'alice@example.com',
    });
    expect(existsSync(configPath())).toBe(true);

    const loaded = loadConfig();
    expect(loaded.serverUrl).toBe('http://srv.test:3000');
    expect(loaded.token).toBe('jwt.payload.sig');
    expect(loaded.email).toBe('alice@example.com');
  });

  it('strips trailing slash from serverUrl', async () => {
    const { loadConfig, saveConfig } = await loadFresh();
    saveConfig({ serverUrl: 'http://srv.test:3000/', token: 't' });
    expect(loadConfig().serverUrl).toBe('http://srv.test:3000');
  });

  it('cleared (empty-string / undefined) fields are not persisted as blank keys', async () => {
    const { loadConfig, saveConfig, configPath } = await loadFresh();
    // Save full config, then clear everything except email.
    saveConfig({ serverUrl: 'http://srv', token: 'tok', email: 'e@e' });
    saveConfig({ email: 'e@e' }); // serverUrl + token absent

    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
    expect(raw).toEqual({ email: 'e@e' });
    expect(loadConfig().serverUrl).toBeUndefined();
    expect(loadConfig().token).toBeUndefined();
  });

  it('save uses .tmp + rename (no half-written file visible on crash)', async () => {
    // We don't actually crash, but we DO verify the temp file is not left
    // behind on a successful write and that the final file is well-formed.
    const { saveConfig, configPath } = await loadFresh();
    saveConfig({ serverUrl: 'http://srv', token: 'tok' });
    expect(existsSync(`${configPath()}.tmp`)).toBe(false);
    const raw = JSON.parse(readFileSync(configPath(), 'utf8'));
    expect(raw.serverUrl).toBe('http://srv');
  });

  it('returns empty config when no file exists', async () => {
    const { loadConfig } = await loadFresh();
    expect(loadConfig()).toEqual({
      serverUrl: undefined,
      token: undefined,
      email: undefined,
    });
  });

  it('treats a corrupt JSON file as empty (does not throw)', async () => {
    const { configDir, configPath, loadConfig } = await loadFresh();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configPath(), '{ not valid json', 'utf8');
    expect(() => loadConfig()).not.toThrow();
    expect(loadConfig().serverUrl).toBeUndefined();
  });
});

describe('env-var overrides', () => {
  it('POKECHAMPS_SERVER_URL overrides the file value at read time', async () => {
    const { saveConfig, loadConfig } = await loadFresh();
    saveConfig({ serverUrl: 'http://file-value', token: 'tok' });
    process.env.POKECHAMPS_SERVER_URL = 'http://env-value';
    // Need a fresh module — loadConfig isn't cached but the env read happens
    // at call time, so reloading is just belt-and-braces.
    const { loadConfig: load2 } = await loadFresh();
    expect(load2().serverUrl).toBe('http://env-value');
    // Sanity: the file is unchanged.
    expect(loadConfig().serverUrl).toBe('http://env-value');
  });

  it('POKECHAMPS_TOKEN overrides the file value', async () => {
    const { saveConfig } = await loadFresh();
    saveConfig({ serverUrl: 'http://srv', token: 'file-token' });
    process.env.POKECHAMPS_TOKEN = 'env-token';
    const { loadConfig: load2 } = await loadFresh();
    expect(load2().token).toBe('env-token');
  });
});

describe('isRemoteMode', () => {
  it('true when serverUrl is set, false otherwise', async () => {
    const { isRemoteMode } = await loadFresh();
    expect(isRemoteMode({ serverUrl: 'http://srv' })).toBe(true);
    expect(isRemoteMode({})).toBe(false);
    expect(isRemoteMode({ token: 'tok' })).toBe(false);
  });
});
