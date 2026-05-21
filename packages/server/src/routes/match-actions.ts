// Match-action endpoints. Two siblings under /matches:
//
//   POST /matches/:id/turns
//     Body: { actions: MoveAction[]; field: FieldState }
//     Server appends as a new Turn, runs the full
//     finalizeTurn pipeline (HP commit → inference → speed → switch hazards →
//     EOT → outcome detect), persists, returns the updated Match.
//
//   POST /matches/:id/state
//     Body: { update: StateUpdate | HazardUpdate }
//     Server applies the immediate state mutation (HP set/heal/faint/replace,
//     boosts, status, hazards, etc.), persists, returns the updated Match.
//
// Both routes are authed and ownership-scoped (404 on cross-user / missing).
// activeIdx is *derived* from the persisted match (deriveActiveIdx walks
// initial leads + every turn's switch actions) so the schema doesn't need to
// track it explicitly. This is a "v1" approximation — for hazard / state
// updates that include bringIntoSlot, the post-update activeIdx is reflected
// in subsequent turn replays because the call to derive happens AFTER the
// update has been re-applied (we don't persist activeIdx in the row).
//
// Schemas are deliberately loose: the engine accepts whatever shape and
// produces a usable result or throws — Phase 2.5+ can tighten these once the
// TUI/web contracts are stable.
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Match } from '@pokechamps/core';
import {
  finalizeTurn,
  applyStateUpdate,
  deriveActiveIdx,
} from '@pokechamps/core';
import { getDb } from '../db/connection.js';
import type { JwtPayload } from '../auth/jwt.js';
import { MATCH_BODY_LIMIT, loadMatch, saveMatch } from './match-storage.js';
import { broadcastMatch } from '../ws/hub.js';
import { issueTicket } from '../ws/tickets.js';

// Loose schemas — pass-through to the engine. We only validate the top-level
// envelope and array-ness; the engine itself enforces semantic validity.
const turnBodySchema = z.object({
  actions: z.array(z.record(z.string(), z.unknown())),
  field: z.record(z.string(), z.unknown()),
});

const stateBodySchema = z.object({
  update: z.record(z.string(), z.unknown()),
});

function badRequest(reply: FastifyReply, err: z.ZodError) {
  return reply.code(400).send({
    error: 'invalid request body',
    issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
  });
}

const matchActionsRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const db = getDb();

  // POST /matches/:id/turns — append a new turn and run finalize pipeline.
  app.post<{ Params: { id: string } }>(
    '/:id/turns',
    {
      preHandler: app.authenticate,
      bodyLimit: MATCH_BODY_LIMIT,
    },
    async (request, reply) => {
      const parsed = turnBodySchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const user = request.user as JwtPayload;

      const match = loadMatch(db, user.sub, request.params.id);
      if (!match) return reply.code(404).send({ error: 'match not found' });

      const activeIdx = deriveActiveIdx(match);
      try {
        const result = finalizeTurn({
          match,
          turn: {
            actions: parsed.data.actions as any,
            field: parsed.data.field as any,
          },
          activeIdx,
        });
        const changes = saveMatch(db, user.sub, result.match);
        if (changes === 0) return reply.code(404).send({ error: 'match not found' });
        broadcastMatch(request.params.id, result.match, 'turn');
        return result.match as Match;
      } catch (err) {
        request.log.error({ err }, 'finalizeTurn failed');
        return reply.code(400).send({
          error: 'engine error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // POST /matches/:id/live-ticket — mint a single-use 30s ticket for the
  // WebSocket /matches/:id/live upgrade. Browser clients use this so the
  // long-lived JWT never appears in a URL (which would leak it via access
  // logs, browser history, Referer headers, etc.).
  app.post<{ Params: { id: string } }>(
    '/:id/live-ticket',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user as JwtPayload;
      // Ownership check: don't issue tickets for matches the user can't see.
      const match = loadMatch(db, user.sub, request.params.id);
      if (!match) return reply.code(404).send({ error: 'match not found' });
      const ticket = issueTicket(user.sub, request.params.id);
      return reply.code(200).send({ ticket, expiresInMs: 30_000 });
    },
  );

  // POST /matches/:id/state — apply an immediate state mutation.
  app.post<{ Params: { id: string } }>(
    '/:id/state',
    {
      preHandler: app.authenticate,
      bodyLimit: MATCH_BODY_LIMIT,
    },
    async (request, reply) => {
      const parsed = stateBodySchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const user = request.user as JwtPayload;

      const match = loadMatch(db, user.sub, request.params.id);
      if (!match) return reply.code(404).send({ error: 'match not found' });

      const activeIdx = deriveActiveIdx(match);
      try {
        const result = applyStateUpdate({
          match,
          update: parsed.data.update as any,
          activeIdx,
        });
        const changes = saveMatch(db, user.sub, result.match);
        if (changes === 0) return reply.code(404).send({ error: 'match not found' });
        broadcastMatch(request.params.id, result.match, 'state');
        return result.match as Match;
      } catch (err) {
        request.log.error({ err }, 'applyStateUpdate failed');
        return reply.code(400).send({
          error: 'engine error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
};

export default matchActionsRoutes;
