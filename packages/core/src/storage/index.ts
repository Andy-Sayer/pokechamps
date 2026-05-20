// Barrel for the storage layer. The TUI imports `defaultStores()` to get the
// local file-backed impl; Phase 3 will swap to httpStore based on a runtime
// config flag without touching screen-level imports.
export type {
  TeamStore,
  MatchStore,
  PikalyticsStore,
  Stores,
  SavedTeam,
  MatchSummary,
} from './types.js';
export { createFileStores } from './fileStore.js';

import { createFileStores } from './fileStore.js';
import type { Stores } from './types.js';

export function defaultStores(): Stores {
  return createFileStores();
}
