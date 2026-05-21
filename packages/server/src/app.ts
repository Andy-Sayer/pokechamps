// App factory. Constructing the Fastify instance separately from listening on
// a port lets tests use `app.inject()` against the same wiring the real server
// uses. index.ts handles process-level concerns (listen, signals, exit codes).
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import { getDb } from './db/connection.js';
import { migrate } from './db/migrations.js';
import { registerJwt } from './auth/jwt.js';
import { authenticateFactory } from './auth/authenticate.js';
import authRoutes from './auth/routes.js';
import teamsRoutes from './routes/teams.js';
import matchesRoutes from './routes/matches.js';
import matchActionsRoutes from './routes/match-actions.js';
import wsMatchRoutes from './routes/ws-match.js';
import pikalyticsRoutes from './routes/pikalytics.js';

export interface BuildAppOptions {
  /** Override the default logger (set false to silence in tests). */
  logger?: boolean | { level?: string };
}

export interface BuiltApp {
  app: FastifyInstance;
  migration: { applied: string[]; latest: string | null };
}

// Origins that may call the API cross-origin. Comma-separated env var; required
// in production so we don't accidentally ship a wildcard. Dev defaults to the
// Vite dev port so the web client works out-of-the-box.
function resolveCorsOrigins(): string[] {
  const raw = process.env.POKECHAMPS_WEB_ORIGIN;
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('POKECHAMPS_WEB_ORIGIN is required in production');
    }
    return ['http://localhost:5173'];
  }
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<BuiltApp> {
  const corsOrigins = resolveCorsOrigins();
  const app = Fastify({
    // Fly's edge proxy stamps X-Forwarded-For; without trustProxy, request.ip
    // is Fly's edge IP and every user shares one rate-limit bucket. With it,
    // request.ip reflects the real client and an attacker can't spoof XFF
    // because Fly strips client-supplied XFF before adding its own.
    // Fly's edge proxy stamps X-Forwarded-For; without trustProxy, request.ip
    // is Fly's edge IP and every user shares one rate-limit bucket. We can't
    // turn this on unconditionally — light-my-request's synthesized WS upgrade
    // requests don't include XFF, which Fastify's trustProxy code path rejects
    // with a 500. Enable only when TRUST_PROXY=1 (set in fly.toml).
    trustProxy: process.env.TRUST_PROXY === '1',
    logger: opts.logger ?? {
      level: process.env.LOG_LEVEL ?? 'info',
      // pino redact path patterns — masks the field value in any log record
      // pino emits. Login bodies and Authorization headers must never appear
      // in disk or remote-log shipping.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.token',
        ],
        censor: '[REDACTED]',
      },
    },
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

  // Plugins. Order matters: cors + helmet FIRST so even preflight + error
  // responses pick up the right headers; cookie before jwt (jwt can read
  // tokens from cookies); rate-limit early so it applies to every route
  // (including /health, which we then exempt with skipOnError + a config
  // override).
  await app.register(fastifyCors, {
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization'],
    credentials: true,
  });
  await app.register(fastifyHelmet, {
    // CSP is strict — API only serves JSON, no HTML to script.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: {
      maxAge: 60 * 60 * 24 * 365, // 1 year
      includeSubDomains: true,
      preload: true,
    },
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
    // crossOriginResourcePolicy default 'same-origin' would block the web
    // client; cors handles the actual origin allowlist, so relax this.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // global:false → opt-in per route via { helmet: true }. We add the hook
    // ourselves below for HTTP routes only; the WS upgrade path can't accept
    // helmet's onSend headers because @fastify/websocket hijacks the 101
    // response before onSend fires.
    global: false,
  });

  // Apply helmet to every non-WS request via a global hook. The /matches/*/live
  // upgrade is the one route we skip; everything else (REST + /health + auth)
  // gets the headers. We use a hook (not per-route opt-in) because the route
  // count is large enough that opt-in is easy to forget.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.endsWith('/live') || /\/live\?/.test(req.url)) return;
    // helmet decorates reply with this when global:false; the type is loose.
    await (reply as unknown as { helmet: () => Promise<void> }).helmet();
  });
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
  await app.register(pikalyticsRoutes, { prefix: '/pikalytics' });

  return { app, migration };
}
