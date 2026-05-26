// Transport-agnostic storage contracts. Phase 1.4 introduces these so a
// future httpStore (Phase 3) can drop in alongside the current file-backed
// impl. The TUI screens depend only on these interfaces, not on the
// concrete fileStore.
//
// TeamStore / MatchStore are async because the httpStore impl will be
// network-bound; the fileStore wraps the existing sync primitives in
// Promise.resolve so callers can `await` uniformly.
//
// PikalyticsStore.get stays SYNC on purpose: predictions/autocomplete hit
// it on every render and pulling it behind useEffect would force a state
// spread we don't want. The future httpStore will keep an in-memory mirror
// of fetched entries to satisfy this contract.
import type { PokemonSet, Match } from '../domain/types.js';
import type { PikalyticsEntry } from '../scripts/refresh-pikalytics.js';

export interface SavedTeam {
  name: string;
  team: PokemonSet[];
}

// Lightweight projection for list views. Avoids forcing a full Match parse
// for every snapshot when only a label is needed.
export interface MatchSummary {
  id: string;
  startedAt: string;
  outcome?: Match['outcome'];
  myTeamSpecies?: string[];
  opponentTeamSpecies?: string[];
}

export interface TeamStore {
  list(): Promise<SavedTeam[]>;
  get(name: string): Promise<SavedTeam | null>;
  save(name: string, team: PokemonSet[]): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface MatchStore {
  // create: callers continue to allocate the id (typically `Date.now()`); the
  // store just persists the match and echoes it back.
  create(match: Match): Promise<{ id: string; match: Match }>;
  get(id: string): Promise<Match | null>;
  list(): Promise<MatchSummary[]>;
  // Full replace for v1 simplicity — fine for the local fileStore. The
  // httpStore will translate this into a PATCH with the full body.
  update(id: string, match: Match): Promise<void>;
  // Live-update hook for Phase 3 collaborators. fileStore returns a no-op
  // unsubscribe — there are no other writers in local mode.
  subscribe(id: string, onChange: (m: Match) => void): () => void;
  // Live spectator sharing (remote mode only). share() mints/returns a
  // capability token + spectator URL; unshare() revokes it. Optional —
  // fileStore omits them, and callers treat their absence as "local mode,
  // sharing unavailable". See docs/notes/live-share-plan.md.
  share?(id: string): Promise<{ token: string; url: string }>;
  unshare?(id: string): Promise<void>;
}

export interface PikalyticsStore {
  get(species: string): PikalyticsEntry | null;
  fetchAndCache(species: string): void;
  isFetching(species: string): boolean;
  onChange(cb: () => void): () => void;
}

export interface Stores {
  teams: TeamStore;
  matches: MatchStore;
  pikalytics: PikalyticsStore;
}
