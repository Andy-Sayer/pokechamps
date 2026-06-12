# Deploy: PokeChamps server + downloadable TUI

Goal: host the **server** on a small always-on box and let a friend download
and run the **TUI** client against it. Persistence is a single SQLite file on
the box's real disk — no managed database.

The stack is two containers (`docker-compose.prod.yml`):

- **server** — Fastify API + the `/download/tui.tar.gz` client bundle, built
  from `Dockerfile.prod`. SQLite lives on a Docker volume (`server_data`).
- **caddy** — TLS reverse proxy; auto-provisions a Let's Encrypt cert for your
  domain. WebSockets pass through transparently.

## Picking a host

Any box with a public IP, a real (non-ephemeral) disk, and Docker works. The
file-based persistence is the constraint: most free **PaaS** tiers (Render,
Koyeb, Fly's new free allowance) give an **ephemeral** filesystem that's wiped
on every deploy/restart, which would lose the SQLite file. So prefer a VM:

| Option | Cost | Notes |
|---|---|---|
| **Oracle Cloud Always Free** | $0 forever | 1 Arm VM (up to 4 vCPU / 24 GB) or 2 small AMD VMs, real block storage. The recommended path below. |
| Hetzner / Netcup / a $4–6 VPS | ~$5/mo | Simplest if you don't want Oracle's signup friction. |
| Fly.io + a paid volume | ~$3.50/mo | `fly.toml` is still in the repo if you go this way; see "Fly.io" at the bottom. |

Everything below targets a generic Ubuntu VM, so it applies to Oracle, a VPS,
or anything in between.

## 1. Provision the VM (Oracle Always Free)

1. Create an Oracle Cloud account, then **Compute → Instances → Create**.
2. Shape: **VM.Standard.A1.Flex** (Arm, Always Free eligible) — 1–2 OCPU /
   6–12 GB RAM is plenty. Image: **Canonical Ubuntu 22.04+**.
3. Add your SSH public key, create the instance, note the **public IP**.
4. **Networking → open the ports.** In the instance's VCN security list (or a
   Network Security Group), add ingress rules for TCP **80** and **443** from
   `0.0.0.0/0`. Oracle also firewalls at the OS level — open it there too:
   ```sh
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80  -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```

## 2. Point your domain at it

Caddy needs a real hostname to get a TLS cert. Add a DNS **A record** for e.g.
`pokechamps.example.com` → the VM's public IP. A free subdomain from
DuckDNS/Afraid works if you don't own a domain. Wait for it to resolve
(`ping pokechamps.example.com`) before step 4 or cert issuance will fail.

## 3. Install Docker + clone

```sh
# On the VM:
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out/in so docker works without sudo
git clone <your-repo-url> pokechamps && cd pokechamps
```

## 4. Configure + launch

Create a `.env` next to `docker-compose.prod.yml`:

```sh
cat > .env <<EOF
DOMAIN=pokechamps.example.com
JWT_SECRET=$(openssl rand -hex 32)
# Spectator share links (/share command) are built from this. Set it to your
# real https origin so the links you hand out point at the right place.
POKECHAMPS_PUBLIC_URL=https://pokechamps.example.com
# Registration gate: with this set, new accounts need this invite code (you
# give it to your friend once). Unset = anyone with the URL can register.
REGISTRATION_SECRET=$(openssl rand -hex 16)
# Optional — enables AI review/explain:
# ANTHROPIC_API_KEY=sk-ant-...
EOF
# Note your invite code so you can give it to your friend:
grep REGISTRATION_SECRET .env
```

Build and start:

```sh
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f   # watch cert issuance + boot
```

First build is ~3–5 min (it also bundles the TUI). Caddy fetches the cert on
first request to the domain. Verify:

```sh
curl https://pokechamps.example.com/health     # {"status":"ok",...}
```

## Environment variables (reference)

Set these in the `.env` next to `docker-compose.prod.yml` (the compose file
reads them and passes them to the container). After changing any, re-run
`docker compose -f docker-compose.prod.yml up -d --build`.

| Variable | Required | What it does |
|---|---|---|
| `DOMAIN` | **yes** | Your hostname (e.g. `pokechamps.duckdns.org`). Caddy gets the TLS cert for it; also the default for the two URLs below. |
| `JWT_SECRET` | **yes** | Signing key for login tokens. `openssl rand -hex 32`. The server refuses to boot in prod without it. Rotating it logs everyone out. |
| `POKECHAMPS_PUBLIC_URL` | recommended | Public origin used to build spectator **share links** (the `/share` command). Set to your real `https://<DOMAIN>` so links point at the right place. Defaults to `https://${DOMAIN}`. |
| `REGISTRATION_SECRET` | recommended | **Invite code.** When set, new accounts must supply it to register — you give it to your friend once. `openssl rand -hex 16`. Unset = anyone with the URL can register. (`grep REGISTRATION_SECRET .env` to read it back.) |
| `POKECHAMPS_WEB_ORIGIN` | auto | CORS allowlist for the optional web viewer. Compose defaults it to `https://${DOMAIN}`; the TUI isn't a browser origin so this rarely matters. |
| `TRUST_PROXY` | auto | Set to `1` (compose does this) so rate-limit buckets key off the real client IP behind Caddy, not the proxy's. |
| `DATABASE_URL` | auto | SQLite file path. Compose sets `file:/data/pokechamps.sqlite` on the persistent volume — don't change it unless you know why. |
| `ANTHROPIC_API_KEY` | optional | Enables the opt-in AI review/explain hooks. Leave unset to keep all AI features off (the default). |

## 5. Your friend installs the TUI

They need **Node 20+** and nothing else — no repo, no npm install. Hand them
[`SHARE.md`](SHARE.md), which has the full friend-facing guide (with the
"is this safe?" rationale, checksum verification, and a build-it-yourself
option). The short version:

```sh
curl -fL https://pokechamps.example.com/download/tui.tar.gz        -o pokechamps-tui.tar.gz
curl -fL https://pokechamps.example.com/download/tui.tar.gz.sha256 -o pokechamps-tui.tar.gz.sha256
shasum -a 256 -c pokechamps-tui.tar.gz.sha256    # verify → "...: OK"
tar xzf pokechamps-tui.tar.gz
node tui/tui.mjs
```

In the TUI: **Server Settings** → set the server URL to
`https://pokechamps.example.com`, then register/log in. The bundle ships its
own copy of the game data, so damage/format lookups work entirely client-side;
the server is just shared storage for teams + match state. To watch a live
match, the host runs `/share` in-battle and sends the link; the friend picks
**"Spectate a shared match"** and pastes it.

> The bundle is produced by `npm run bundle:tui` (esbuild → a single `tui.mjs`
> plus a `data/` dir, tarred) and baked into the server image at build time, so
> `/download/tui.tar.gz` always matches the deployed server.

## Operate

```sh
docker compose -f docker-compose.prod.yml ps         # container health
docker compose -f docker-compose.prod.yml logs -f server
docker compose -f docker-compose.prod.yml restart server
docker compose -f docker-compose.prod.yml pull && \
  docker compose -f docker-compose.prod.yml up -d --build   # deploy new code
```

### Backups

The whole datastore is one SQLite file on the `server_data` volume. To grab a
consistent copy (WAL-safe):

```sh
docker compose -f docker-compose.prod.yml exec server \
  sh -c 'cd /data && tar czf - pokechamps.sqlite*' > backup-$(date +%F).tar.gz
```

Restore by stopping the server, extracting back into the volume, and starting.

## Validated locally (2026-06-11)

The full stack has been run end-to-end with this exact compose file
(`DOMAIN=localhost`, Caddy's internal CA standing in for Let's Encrypt):
multi-stage image build (incl. the alpine tar bundle step), Caddy TLS →
server proxying, `/health` + migrations, register/login/`/auth/me`, team CRUD,
and the TUI bundle download — checksum verified against the served `.sha256`,
extracted, booted. One real bug surfaced and is fixed in `Dockerfile.prod`:

- **Root-owned `server_data` volume → `SQLITE_CANTOPEN` crash-loop.** A named
  volume only inherits the image's `/data` ownership when the volume is first
  created; a volume that predates the image (or was made by root tooling)
  mounts root-owned and the non-root server can't open the database. The image
  now fixes ownership in a root entrypoint and drops to `node` via `su-exec`,
  so any pre-existing volume works.

Still genuinely VM-specific on first real deploy: the arm64 build of
`better-sqlite3` on Oracle's A1 shape, real-DNS Let's Encrypt issuance, and
the host firewall (open 80/443).

## Fly.io (alternative)

`fly.toml` + `Dockerfile.prod` still work on Fly if you prefer it. The short
version: `flyctl launch --no-deploy --copy-config`, create a paid volume
(`flyctl volumes create pokechamps_data --size 1`), set
`flyctl secrets set JWT_SECRET=$(openssl rand -hex 32)`, then `flyctl deploy`.
Fly's edge already terminates TLS, so you skip Caddy. Note Fly's free allowance
no longer includes a persistent volume, hence the ~$3.50/mo.
