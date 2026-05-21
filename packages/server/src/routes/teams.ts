// Teams routes plugin. Mounted at /teams (see app.ts) — paths here are
// relative. PokemonSet[] is stored as a JSON blob in team_json; we don't
// validate the inner shape because:
//   1. The Showdown-export-derived PokemonSet has too many optional fields
//      to be worth re-encoding as a zod schema here.
//   2. The TUI is the only writer and already round-trips through
//      parseShowdownTeam; if anything is wrong, the client sees it first.
// We do bound the body to 64KB so a hostile client can't fill the DB.
//
// Authentication: every route uses { preHandler: app.authenticate }; the
// user id comes from request.user.sub (set by either the JWT or the PAT
// path inside authenticate.ts).
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { newId } from '../auth/ids.js';
import type { JwtPayload } from '../auth/jwt.js';

// Bound size of team_json. 64KB is ~32x the size of a fully-specified
// Showdown export for 6 mons; comfortable headroom without inviting abuse.
const TEAM_BODY_LIMIT = 64 * 1024;

// `team` is opaque to the server — we trust the client to send valid
// PokemonSet[]. zod just confirms it's an array and stores nothing else.
const upsertBodySchema = z.object({
  team: z.array(z.any()),
});

interface TeamRow {
  name: string;
  team_json: string;
}

function badRequest(reply: FastifyReply, err: z.ZodError) {
  return reply.code(400).send({
    error: 'invalid request body',
    issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
  });
}

const teamsRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const db = getDb();

  // List — sorted by name so the UI gets stable ordering for free.
  app.get(
    '/',
    { preHandler: app.authenticate },
    async (request) => {
      const user = request.user as JwtPayload;
      const rows = db
        .prepare<[string], TeamRow>(
          'SELECT name, team_json FROM teams WHERE user_id = ? ORDER BY name ASC',
        )
        .all(user.sub);
      return rows.map(r => ({ name: r.name, team: JSON.parse(r.team_json) as unknown[] }));
    },
  );

  app.get<{ Params: { name: string } }>(
    '/:name',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user as JwtPayload;
      const row = db
        .prepare<[string, string], TeamRow>(
          'SELECT name, team_json FROM teams WHERE user_id = ? AND name = ?',
        )
        .get(user.sub, request.params.name);
      if (!row) return reply.code(404).send({ error: 'team not found' });
      return { name: row.name, team: JSON.parse(row.team_json) as unknown[] };
    },
  );

  // Upsert — INSERT ... ON CONFLICT lets PUT be idempotent without a
  // separate "does it exist?" round trip. id is only consulted on first
  // insert; subsequent updates keep the original id and bump updated_at.
  app.put<{ Params: { name: string } }>(
    '/:name',
    {
      preHandler: app.authenticate,
      bodyLimit: TEAM_BODY_LIMIT,
    },
    async (request, reply) => {
      const parsed = upsertBodySchema.safeParse(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const user = request.user as JwtPayload;
      const { name } = request.params;
      const team_json = JSON.stringify(parsed.data.team);
      const now = new Date().toISOString();
      const id = newId();

      db.prepare(
        `INSERT INTO teams (id, user_id, name, team_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, name) DO UPDATE SET
           team_json = excluded.team_json,
           updated_at = excluded.updated_at`,
      ).run(id, user.sub, name, team_json, now, now);

      return reply.code(200).send({ name, team: parsed.data.team });
    },
  );

  app.delete<{ Params: { name: string } }>(
    '/:name',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user as JwtPayload;
      // Scope DELETE to the authed user — returning 404 (not 403) when the
      // row is missing OR belongs to someone else avoids leaking existence.
      const info = db
        .prepare('DELETE FROM teams WHERE user_id = ? AND name = ?')
        .run(user.sub, request.params.name);
      if (info.changes === 0) {
        return reply.code(404).send({ error: 'team not found' });
      }
      return reply.code(204).send();
    },
  );
};

export default teamsRoutes;
