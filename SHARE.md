# Spectate / run PokeChamps (for a friend)

Someone shared their PokeChamps server with you. This is how to install the
client and (optionally) watch their match live. You only need **Node.js 20+**
installed — nothing else.

Replace `<HOST>` below with the server URL they gave you
(e.g. `https://pokechamps.duckdns.org`).

## Is this safe to run?

Fair question — you're about to run a program off the internet. Here's exactly
what you're trusting, so you can decide:

1. **It's open source.** The entire client is in the public repo
   (`github.com/Andy-Sayer/pokechamps`). You can read precisely what it does —
   it's a Pokémon battle assistant: damage maths, an opponent-stat solver, and
   a terminal UI. It talks only to the one server you point it at.
2. **It arrives over HTTPS.** The download comes from the server over a
   Let's Encrypt TLS connection, so nobody can tamper with it in transit.
3. **You can verify integrity.** Every download has a published SHA-256
   checksum (steps below) — confirm the file you got is the file that was
   served, byte for byte.
4. **You can reproduce it.** The client is a single bundled file built from the
   public source with `npm run bundle:tui`. If you don't want to trust the
   prebuilt download at all, clone the repo and build your own (last section) —
   it's the same program.

What the client can do on your machine: read/write a tiny config file at
`~/.pokechamps/config.json` (your server URL + login token) and make network
requests to `<HOST>`. That's it — no installer, no background service, no
elevated permissions.

## Install (recommended: with verification)

**macOS / Linux:**
```sh
# 1. Download the bundle + its checksum
curl -fL <HOST>/download/tui.tar.gz        -o pokechamps-tui.tar.gz
curl -fL <HOST>/download/tui.tar.gz.sha256 -o pokechamps-tui.tar.gz.sha256

# 2. Verify integrity — must print "pokechamps-tui.tar.gz: OK"
shasum -a 256 -c pokechamps-tui.tar.gz.sha256   # or: sha256sum -c …

# 3. Unpack + run
tar xzf pokechamps-tui.tar.gz
node tui/tui.mjs
```

**Windows (PowerShell):**
```powershell
# 1. Download both
curl.exe -fL <HOST>/download/tui.tar.gz        -o pokechamps-tui.tar.gz
curl.exe -fL <HOST>/download/tui.tar.gz.sha256 -o pokechamps-tui.tar.gz.sha256

# 2. Verify — compare the two hashes; they must match
(Get-FileHash pokechamps-tui.tar.gz -Algorithm SHA256).Hash.ToLower()
Get-Content pokechamps-tui.tar.gz.sha256      # first field is the expected hash

# 3. Unpack (tar ships with Windows 10+) + run
tar xzf pokechamps-tui.tar.gz
node tui/tui.mjs
```

## First run

In the TUI:

1. **Server settings** → set the server URL to `<HOST>`.
2. **Register** an account (email + password — local to this server only).
3. To **watch a live match**: the host sends you a link like
   `<HOST>/spectate/<token>`. Choose **"Spectate a shared match"** from the
   main menu and paste it. You'll see their board, inference, and damage grid
   update live, read-only. Press Esc to leave.

## Build it yourself instead (maximum paranoia)

If you'd rather not run the prebuilt download, build the identical client from
source:

```sh
git clone https://github.com/Andy-Sayer/pokechamps.git
cd pokechamps
npm install
npm run bundle:tui          # produces dist/pokechamps-tui.tar.gz (+ .sha256)
node dist/tui/tui.mjs
```

The `dist/...sha256` you produce should match what `<HOST>/download/tui.tar.gz.sha256`
serves for the same source revision — that's the reproducibility check.

## Troubleshooting

- **`node: command not found`** → install Node.js 20+ from https://nodejs.org.
- **Checksum mismatch** → re-download (a truncated/corrupt transfer); if it
  persists, tell the host — don't run the file.
- **`curl: (60) SSL certificate problem`** → the server's TLS cert isn't ready;
  tell the host to check their Caddy logs.
- **Can't connect / register fails** → confirm the `<HOST>` URL is exact
  (`https://`, no trailing slash) and the host's server is running.
