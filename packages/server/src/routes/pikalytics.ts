// Pikalytics cache endpoints. Auth-gated but the cache is server-shared
// across users — Pikalytics describes the metagame, not user-private data.
//
// GET /pikalytics            → list cached species names (for bootstrap)
// GET /pikalytics/:species   → cached entry, OR 202 + fetches in background
// POST /pikalytics/:species/refresh → force a refetch and wait for result
//
// The 202 path is fire-and-forget from the request side; the entry shows up
// in a subsequent GET (or the TUI re-queries on a WS-like cadence). For
// callers that want the entry inline, POST /refresh waits up to the fetch
// timeout and returns the new entry.
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { getDb } from '../db/connection.js';
import {
  fetchAndCache,
  getEntry,
  listSpecies,
  PIKALYTICS_FORMAT,
} from '../pikalytics/cache.js';

const pikalyticsRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const db = getDb();

  app.get('/', { preHandler: app.authenticate }, async () => {
    return {
      format: PIKALYTICS_FORMAT,
      species: listSpecies(db),
    };
  });

  app.get<{ Params: { species: string } }>(
    '/:species',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { species } = request.params;
      const cached = getEntry(db, species);
      if (cached) {
        return {
          status: 'ok' as const,
          species: cached.species,
          fetchedAt: cached.fetchedAt,
          entry: cached.entry,
        };
      }
      // Kick off the fetch but don't await — the caller can poll back.
      void fetchAndCache(db, species);
      return reply.code(202).send({
        status: 'fetching' as const,
        species,
      });
    },
  );

  app.post<{ Params: { species: string } }>(
    '/:species/refresh',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { species } = request.params;
      const entry = await fetchAndCache(db, species);
      if (!entry) {
        return reply.code(502).send({
          status: 'error' as const,
          species,
          error: 'Pikalytics fetch failed',
        });
      }
      const stored = getEntry(db, species);
      return {
        status: 'ok' as const,
        species,
        fetchedAt: stored?.fetchedAt ?? new Date().toISOString(),
        entry,
      };
    },
  );
};

export default pikalyticsRoutes;
