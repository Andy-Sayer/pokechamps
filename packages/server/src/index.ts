// PokeChamps server entry point. Boots the Fastify app, listens on PORT,
// installs signal handlers for graceful shutdown. App wiring (DB, migrations,
// plugins, routes) lives in app.ts so tests can reuse it via app.inject().
import { buildApp } from './app.js';
import { closeDb } from './db/connection.js';

const log = (msg: string, extra?: object) =>
  console.log(JSON.stringify({ msg, ...extra }));

const { app } = await buildApp();

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
