// Barrel for the storage layer. The TUI imports `defaultStores()` to get the
// runtime-appropriate impl; Phase 3.1+ selects between file and http based on
// POKECHAMPS_SERVER_URL / POKECHAMPS_TOKEN env vars.
export type {
  TeamStore,
  MatchStore,
  PikalyticsStore,
  Stores,
  SavedTeam,
  MatchSummary,
} from './types.js';
export { createFileStores } from './fileStore.js';
export { createHttpStores, type HttpStoreConfig } from './httpStore.js';

import { createFileStores } from './fileStore.js';
import { createHttpStores } from './httpStore.js';
import type { Stores } from './types.js';

// Returns the http-backed impl when POKECHAMPS_SERVER_URL is set, else the
// local file-backed impl. POKECHAMPS_TOKEN supplies the bearer; without it
// the server will reject every request with 401 — Phase 3.2 wires the auth
// CLI that writes the config file.
export function defaultStores(): Stores {
  const url = typeof process !== 'undefined' ? process.env.POKECHAMPS_SERVER_URL : undefined;
  if (url) {
    const token = process.env.POKECHAMPS_TOKEN ?? null;
    return createHttpStores({
      baseUrl: url.replace(/\/$/, ''),
      getToken: () => token,
    });
  }
  return createFileStores();
}
