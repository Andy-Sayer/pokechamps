// PokeChamps server entry point. v1: a healthcheck endpoint so the Docker
// dev environment has something to boot. Phase 2.1 adds sqlite + migrations;
// 2.2 adds auth; 2.3 teams + matches routes; 2.5 WebSocket live updates.
import Fastify from 'fastify';

const log = (msg: string, extra?: object) => console.log(JSON.stringify({ msg, ...extra }));

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
});

app.get('/health', async () => ({
  status: 'ok',
  ts: new Date().toISOString(),
  version: process.env.npm_package_version ?? '0.1.0',
}));

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

app.listen({ port, host })
  .then(addr => log(`pokechamps server listening on ${addr}`))
  .catch(err => {
    app.log.error(err);
    process.exit(1);
  });
