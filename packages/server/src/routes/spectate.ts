// Unauthenticated spectator endpoints, mounted at /spectate (see app.ts).
//
//   GET /spectate/:token → the match snapshot JSON (read-only)
//
// No auth: the share token IS the capability. We resolve it to (owner, match)
// and load the owner's match. A bad/revoked token is 404. The live WS half of
// spectating is handled in routes/ws-match.ts via ?share= (auth/wsAuth.ts).
//
// This route is intentionally read-only — there is no spectator write path. The
// mutation routes require a Bearer JWT/PAT and never accept a share token.
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { getDb } from '../db/connection.js';
import { loadMatch } from './match-storage.js';
import { resolveShare } from '../db/shares.js';

const spectateRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const db = getDb();

  app.get<{ Params: { token: string } }>(
    '/:token',
    async (request, reply) => {
      const resolved = resolveShare(db, request.params.token);
      if (!resolved) return reply.code(404).send({ error: 'share not found' });
      const match = loadMatch(db, resolved.ownerId, resolved.matchId);
      // Token resolved but match gone (race with delete; CASCADE should prevent
      // this, but be defensive) → 404.
      if (!match) return reply.code(404).send({ error: 'match not found' });
      return match;
    },
  );
};

export default spectateRoutes;
