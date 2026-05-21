# Deploy: PokeChamps Server → Fly.io

Phase 5 runbook. Single small machine + one persistent sqlite volume. For the
long-term blue/green plan see `~/.claude/plans/blue-green-deploy.md`.

## Prereqs

- `flyctl` installed (`brew install flyctl` / `iwr https://fly.io/install.ps1 -useb | iex`)
- A Fly account with billing attached

## First-time setup

```sh
# 1. Auth
flyctl auth login

# 2. Claim an app name. --no-deploy stops Fly from running a deploy with no
#    secrets or volume in place yet. Accept the rewrite to fly.toml's `app`.
#    When prompted "Would you like to copy its configuration to the new app?"
#    answer Yes — that preserves the build/env/mounts blocks.
flyctl launch --no-deploy --copy-config

# 3. Pick a region and uncomment `primary_region` in fly.toml. List with:
flyctl platform regions

# 4. Create the persistent volume in the same region. 10GB is overkill but
#    cheap — Fly's smallest is 1GB.
flyctl volumes create pokechamps_data --size 10 --region <region>

# 5. Set required secrets. JWT_SECRET MUST be set or the server refuses to
#    boot (auth/jwt.ts:resolveJwtSecret).
flyctl secrets set JWT_SECRET=$(openssl rand -hex 32)

# 6. (Optional) AI features
flyctl secrets set ANTHROPIC_API_KEY=sk-ant-...
```

## Deploy

```sh
flyctl deploy
```

The build uses `Dockerfile.prod` (multi-stage: typecheck → slim runtime).
First build takes ~3–4 min; cached rebuilds are under a minute.

## Operate

```sh
flyctl status            # machines + health
flyctl logs              # tail logs
flyctl logs --no-tail    # dump recent + exit
flyctl ssh console       # shell into the running machine
flyctl ssh sftp shell    # browse /data over sftp if you need to pull the sqlite file
```

The sqlite database is at `/data/pokechamps.sqlite` on the mounted volume.
WAL files (`-wal`, `-shm`) sit alongside it; checkpointed cleanly on SIGTERM
via the graceful-shutdown handler in `packages/server/src/index.ts`.

## Rollback

```sh
flyctl releases                       # list past releases + their image refs
flyctl deploy --image <prev-image>    # redeploy a previous image
```

Volume data is preserved across rollbacks (the schema is forward-only via
`migrations.ts`, so rolling the code back to a version that doesn't know about
a newer column is generally safe — it just ignores the column).

## Update secrets

```sh
flyctl secrets set KEY=value          # triggers a rolling restart
flyctl secrets unset KEY
flyctl secrets list
```

## Cost sanity

- 1× `shared-cpu-1x` 512MB machine, mostly idle: ~$2/mo
- 10GB volume: ~$1.50/mo
- Auto-stop on idle is enabled (`auto_stop_machines = "stop"`); cold start
  adds ~1s to the first request after idle. Set `min_machines_running = 1`
  in fly.toml if you want zero cold starts.

## Long-term: blue/green

When single-instance downtime during deploys starts hurting, follow
`~/.claude/plans/blue-green-deploy.md`. The short version: split into two
Fly apps behind a third "router" app, swap traffic at the router level,
and add a litestream replica so the green env starts from a hot copy of
the blue env's sqlite.
