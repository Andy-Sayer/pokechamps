// Per-user config for the TUI. Stored as JSON at ~/.pokechamps/config.json
// (or %USERPROFILE%\.pokechamps\config.json on Windows).
//
// Env vars override the file values for one-shot debugging:
//   POKECHAMPS_SERVER_URL  → temporary server override
//   POKECHAMPS_TOKEN       → temporary token override
//
// The file is rewritten atomically (write-temp + rename) so a crash during
// write can't leave a half-baked config in place.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PokechampsConfig {
  /** Base URL of @pokechamps/server, no trailing slash. Empty = local file mode. */
  serverUrl?: string;
  /** JWT (short-lived) or PAT (long-lived). Without this every request is 401. */
  token?: string;
  /** Cached for the UI's "logged in as X" line — never re-validated by us. */
  email?: string;
}

export function configDir(): string {
  return join(homedir(), '.pokechamps');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

export function loadConfig(): PokechampsConfig {
  let file: PokechampsConfig = {};
  try {
    if (existsSync(configPath())) {
      file = JSON.parse(readFileSync(configPath(), 'utf8')) as PokechampsConfig;
    }
  } catch {
    // Corrupt config shouldn't kill the TUI — treat as empty and let the user
    // re-enter via Server Settings.
  }
  return {
    serverUrl: process.env.POKECHAMPS_SERVER_URL ?? file.serverUrl,
    token: process.env.POKECHAMPS_TOKEN ?? file.token,
    email: file.email,
  };
}

export function saveConfig(next: PokechampsConfig): void {
  if (!existsSync(configDir())) mkdirSync(configDir(), { recursive: true });
  const tmp = `${configPath()}.tmp`;
  // Strip empty strings so a partially-cleared config doesn't keep blank keys.
  const cleaned: PokechampsConfig = {};
  if (next.serverUrl) cleaned.serverUrl = next.serverUrl.replace(/\/$/, '');
  if (next.token) cleaned.token = next.token;
  if (next.email) cleaned.email = next.email;
  writeFileSync(tmp, JSON.stringify(cleaned, null, 2) + '\n', 'utf8');
  renameSync(tmp, configPath());
}

export function isRemoteMode(cfg: PokechampsConfig): boolean {
  return Boolean(cfg.serverUrl);
}
