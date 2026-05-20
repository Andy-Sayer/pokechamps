# PokeChamps server dev image. Single-stage on purpose for v1 — keeps the
# Docker-learning surface small. Phase 5 (production deploy) will split this
# into a build stage + a slim runtime stage.
FROM node:22-alpine

WORKDIR /app

# Install root + workspace deps in a separate layer so code changes don't
# re-trigger the full install. We copy ONLY the manifest files first; the
# real source comes in below.
COPY package.json package-lock.json ./
COPY packages/core/package.json    ./packages/core/package.json
COPY packages/tui/package.json     ./packages/tui/package.json
COPY packages/server/package.json  ./packages/server/package.json

# `npm install` with workspaces hoists deps into /app/node_modules.
RUN npm install

# Now the rest of the code (changes here invalidate only this layer + below).
COPY . .

EXPOSE 3000

# tsx --watch gives hot reload when the source dir is bind-mounted by
# docker-compose. Without the mount this still works — it just won't see
# host edits.
CMD ["npm", "-w", "@pokechamps/server", "run", "dev"]
