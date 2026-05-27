// GET /matches/:id/live — WebSocket subscription for live match state.
//
// Auth: tries the Authorization header first (Node clients can set it), then
// falls back to `?token=<jwt|pat>` on the upgrade URL (browsers can't set
// arbitrary headers on the WS handshake). Either path must resolve to a user
// who owns the match, else we close with 4401 (auth) or 4404 (not found).
//
// On connect: sends one { type:'snapshot', match } envelope so the client
// doesn't need a separate GET /matches/:id round-trip.
// On every server-side mutation (turn/state/CRUD): the hub pushes a
// { type:'update', match, source } envelope to every subscriber for that id.
//
// We do NOT accept inbound mutations on this socket. Clients still POST to
// /matches/:id/turns etc. and receive the broadcast back. This keeps the auth
// + validation pipeline single-sourced through HTTP routes.
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { getDb } from '../db/connection.js';
import { loadMatch } from './match-storage.js';
import { subscribe, unsubscribe, type LiveEnvelope } from '../ws/hub.js';
import { verifyTokenForLive } from '../auth/wsAuth.js';

interface LiveParams {
  id: string;
}

interface LiveQuery {
  token?: string;
  ticket?: string;
  /** Spectator capability token — read-only live access via a share link. */
  share?: string;
}

const wsMatchRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const db = getDb();

  app.get<{ Params: LiveParams; Querystring: LiveQuery }>(
    '/:id/live',
    { websocket: true },
    async (socket: WebSocket, request: FastifyRequest<{ Params: LiveParams; Querystring: LiveQuery }>) => {
      // Resolve user from header OR ?ticket= / ?token=. Close with a 4401
      // frame if nothing resolves — the browser side maps these custom codes
      // to error states.
      const auth = await verifyTokenForLive(app, request);
      if (!auth) {
        socket.close(4401, 'unauthorized');
        return;
      }
      const matchId = request.params.id;
      // Ticket scope check: tickets are minted for a specific (user, match).
      // If the client uses a ticket on a different match's upgrade URL, reject.
      if (auth.ticketMatchId && auth.ticketMatchId !== matchId) {
        socket.close(4401, 'ticket scope mismatch');
        return;
      }
      const user = auth.user;
      const match = loadMatch(db, user.sub, matchId);
      if (!match) {
        socket.close(4404, 'match not found');
        return;
      }

      subscribe(matchId, socket, auth.spectator === true);
      const snapshot: LiveEnvelope = { type: 'snapshot', match };
      try {
        socket.send(JSON.stringify(snapshot));
      } catch {
        // Send may fail if the socket already closed mid-handshake; the close
        // handler below will tidy up.
      }

      socket.on('close', () => unsubscribe(matchId, socket));
      // We don't expect inbound messages; drop them silently so a noisy client
      // can't crash the handler.
      socket.on('message', () => { /* ignore */ });
    },
  );
};

export default wsMatchRoutes;
