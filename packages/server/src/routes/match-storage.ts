// Shared persistence helpers for match rows. Both routes/matches.ts (CRUD)
// and routes/match-actions.ts (turn/state submission) reuse these so the
// row format stays consistent across endpoints.
import type Database from 'better-sqlite3';
import type { Match } from '@pokechamps/core';

export const MATCH_BODY_LIMIT = 256 * 1024;

export interface MatchRow {
  id: string;
  started_at: string;
  outcome: string | null;
  match_json: string;
}

// Extract startedAt + outcome from the incoming match for the column writes.
// Falls back to now() / null so a malformed-but-parsable match still saves.
export function denormalize(
  match: Record<string, unknown>,
): { startedAt: string; outcome: string | null } {
  const startedAt = typeof match.startedAt === 'string'
    ? match.startedAt
    : new Date().toISOString();
  const outcome = match.outcome === 'victory' || match.outcome === 'defeat' || match.outcome === 'tie'
    ? match.outcome
    : null;
  return { startedAt, outcome };
}

// Load a match's full JSON blob by (id, user_id). Returns null if not found
// (used by both the CRUD GET and the action-submit POSTs).
export function loadMatch(
  db: Database.Database,
  userId: string,
  matchId: string,
): Match | null {
  const row = db
    .prepare<[string, string], { match_json: string }>(
      'SELECT match_json FROM matches WHERE user_id = ? AND id = ?',
    )
    .get(userId, matchId);
  if (!row) return null;
  return JSON.parse(row.match_json) as Match;
}

// Persist an updated match. Returns the number of rows affected (0 = match
// disappeared between read + write, which the caller should treat as 404).
export function saveMatch(
  db: Database.Database,
  userId: string,
  match: Match,
): number {
  const { startedAt, outcome } = denormalize(match as unknown as Record<string, unknown>);
  const info = db
    .prepare(
      `UPDATE matches
       SET started_at = ?, outcome = ?, match_json = ?
       WHERE user_id = ? AND id = ?`,
    )
    .run(startedAt, outcome, JSON.stringify(match), userId, match.id);
  return info.changes;
}
