-- Match share tokens. A capability token (long random secret) that grants
-- read-only, live spectator access to one match — "anyone with the link can
-- watch". Unlike WS tickets (in-memory, single-use, 30s) these are persistent
-- and multi-use, so they live here. Revoked by DELETE; auto-revoked when the
-- match or owner is deleted (ON DELETE CASCADE).
--
-- The token is accepted ONLY on the spectator snapshot GET and the live WS
-- (?share=). It is never a Bearer credential, so a spectator cannot mutate.

CREATE TABLE match_shares (
  token       TEXT PRIMARY KEY,
  match_id    TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  owner_id    TEXT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  created_at  TEXT NOT NULL
);

-- Lookups go token→match (PK covers that) and match→token (owner endpoints +
-- "does this match already have a share" create-or-return).
CREATE INDEX match_shares_match_idx ON match_shares(match_id);

INSERT INTO app_meta(key, value) VALUES ('schema_version', '006_match_shares')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
