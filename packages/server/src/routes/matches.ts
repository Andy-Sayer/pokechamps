// Matches routes plugin. Mounted at /matches (see app.ts). A Match is a fat
// blob (turns, opponent candidates, field state, etc.) so we store it as JSON
// in match_json and denormalize two fields — outcome and startedAt — into
// columns so list queries can sort and label without parsing every row.
//
// Server is the source of truth for match.id: we generate a UUID on POST and
// overwrite whatever the client sent. This lets Phase 3's httpStore use the
// same MatchStore.create({ id, match }) shape that the fileStore already does
// (the local store currently lets the caller pick the id, but server-assigned
// is the right Phase 2+ invariant — see storage/types.ts).
//
// Ownership: every read/write narrows by user_id. Other-user rows return 404,
// not 403, so we don't leak whether an id is in use.
//
// Body limit: matches grow with turn history, so 256KB (4x the teams limit).
// At ~2KB per turn that's headroom for ~100 turns plus the static team blobs.
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Match, MatchSummary, PokemonSet, OpponentEntry } from '@pokechamps/core';
import { getDb } from '../db/connection.js';
import type { JwtPayload } from '../auth/jwt.js';
import { MATCH_BODY_LIMIT, denormalize, type MatchRow } from './match-storage.js';
import { broadcastMatch } from '../ws/hub.js';

// Trust the client on the Match shape (same reasoning as teams.ts — too many
// optional fields to recapitulate). We only require that `match` is present
// and is an object so the denormalization step below has something to read.
const matchBodySchema = z.object({
  match: z.record(z.string(), z.unknown()),
});

function badRequest(reply: FastifyReply, err: z.ZodError) {
  return reply.code(400).send({
    error: 'invalid request body',
    issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
  });
}

// Best-effort projection for the list view. The schema doesn't constrain
// myTeam/opponentTeam, so we defensively pluck `.species` only when present.
function toSummary(row: MatchRow): MatchSummary {
  let myTeamSpecies: string[] | undefined;
  let opponentTeamSpecies: string[] | undefined;
  try {
    const parsed = JSON.parse(row.match_json) as Partial<Match>;
    if (Array.isArray(parsed.myTeam)) {
      myTeamSpecies = (parsed.myTeam as PokemonSet[])
        .map(s => s?.species)
        .filter((s): s is string => typeof s === 'string');
    }
    if (Array.isArray(parsed.opponentTeam)) {
      opponentTeamSpecies = (parsed.opponentTeam as OpponentEntry[])
        .map(o => o?.species)
        .filter((s): s is string => typeof s === 'string');
    }
  } catch {
    // Corrupt JSON shouldn't crash list; just omit species.
  }
  return {
    id: row.id,
    startedAt: row.started_at,
    outcome: (row.outcome as MatchSummary['outcome']) ?? undefined,
    myTeamSpecies,
    opponentTeamSpecies,
  };
}

const matchesRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const db = getDb();

  // CREATE. Server assigns the id and overwrites whatever the client sent —
  // this is the single source of truth going forward.
  app.post(
    '/',
    {
      preHandler: app.authenticate,
      bodyLimit: MATCH_BODY_LIMIT,
    },
    async (request, reply) => {
      const parsed = matchBodySchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const user = request.user as JwtPayload;

      const id = randomUUID();
      // Clone + override id so the persisted blob matches the row's PK.
      const match = { ...parsed.data.match, id };
      const { startedAt, outcome } = denormalize(match);

      db.prepare(
        `INSERT INTO matches (id, user_id, started_at, outcome, match_json)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, user.sub, startedAt, outcome, JSON.stringify(match));

      return reply.code(200).send({ id, match });
    },
  );

  // LIST. Returns MatchSummary[] sorted newest-first. We pull match_json so
  // toSummary can extract species names — the matches_user_started_idx index
  // covers the ORDER BY.
  app.get('/', { preHandler: app.authenticate }, async (request) => {
    const user = request.user as JwtPayload;
    const rows = db
      .prepare<[string], MatchRow>(
        `SELECT id, started_at, outcome, match_json
         FROM matches
         WHERE user_id = ?
         ORDER BY started_at DESC`,
      )
      .all(user.sub);
    return rows.map(toSummary);
  });

  app.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user as JwtPayload;
      const row = db
        .prepare<[string, string], { match_json: string }>(
          'SELECT match_json FROM matches WHERE user_id = ? AND id = ?',
        )
        .get(user.sub, request.params.id);
      // 404 (not 403) when the row exists but is someone else's, to avoid
      // leaking id existence. The user_id filter handles both cases uniformly.
      if (!row) return reply.code(404).send({ error: 'match not found' });
      return JSON.parse(row.match_json) as Match;
    },
  );

  // PATCH = full replace for v1. Phase 2.4 can swap in a smarter merger
  // (turn-append, opponent-candidate delta) but for now the client just
  // re-sends the whole match. Preserve the original id so the URL and the
  // blob stay in sync even if the client forgot to keep it.
  app.patch<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: app.authenticate,
      bodyLimit: MATCH_BODY_LIMIT,
    },
    async (request, reply) => {
      const parsed = matchBodySchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const user = request.user as JwtPayload;
      const { id } = request.params;

      const match = { ...parsed.data.match, id };
      const { startedAt, outcome } = denormalize(match);

      const info = db
        .prepare(
          `UPDATE matches
           SET started_at = ?, outcome = ?, match_json = ?
           WHERE user_id = ? AND id = ?`,
        )
        .run(startedAt, outcome, JSON.stringify(match), user.sub, id);
      if (info.changes === 0) {
        return reply.code(404).send({ error: 'match not found' });
      }
      broadcastMatch(id, match, 'crud');
      return match as Match;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user as JwtPayload;
      const info = db
        .prepare('DELETE FROM matches WHERE user_id = ? AND id = ?')
        .run(user.sub, request.params.id);
      if (info.changes === 0) {
        return reply.code(404).send({ error: 'match not found' });
      }
      return reply.code(204).send();
    },
  );
};

export default matchesRoutes;
