// App factory. Constructing the Fastify instance separately from listening on
// a port lets tests use `app.inject()` against the same wiring the real server
// uses. index.ts handles process-level concerns (listen, signals, exit codes).
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import { getDb } from './db/connection.js';
import { migrate } from './db/migrations.js';
import { registerJwt } from './auth/jwt.js';
import { authenticateFactory } from './auth/authenticate.js';
import authRoutes from './auth/routes.js';
import teamsRoutes from './routes/teams.js';
import matchesRoutes from './routes/matches.js';
import matchActionsRoutes from './routes/match-actions.js';
import wsMatchRoutes from './routes/ws-match.js';

export interface BuildAppOptions {
  /** Override the default logger (set false to silence in tests). */
  logger?: boolean | { level?: string };
}

export interface BuiltApp {
  app: FastifyInstance;
  migration: { applied: string[]; latest: string | null };
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<BuiltApp> {
  const app = Fastify({
    logger: opts.logger ?? { level: process.env.LOG_LEVEL ?? 'info' },
  });

  // DB + migrations BEFORE plugins/routes — routes' getDb() calls expect the
  // schema to be present. Failing here aborts startup, which is what we want.
  const db = getDb();
  const migration = migrate(db);
  app.log.info(
    { applied: migration.applied, latest: migration.latest },
    migration.applied.length > 0
      ? `migrations applied: ${migration.applied.join(', ')}`
      : 'no new migrations',
  );

  // Plugins. Order matters: cookie before jwt (jwt can read tokens from
  // cookies), rate-limit early so it applies to every route (including
  // /health, which we then exempt with skipOnError + a config override).
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, {
    global: true,
    max: 200,
    timeWindow: '1 minute',
    // /health gets an unlimited bucket via its config override; other routes
    // inherit the global limit.
    keyGenerator: (req) => (req.ip ?? 'unknown'),
  });
  await registerJwt(app);

  // WebSocket plugin must register before any route that uses { websocket: true }.
  // The hub itself (src/ws/hub.ts) is plain-module pub/sub — no plugin needed.
  await app.register(fastifyWebsocket);

  // Decorator: routes use { preHandler: app.authenticate } to require auth.
  app.decorate('authenticate', authenticateFactory(app));

  // /health: liveness + schema info. No rate limit so probes don't get 429s.
  app.get(
    '/health',
    { config: { rateLimit: false } },
    async () => {
      let dbStatus: 'ok' | 'error' = 'ok';
      try {
        db.prepare('SELECT 1').get();
      } catch {
        dbStatus = 'error';
      }
      return {
        status: 'ok',
        ts: new Date().toISOString(),
        version: process.env.npm_package_version ?? '0.1.0',
        db: dbStatus,
        schemaLatest: migration.latest,
      };
    },
  );

  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(teamsRoutes, { prefix: '/teams' });
  await app.register(matchesRoutes, { prefix: '/matches' });
  // Sibling plugin under the same prefix — registers POST /:id/turns and
  // POST /:id/state, both authed. Kept separate from matchesRoutes so the
  // engine-driven endpoints don't crowd the CRUD file.
  await app.register(matchActionsRoutes, { prefix: '/matches' });
  // WebSocket live channel: GET /matches/:id/live. Sibling plugin so the
  // upgrade handler stays out of the REST file.
  await app.register(wsMatchRoutes, { prefix: '/matches' });

  return { app, migration };
}
