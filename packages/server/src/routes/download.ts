// TUI download endpoint. A friend with nothing but Node installed can grab the
// bundled client straight from the server they'll connect to:
//
//   curl -fL https://host/download/tui.tar.gz        -o tui.tar.gz
//   curl -fL https://host/download/tui.tar.gz.sha256 -o tui.tar.gz.sha256
//   sha256sum -c tui.tar.gz.sha256      # verify integrity
//   tar xzf tui.tar.gz && node tui/tui.mjs
//
// Unauthenticated on purpose — you need the client before you have an account.
// The artifact is the output of `npm run bundle:tui` (scripts/bundle-tui.mjs):
// tui.mjs + the data/ dir, tarred, plus a sibling .sha256. We resolve it from
// POKECHAMPS_TUI_BUNDLE if set, else dist/pokechamps-tui.tar.gz at the repo
// root. A 404 (with a hint) is returned if the bundle wasn't built/shipped.
//
// Both routes get a tighter rate-limit bucket than the global one: downloads
// are rare, so 30/min/IP caps abuse of these unauthenticated endpoints.
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function bundlePath(): string {
  if (process.env.POKECHAMPS_TUI_BUNDLE) return process.env.POKECHAMPS_TUI_BUNDLE;
  // packages/server/src/routes → repo root is four levels up.
  const repoRoot = join(__dirname, '..', '..', '..', '..');
  return join(repoRoot, 'dist', 'pokechamps-tui.tar.gz');
}

const NOT_BUILT = {
  error: 'tui_bundle_not_built',
  message:
    'TUI bundle not found on the server. Build it with `npm run bundle:tui` and ship dist/pokechamps-tui.tar.gz, or set POKECHAMPS_TUI_BUNDLE.',
};

// Tighter bucket than the global 200/min — these are unauthenticated.
const downloadRateLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

const downloadRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/tui.tar.gz', downloadRateLimit, async (_request, reply) => {
    const path = bundlePath();
    if (!existsSync(path)) return reply.code(404).send(NOT_BUILT);
    const { size } = statSync(path);
    reply
      .header('content-type', 'application/gzip')
      .header('content-length', size)
      .header('content-disposition', 'attachment; filename="pokechamps-tui.tar.gz"');
    return reply.send(createReadStream(path));
  });

  // SHA-256 checksum (sha256sum format) for integrity verification.
  app.get('/tui.tar.gz.sha256', downloadRateLimit, async (_request, reply) => {
    const path = `${bundlePath()}.sha256`;
    if (!existsSync(path)) return reply.code(404).send(NOT_BUILT);
    reply
      .header('content-type', 'text/plain; charset=utf-8')
      .header('content-disposition', 'attachment; filename="pokechamps-tui.tar.gz.sha256"');
    return reply.send(createReadStream(path));
  });
};

export default downloadRoutes;
