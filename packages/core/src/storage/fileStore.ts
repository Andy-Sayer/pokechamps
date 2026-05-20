// Node fs-backed Stores impl. Wraps the existing sync primitives in
// `domain/storage.ts` / `domain/pikalytics.ts` / `domain/pikalyticsFetch.ts`
// so the 175-test suite (which still calls those sync APIs directly) keeps
// passing while the TUI migrates to the async Stores interface.
import type { Match, PokemonSet } from '../domain/types.js';
import {
  listTeams,
  saveTeam,
  saveMatch,
  listMatches,
} from '../domain/storage.js';
import { getPikalytics } from '../domain/pikalytics.js';
import {
  fetchAndCache,
  isFetching,
  onPikalyticsChange,
} from '../domain/pikalyticsFetch.js';
import type {
  MatchStore,
  MatchSummary,
  PikalyticsStore,
  Stores,
  SavedTeam,
  TeamStore,
} from './types.js';

function createTeamStore(): TeamStore {
  return {
    list(): Promise<SavedTeam[]> {
      return Promise.resolve(listTeams());
    },
    get(name: string): Promise<SavedTeam | null> {
      const teams = listTeams();
      const found = teams.find(t => t.name === name);
      return Promise.resolve(found ?? null);
    },
    save(name: string, team: PokemonSet[]): Promise<void> {
      saveTeam(name, team);
      return Promise.resolve();
    },
    delete(_name: string): Promise<void> {
      // Not exposed by the legacy sync API yet — callers don't use it today.
      // Stubbed so the interface compiles; httpStore will implement it for real.
      return Promise.reject(new Error('TeamStore.delete not implemented for fileStore'));
    },
  };
}

function createMatchStore(): MatchStore {
  return {
    create(match: Match): Promise<{ id: string; match: Match }> {
      saveMatch(match);
      return Promise.resolve({ id: match.id, match });
    },
    get(id: string): Promise<Match | null> {
      // Inefficient (re-reads every snapshot) but correct. Optimize later if
      // the list grows beyond a handful of matches.
      return Promise.resolve(listMatches().find(m => m.id === id)?.match ?? null);
    },
    list(): Promise<MatchSummary[]> {
      return Promise.resolve(
        listMatches().map(m => ({
          id: m.id,
          startedAt: m.match.startedAt,
          outcome: m.match.outcome,
          myTeamSpecies: m.match.myTeam.map(s => s.species),
          opponentTeamSpecies: m.match.opponentTeam.map(o => o.species),
        })),
      );
    },
    update(_id: string, match: Match): Promise<void> {
      // Full replace — the sync saveMatch writes the whole file by id.
      saveMatch(match);
      return Promise.resolve();
    },
    subscribe(_id: string, _onChange: (m: Match) => void): () => void {
      // No live updates in local mode. httpStore (Phase 3) wires this to WS.
      return () => { /* no-op */ };
    },
  };
}

function createPikalyticsStore(): PikalyticsStore {
  return {
    get(species: string) {
      return getPikalytics(species);
    },
    fetchAndCache(species: string) {
      fetchAndCache(species);
    },
    isFetching(species: string) {
      return isFetching(species);
    },
    onChange(cb: () => void) {
      return onPikalyticsChange(cb);
    },
  };
}

export function createFileStores(): Stores {
  return {
    teams: createTeamStore(),
    matches: createMatchStore(),
    pikalytics: createPikalyticsStore(),
  };
}
