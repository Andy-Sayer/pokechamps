// App factory. Constructing the Fastify instance separately from listening on
// a port lets tests use `app.inject()` against the same wiring the real server
// uses. index.ts handles process-level concerns (listen, signals, exit codes).
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import { getDb } from './db/connection.js';
import { migrate } from './db/migrations.js';
import { registerJwt } from './auth/jwt.js';
import { authenticateFactory } from './auth/authenticate.js';
import authRoutes from './auth/routes.js';

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

  return { app, migration };
}
