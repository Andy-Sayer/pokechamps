// REST + WebSocket Stores impl. Talks to the @pokechamps/server Phase 2
// endpoints. Keeps the same async TeamStore / MatchStore contract as
// fileStore, plus a synchronous in-memory mirror for PikalyticsStore.get so
// the existing render-time call sites don't need to thread a Promise.
//
// Requires Node 22+ for global fetch and global WebSocket (the TUI runtime
// pins to that already via package.json engines).
import type { Match, PokemonSet } from '../domain/types.js';
import type { PikalyticsEntry } from '../scripts/refresh-pikalytics.js';
import type {
  MatchStore,
  MatchSummary,
  PikalyticsStore,
  Stores,
  SavedTeam,
  TeamStore,
} from './types.js';

export interface HttpStoreConfig {
  /** Base URL of the @pokechamps/server, no trailing slash. */
  baseUrl: string;
  /** Returns a JWT or PAT, or null when not authenticated yet. */
  getToken(): string | null;
  /** Optional override for fetch (tests inject a stub). */
  fetchImpl?: typeof fetch;
  /** Optional override for WebSocket ctor (tests inject a stub). */
  WebSocketImpl?: typeof WebSocket;
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(
  cfg: HttpStoreConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = cfg.getToken();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const fetcher = cfg.fetchImpl ?? fetch;
  const res = await fetcher(`${cfg.baseUrl}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(res.status, `${init.method ?? 'GET'} ${path}: ${res.status} ${text}`);
  }
  // Some 204s have no body — return undefined cast.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------------- TeamStore ----------------

function createTeamStore(cfg: HttpStoreConfig): TeamStore {
  return {
    async list(): Promise<SavedTeam[]> {
      const rows = await request<Array<{ name: string; team: PokemonSet[] }>>(cfg, '/teams');
      return rows.map(r => ({ name: r.name, team: r.team }));
    },
    async get(name: string): Promise<SavedTeam | null> {
      try {
        const row = await request<{ name: string; team: PokemonSet[] }>(
          cfg, `/teams/${encodeURIComponent(name)}`,
        );
        return { name: row.name, team: row.team };
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return null;
        throw e;
      }
    },
    async save(name: string, team: PokemonSet[]): Promise<void> {
      await request(cfg, `/teams/${encodeURIComponent(name)}`, {
        method: 'PUT',
        body: JSON.stringify({ team }),
      });
    },
    async delete(name: string): Promise<void> {
      await request(cfg, `/teams/${encodeURIComponent(name)}`, { method: 'DELETE' });
    },
  };
}

// ---------------- MatchStore ----------------

function createMatchStore(cfg: HttpStoreConfig): MatchStore {
  return {
    async create(match: Match): Promise<{ id: string; match: Match }> {
      // Server assigns the id and echoes the canonical match back. The
      // caller's match.id is overwritten — see server's matches.ts.
      const res = await request<{ id: string; match: Match }>(cfg, '/matches', {
        method: 'POST',
        body: JSON.stringify({ match }),
      });
      return res;
    },
    async get(id: string): Promise<Match | null> {
      try {
        return await request<Match>(cfg, `/matches/${encodeURIComponent(id)}`);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return null;
        throw e;
      }
    },
    async list(): Promise<MatchSummary[]> {
      return await request<MatchSummary[]>(cfg, '/matches');
    },
    async update(id: string, match: Match): Promise<void> {
      await request(cfg, `/matches/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ match }),
      });
    },
    subscribe(id: string, onChange: (m: Match) => void): () => void {
      // The browser WS handshake can't set arbitrary headers, so we always
      // pass the token in the query — works for both Node and browser clients.
      const token = cfg.getToken();
      const wsUrl = cfg.baseUrl
        .replace(/^http(s?):/, 'ws$1:')
        + `/matches/${encodeURIComponent(id)}/live`
        + (token ? `?token=${encodeURIComponent(token)}` : '');
      const Ctor = cfg.WebSocketImpl ?? WebSocket;
      const ws = new Ctor(wsUrl);
      let closed = false;
      ws.addEventListener('message', (ev: MessageEvent) => {
        if (closed) return;
        try {
          const env = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
          if (env && (env.type === 'snapshot' || env.type === 'update') && env.match) {
            onChange(env.match as Match);
          }
        } catch {
          // ignore malformed frames
        }
      });
      return () => {
        closed = true;
        try { ws.close(); } catch { /* ignore */ }
      };
    },
  };
}

// ---------------- PikalyticsStore ----------------

interface PikalyticsMirror {
  cache: Map<string, PikalyticsEntry>;
  inFlight: Set<string>;
  failed: Set<string>;
  listeners: Set<() => void>;
}

function createPikalyticsStore(cfg: HttpStoreConfig): PikalyticsStore {
  const m: PikalyticsMirror = {
    cache: new Map(),
    inFlight: new Set(),
    failed: new Set(),
    listeners: new Set(),
  };
  const notify = () => {
    for (const cb of m.listeners) try { cb(); } catch { /* swallow */ }
  };
  const doFetch = async (species: string): Promise<void> => {
    try {
      const res = await request<
        | { status: 'ok'; species: string; entry: PikalyticsEntry }
        | { status: 'fetching'; species: string }
      >(cfg, `/pikalytics/${encodeURIComponent(species)}`);
      if (res.status === 'ok') {
        m.cache.set(species, res.entry);
        notify();
      } else {
        // Server kicked off a background fetch; poll once after a beat.
        setTimeout(() => {
          m.inFlight.delete(species);
          void doFetch(species);
        }, 500);
        return;
      }
    } catch {
      m.failed.add(species);
    } finally {
      // Only clear when we got a final state (ok or fail); the polling branch
      // above re-enters before this block runs because of the early return.
      if (m.cache.has(species) || m.failed.has(species)) {
        m.inFlight.delete(species);
      }
    }
  };
  return {
    get(species: string) {
      return m.cache.get(species) ?? null;
    },
    fetchAndCache(species: string) {
      if (m.cache.has(species) || m.inFlight.has(species) || m.failed.has(species)) return;
      m.inFlight.add(species);
      void doFetch(species);
    },
    isFetching(species: string) {
      return m.inFlight.has(species);
    },
    onChange(cb: () => void) {
      m.listeners.add(cb);
      return () => { m.listeners.delete(cb); };
    },
  };
}

export function createHttpStores(cfg: HttpStoreConfig): Stores {
  return {
    teams: createTeamStore(cfg),
    matches: createMatchStore(cfg),
    pikalytics: createPikalyticsStore(cfg),
  };
}
