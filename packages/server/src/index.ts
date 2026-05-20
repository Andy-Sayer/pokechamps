// PokeChamps server entry point. v1: a healthcheck endpoint so the Docker
// dev environment has something to boot. Phase 2.1 adds sqlite + migrations;
// 2.2 adds auth; 2.3 teams + matches routes; 2.5 WebSocket live updates.
import Fastify from 'fastify';
import { getDb, closeDb } from './db/connection.js';
import { migrate } from './db/migrations.js';

const log = (msg: string, extra?: object) => console.log(JSON.stringify({ msg, ...extra }));

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
});

// Open the DB + run pending migrations before we start listening. If either
// throws the process exits — we'd rather fail fast than serve traffic against
// a half-migrated schema.
const db = getDb();
const migrationResult = migrate(db);
app.log.info(
  { applied: migrationResult.applied, latest: migrationResult.latest },
  migrationResult.applied.length > 0
    ? `migrations applied: ${migrationResult.applied.join(', ')}`
    : 'no new migrations',
);

app.get('/health', async () => {
  let dbStatus: 'ok' | 'error' = 'ok';
  try {
    // Cheap liveness probe — round-trips the connection without touching data.
    db.prepare('SELECT 1').get();
  } catch {
    dbStatus = 'error';
  }
  return {
    status: 'ok',
    ts: new Date().toISOString(),
    version: process.env.npm_package_version ?? '0.1.0',
    db: dbStatus,
    schemaLatest: migrationResult.latest,
  };
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

// Graceful shutdown: drain in-flight requests then close the DB so WAL is
// checkpointed cleanly. Without this, sqlite may leave a -shm/-wal pair behind.
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`received ${signal}, shutting down`);
  try {
    await app.close();
  } finally {
    closeDb();
  }
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

app.listen({ port, host })
  .then(addr => log(`pokechamps server listening on ${addr}`))
  .catch(err => {
    app.log.error(err);
    process.exit(1);
  });
