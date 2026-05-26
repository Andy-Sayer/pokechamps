# Live shared spectator view — implementation plan

**Goal:** let the host share a live, read-only view of an in-progress match
with a friend. The friend watches the host's match state update turn-by-turn,
without being able to change anything.

**Raised** 2026-05-25; planned + backend built 2026-05-26 on branch
`feature/live-share`.

## TL;DR

The server already does 90% of this. The match WebSocket hub
(`ws/hub.ts`) **already** broadcasts every mutation to all subscribers of a
match id, and the `/matches/:id/live` socket **already** rejects inbound
mutations (read-only by design). The only thing blocking a spectator is that
every access path is **owner-scoped** (`loadMatch(db, user.sub, matchId)`).

So the feature reduces to: **a shareable, revocable, read-only capability
token for a match** — "anyone with the link can watch." No new realtime
plumbing, no account required for the spectator.

## What exists today (grounding)

| Piece | File | Relevance |
|---|---|---|
| WS pub/sub hub | `ws/hub.ts` | `broadcastMatch(id, match, source)` fans out to every subscriber of `id`. Spectators just join the same set — **no change needed.** |
| Live socket | `routes/ws-match.ts` | Sends `{type:'snapshot'}` on connect, then `{type:'update'}` per mutation. Drops inbound messages. Closes 4401/4404. |
| WS auth | `auth/wsAuth.ts` | Resolves a user from Bearer / `?ticket=` / `?token=`. **Extension point** for `?share=`. |
| Tickets | `ws/tickets.ts` | In-memory, single-use, 30s, scoped to (user, match). Pattern to mirror for shares — but shares are **persistent + multi-use**, so they live in SQLite, not memory. |
| Mutations | `routes/match-actions.ts`, `routes/matches.ts` | All call `broadcastMatch` after a successful, owner-scoped write. Spectators receive these for free. |
| Web viewer | `web/src/lib/liveMatch.ts`, `web/src/BattleView.tsx` | Already renders a `Match` read-only and subscribes with reconnect/backoff. **The natural spectator client.** |
| Web auth | `web/src/lib/api.ts` | Today requires login (JWT in localStorage). Spectator path must bypass this. |

## Design

### Capability model: match share tokens

A **share token** is a long random secret (32 bytes base64url, like a ticket)
that maps to `(owner_id, match_id)`. Knowing the token = permission to watch
that one match, read-only. This is the "secret link" / capability-URL model
(à la Google Docs "anyone with the link can view"):

- **Persistent + multi-use** (unlike tickets) → stored in SQLite so it survives
  restarts and the friend can reuse/refresh the link. New migration
  `006_match_shares.sql`.
- **Revocable** → owner can `DELETE` it; spectators then get 404 / socket close.
- **Match-scoped** → a token only ever unlocks its one match.
- **Read-only** → the token is accepted ONLY on the spectator snapshot GET and
  the live WS (`?share=`). It is **never** a Bearer credential and the mutation
  routes (`/turns`, `/state`, PATCH) only accept a real JWT/PAT, so a spectator
  physically cannot write.

### Schema (`006_match_shares.sql`)

```sql
CREATE TABLE match_shares (
  token       TEXT PRIMARY KEY,
  match_id    TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  owner_id    TEXT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  created_at  TEXT NOT NULL
);
CREATE INDEX match_shares_match_idx ON match_shares(match_id);
```

`ON DELETE CASCADE` from `matches` means deleting a match auto-revokes its
share. One active token per match (the owner endpoint is create-or-return).

### Endpoints

**Owner (authed, ownership-scoped via `loadMatch`):**
- `POST   /matches/:id/share` → create-or-return the token; responds
  `{ token, url }` where `url` is the spectator link.
- `GET    /matches/:id/share` → `{ token, url } | { token: null }`.
- `DELETE /matches/:id/share` → revoke; 204.

**Spectator (UNAUTHENTICATED, share-scoped):**
- `GET /spectate/:token` → the match snapshot JSON (read-only). Resolves the
  token → `(owner_id, match_id)` → `loadMatch(owner_id, match_id)`. 404 on
  bad/revoked token.
- `GET /matches/:id/live?share=<token>` → live WS. `verifyTokenForLive` gains a
  `share` branch: resolve token, return `{ user:{sub:owner_id}, ticketMatchId:
  match_id }`. The existing scope check (`ticketMatchId === matchId`) prevents
  using a token on the wrong match's URL. The route then `loadMatch(owner_id,…)`
  succeeds and the spectator joins the broadcast set.

> Why authing the spectator *as the owner's id* internally is safe: it's only
> used to read that one match via the share's own `match_id`, and the socket
> can't mutate. The owner identity never leaves the server.

### Security analysis

| Risk | Mitigation |
|---|---|
| Token leaks (it's in a URL) | It's a capability we're *handing out* on purpose. Read-only, single-match, revocable. Worst case: someone watches one match. No write, no other matches, no account access. |
| Spectator tries to mutate | Mutation routes require Bearer JWT/PAT; share token is not accepted there. WS ignores inbound frames. Defence in depth. |
| Token reused on another match | Scope check `ticketMatchId === matchId`, and `/spectate/:token` derives the match_id from the token itself. |
| Unauthed endpoint abuse / scraping | Stays under the global rate-limit (200/min/IP). Consider a tighter bucket on `/spectate/*`. Tokens are 256-bit random — unguessable. |
| Privacy: spectator sees the host's full team (EVs/items) | **Deliberate** — the friend is watching *your* viewpoint, which is the point. Documented. A future "redacted spectator view" (hide my spreads, show only board state) is a clean follow-on if wanted. |
| Stale sockets after revoke | v1: revoked token stops *new* connects + snapshot GETs; existing sockets linger until they drop. v1.1: on `DELETE`, close live sockets for that match that authed via share. |

### Client surfaces

**1. Web spectator (primary, lowest-friction — build after UI review)**
A friend opens a URL in any browser, no install, no account:
```
https://<host>/spectate.html?t=<token>      (or  /#/spectate/<token>)
```
The web app detects the share token, *skips login*, fetches the snapshot via
`GET /spectate/:token`, and subscribes to the live WS with `?share=<token>`
(a share-flavoured `subscribeLiveMatch` that skips the ticket mint). Renders
through the existing read-only `BattleView`. Small additions to `api.ts`
(`getSpectateSnapshot`, share-mode base URL) + a `subscribeLiveMatch` share
variant.

Proposed spectator screen (mock — for review before building):
```
┌─ PokeChamps · spectating ───────────────── ● live ──┐
│  Andy's match vs. <opp>            turn 7           │
│                                                     │
│   MINE                         THEIRS               │
│   Sneasler   78%  [par]        Incineroar  100%     │
│   Rillaboom  100%              Amoonguss    42%     │
│                                                     │
│   Field: Grassy Terrain (3) · Trick Room (2)        │
│                                                     │
│   Last turn: Sneasler → Close Combat → Incin (61%)  │
│                                                     │
│   read-only · you are watching Andy's view          │
└─────────────────────────────────────────────────────┘
```
*(Reuses BattleView's existing roster/field rendering; the only new chrome is
the "spectating / live / read-only" banner.)*

**2. TUI host `/share` command (build after backend approved)**
In a remote-mode battle, `/share` (`/sh`) → `POST /matches/:id/share` → prints
the spectator URL to hand to the friend; `/share off` revokes. Needs the
httpStore/`api` to expose `createShare/revokeShare` and the BattleScreen to know
its serverUrl + matchId. Text-only output, but touches `BattleScreen.tsx`
(dual-finalize file) — small, additive.

**3. TUI spectator (deferred)** — the web viewer is the natural spectator; a
curses spectator is possible later but not worth it for v1.

### Prerequisite: the host must be in remote mode

Live sharing requires the match to live on the server so mutations broadcast.
That means the host plays logged-in to the server (httpStore), and each
turn/state hits `/matches/:id/turns|state` (→ broadcast). **Verify during TUI
work:** confirm remote-mode BattleScreen writes each turn to the server
(vs. finalizing locally and only PATCHing on save). If it batches, add a
per-turn POST in remote mode so spectators see live updates, not just-on-save.

## Phasing

- **Phase A — backend (BUILT 2026-05-26, branch `feature/live-share`):**
  migration + share store + owner endpoints + spectator snapshot + WS `?share=`
  + full server test coverage. Headless, security-sensitive, fully testable —
  done autonomously.
- **Phase B — web spectator UI:** after the mockup above is approved. Small
  `api.ts` + `liveMatch.ts` additions + a spectator entry that skips login +
  the banner chrome.
- **Phase C — TUI `/share` command:** host-side link generation. Confirm
  remote-mode per-turn writes first.
- **Phase D (optional) — redacted spectator view; close-on-revoke; tighter
  rate-limit bucket on `/spectate/*`.**

## Open choices deferred (sensible defaults taken)

- **No spectator accounts** (capability link) — chosen for zero friction.
- **One token per match** (create-or-return) — simpler than N named links;
  revoke-and-recreate rotates it.
- **Full-viewpoint share** (not redacted) — matches the "watch my view" intent.

All three are reversible; revisit if the spectating experience calls for it.
