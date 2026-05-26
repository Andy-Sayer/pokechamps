// Match share-token persistence. A share token is a long random secret that
// maps to (owner_id, match_id) and grants read-only live spectator access to
// that one match. See docs/notes/live-share-plan.md.
//
// Unlike ws/tickets.ts (in-memory, single-use, 30s) these are persistent and
// multi-use, so they're a SQLite table (migration 006_match_shares.sql).
//
// Callers must do their own ownership check (loadMatch) before createShare /
// revokeShare; resolveShare is the unauthenticated spectator path and returns
// the owner+match the token unlocks.
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

export interface ShareRow {
  token: string;
  matchId: string;
  ownerId: string;
  createdAt: string;
}

// Create-or-return: one active token per match. If the match already has a
// share we hand the same token back so repeated POSTs are idempotent (the
// owner can rotate by DELETE-then-POST). Returns the token.
export function createShare(
  db: Database.Database,
  ownerId: string,
  matchId: string,
): string {
  const existing = db
    .prepare<[string, string], { token: string }>(
      'SELECT token FROM match_shares WHERE match_id = ? AND owner_id = ?',
    )
    .get(matchId, ownerId);
  if (existing) return existing.token;

  const token = randomBytes(32).toString('base64url');
  db.prepare(
    'INSERT INTO match_shares (token, match_id, owner_id, created_at) VALUES (?, ?, ?, ?)',
  ).run(token, matchId, ownerId, new Date().toISOString());
  return token;
}

// The token currently sharing this match, or null. Used by GET /share.
export function getShareForMatch(
  db: Database.Database,
  ownerId: string,
  matchId: string,
): string | null {
  const row = db
    .prepare<[string, string], { token: string }>(
      'SELECT token FROM match_shares WHERE match_id = ? AND owner_id = ?',
    )
    .get(matchId, ownerId);
  return row?.token ?? null;
}

// Resolve a token to the (owner, match) it unlocks. Null on unknown/revoked.
// This is the unauthenticated spectator entry point — it deliberately does NOT
// take a userId, because spectators have no account.
export function resolveShare(
  db: Database.Database,
  token: string,
): { ownerId: string; matchId: string } | null {
  if (!token) return null;
  const row = db
    .prepare<[string], { match_id: string; owner_id: string }>(
      'SELECT match_id, owner_id FROM match_shares WHERE token = ?',
    )
    .get(token);
  if (!row) return null;
  return { ownerId: row.owner_id, matchId: row.match_id };
}

// Revoke any share for this match. Returns rows deleted (0 = none existed).
export function revokeShare(
  db: Database.Database,
  ownerId: string,
  matchId: string,
): number {
  return db
    .prepare('DELETE FROM match_shares WHERE match_id = ? AND owner_id = ?')
    .run(matchId, ownerId).changes;
}
