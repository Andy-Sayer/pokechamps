// Owner-side share-token management for live spectating. Mounted under
// /matches (see app.ts). All three routes are authed and ownership-scoped via
// loadMatch — you can only share a match you own.
//
//   POST   /matches/:id/share  → create-or-return token { token, url }
//   GET    /matches/:id/share  → current share { token, url } | { token:null }
//   DELETE /matches/:id/share  → revoke (204)
//
// `url` is a best-effort spectator link built from POKECHAMPS_PUBLIC_URL (or
// the request's own host as a fallback). It currently points at the snapshot
// API path; once the web spectator page ships (plan Phase B) this becomes the
// friendly browser URL. The token is the durable thing — clients can format
// their own link from it.
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { getDb } from '../db/connection.js';
import type { JwtPayload } from '../auth/jwt.js';
import { loadMatch } from './match-storage.js';
import { createShare, getShareForMatch, revokeShare } from '../db/shares.js';

// Public base URL for spectator links. Prefer an explicit env (set it to your
// real https origin in prod); otherwise reconstruct from the request so dev
// works out of the box. No trailing slash.
function publicBase(request: FastifyRequest): string {
  const env = process.env.POKECHAMPS_PUBLIC_URL;
  if (env) return env.replace(/\/$/, '');
  return `${request.protocol}://${request.host}`;
}

function spectateUrl(request: FastifyRequest, token: string): string {
  return `${publicBase(request)}/spectate/${token}`;
}

const sharesRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const db = getDb();

  app.post<{ Params: { id: string } }>(
    '/:id/share',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user as JwtPayload;
      const match = loadMatch(db, user.sub, request.params.id);
      if (!match) return reply.code(404).send({ error: 'match not found' });
      const token = createShare(db, user.sub, request.params.id);
      return reply.code(200).send({ token, url: spectateUrl(request, token) });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/:id/share',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user as JwtPayload;
      const match = loadMatch(db, user.sub, request.params.id);
      if (!match) return reply.code(404).send({ error: 'match not found' });
      const token = getShareForMatch(db, user.sub, request.params.id);
      if (!token) return reply.code(200).send({ token: null });
      return reply.code(200).send({ token, url: spectateUrl(request, token) });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/:id/share',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user as JwtPayload;
      // Ownership is enforced by the WHERE owner_id in revokeShare; we still
      // 404 a non-owner so we don't leak whether the match/share exists.
      const match = loadMatch(db, user.sub, request.params.id);
      if (!match) return reply.code(404).send({ error: 'match not found' });
      revokeShare(db, user.sub, request.params.id);
      return reply.code(204).send();
    },
  );
};

export default sharesRoutes;
